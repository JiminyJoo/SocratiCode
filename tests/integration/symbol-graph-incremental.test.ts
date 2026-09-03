// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectIdFromPath } from "../../src/config.js";
import {
  invalidateGraphCache,
  rebuildGraph,
} from "../../src/services/code-graph.js";
import { updateChangedFilesSymbolGraph } from "../../src/services/symbol-graph-incremental.js";
import {
  loadFilePayload,
  loadSymbolGraphMeta,
} from "../../src/services/symbol-graph-store.js";
import {
  createFixtureProject,
  type FixtureProject,
  isDockerAvailable,
} from "../helpers/fixtures.js";
import { waitForQdrant } from "../helpers/setup.js";

const dockerAvailable = isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  "symbol-graph-incremental",
  { timeout: 120_000 },
  () => {
    let fixture: FixtureProject;
    let projectId: string;

    beforeAll(async () => {
      await waitForQdrant();
      fixture = createFixtureProject("symbol-graph-incremental-test");
      projectId = projectIdFromPath(fixture.root);
      // Establish baseline meta + payloads from a real full rebuild.
      await rebuildGraph(fixture.root);
    }, 60_000);

    afterAll(() => {
      invalidateGraphCache(fixture.root);
      fixture.cleanup();
    });

    it("returns fullRebuildRequired=false when meta exists (no-op call)", async () => {
      const graph = await rebuildGraph(fixture.root);
      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [],
        [],
      );
      expect(result.fullRebuildRequired).toBe(false);
      expect(result.filesChanged).toBe(0);
      expect(result.filesRemoved).toBe(0);
    });

    it("returns fullRebuildRequired=true on a changed file and full rebuild persists new symbols", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/index.ts";

      // Mutate the file: add a new exported function.
      const abs = path.join(fixture.root, rel);
      const original = fs.readFileSync(abs, "utf-8");
      try {
        fs.writeFileSync(
          abs,
          `${original}\nexport function brandNewIncrementalSymbol(): number { return 42; }\n`,
          "utf-8",
        );

        const result = await updateChangedFilesSymbolGraph(
          projectId,
          fixture.root,
          graph,
          [rel],
          [],
        );
        expect(result.fullRebuildRequired).toBe(true);

        // Rebuild graph via caller fallback
        await rebuildGraph(fixture.root);

        // The new symbol should appear in the persisted payload.
        const payload = await loadFilePayload(projectId, rel);
        expect(payload).toBeTruthy();
        const names = payload?.symbols.map((s) => s.name) ?? [];
        expect(names).toContain("brandNewIncrementalSymbol");
      } finally {
        fs.writeFileSync(abs, original, "utf-8");
      }
    });

    it("returns fullRebuildRequired=true when a file is removed", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/utils/helpers.ts";
      // Confirm baseline.
      const before = await loadFilePayload(projectId, rel);
      expect(before).toBeTruthy();

      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [],
        [rel],
      );
      expect(result.fullRebuildRequired).toBe(true);
    });

    it("handles symbols whose names collide with Object.prototype keys (regression)", async () => {
      // Regression for the "existing.push is not a function" crash hit on
      // SocratiCode itself: symbols named `constructor` / `toString` /
      // `hasOwnProperty` previously short-circuited bracket lookup on a
      // plain `{}` shard to the prototype value (a function), then
      // `existing.push(...)` blew up.
      const rel = "src/proto-keys.ts";
      const filePath = path.join(fixture.root, rel);
      fs.writeFileSync(
        filePath,
        [
          "export class A {",
          "  constructor() {}",
          "  toString() { return \"a\"; }",
          "  hasOwnProperty() { return true; }",
          "}",
          "",
          "export function constructor() { return 1; }",
          "export function toString() { return \"x\"; }",
          "export function hasOwnProperty() { return false; }",
          "",
        ].join("\n"),
        "utf-8",
      );
      try {
        await rebuildGraph(fixture.root);
        const meta = await loadSymbolGraphMeta(projectId);
        expect(meta).not.toBeNull();
        const payload = await loadFilePayload(projectId, rel);
        expect(payload).not.toBeNull();
        const names = payload?.symbols.map((s) => s.name) ?? [];
        // All three prototype-collision names must be present.
        expect(names).toEqual(expect.arrayContaining(["constructor", "toString", "hasOwnProperty"]));

        fs.appendFileSync(filePath, "\nexport const PROTO_KEYS_REV = 2;\n", "utf-8");
        const graph = await rebuildGraph(fixture.root, { skipSymbolGraph: true });
        const result = await updateChangedFilesSymbolGraph(
          projectId,
          fixture.root,
          graph,
          [rel],
          [],
        );
        expect(result.fullRebuildRequired).toBe(true);
      } finally {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    });

    it("full rebuild persists a detected extensionless Python file; .txt-detected is excluded", async () => {
      const pyRel = "tools/gen";
      const txtRel = "tools/legacy";
      fs.mkdirSync(path.join(fixture.root, "tools"), { recursive: true });
      fs.writeFileSync(
        path.join(fixture.root, pyRel),
        "def make_manifest():\n    return 1\n\nclass Builder:\n    def run(self):\n        return make_manifest()\n",
        "utf-8",
      );
      fs.writeFileSync(path.join(fixture.root, txtRel), "#!/usr/bin/perl\nprint \"legacy\\n\";\n", "utf-8");
      try {
        await rebuildGraph(fixture.root);

        const pyPayload = await loadFilePayload(projectId, pyRel);
        expect(pyPayload).toBeTruthy();
        expect(pyPayload?.language).toBe("python");
        const names = pyPayload?.symbols.map((s) => s.name) ?? [];
        expect(names).toEqual(expect.arrayContaining(["make_manifest", "Builder"]));

        // .txt-detected file contributes no symbol payload (not in the graph).
        const txtPayload = await loadFilePayload(projectId, txtRel);
        expect(txtPayload).toBeNull();
      } finally {
        try {
          fs.rmSync(path.join(fixture.root, "tools"), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });
  },
);
