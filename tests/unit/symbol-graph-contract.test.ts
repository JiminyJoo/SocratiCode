// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory Qdrant point store mock
interface StoredPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}
const store = new Map<string, Map<string, StoredPoint>>();

vi.mock("../../src/services/qdrant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/qdrant.js")>();
  return {
    ...actual,
    getClient: () => ({
      getCollections: async () => ({
        collections: Array.from(store.keys()).map((name) => ({ name })),
      }),
      createCollection: async (name: string) => {
        if (!store.has(name)) store.set(name, new Map());
      },
      upsert: async (name: string, body: { points: StoredPoint[] }) => {
        const coll = store.get(name) ?? new Map<string, StoredPoint>();
        for (const p of body.points) coll.set(String(p.id), p);
        store.set(name, coll);
      },
      retrieve: async (name: string, opts: { ids: Array<string | number> }) => {
        const coll = store.get(name) ?? new Map<string, StoredPoint>();
        return opts.ids.map((id) => coll.get(String(id))).filter((p): p is StoredPoint => p !== undefined);
      },
      delete: async (name: string, opts: { points: Array<string | number> }) => {
        const coll = store.get(name);
        if (coll) for (const id of opts.points) coll.delete(String(id));
      },
    }),
    saveGraphData: async () => {},
    loadGraphData: async () => null,
    deleteGraphData: async () => {},
    describeQdrantError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  };
});

import { projectIdFromPath } from "../../src/config.js";
import { rebuildGraph } from "../../src/services/code-graph.js";
import { getImpactRadius, getSymbolContext } from "../../src/services/graph-impact.js";
import { getSymbolGraphCache, resetSymbolGraphCacheRegistry } from "../../src/services/symbol-graph-cache.js";
import {
  loadSymbolGraphMeta,
  resetSymbolGraphCollectionCache,
  StorageReadError,
  saveSymbolGraphMeta,
} from "../../src/services/symbol-graph-store.js";
import { handleGraphTool } from "../../src/tools/graph-tools.js";
import type { SymbolGraphMeta } from "../../src/types.js";

describe("symbol-graph-contract (End-to-End Pipeline on Disk)", () => {
  let tmpDir: string;
  let projId: string;

  beforeEach(() => {
    store.clear();
    resetSymbolGraphCollectionCache();
    resetSymbolGraphCacheRegistry();
    tmpDir = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-contract-")));
    projId = projectIdFromPath(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  /** Run the complete pipeline on the current fixture directory on disk */
  async function runPipeline() {
    const fileGraph = await rebuildGraph(tmpDir);
    const cache = await getSymbolGraphCache(projId);
    if (!cache) throw new Error("Failed to load symbol graph cache");
    return { fileGraph, cache };
  }

  it("extracts and disambiguates destructuring variable declarations", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "config.ts"),
      `
      const sourceObj = { host: "localhost", port: 8080, flags: ["a", "b"] };
      export const { host, port: serverPort, flags: [firstFlag] } = sourceObj;
      export const simpleVal = 42;
      `,
    );

    const { cache } = await runPipeline();
    const payload = await cache.getFilePayload("src/config.ts");
    expect(payload).toBeDefined();
    const syms = payload?.symbols ?? [];
    const names = syms.map((s) => s.name);

    expect(names).toContain("host");
    expect(names).toContain("serverPort");
    expect(names).toContain("firstFlag");
    expect(names).toContain("simpleVal");
    // Ensure the whole destructuring pattern was not extracted as a symbol name
    expect(names.some((n) => n.includes("{") || n.includes("}") || n.includes(":"))).toBe(false);
  });

  it("resolves multi-module duplicate symbol names preserving module identity", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "serviceA.ts"),
      `export function processData(x: number): number { return x * 2; }`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "serviceB.ts"),
      `export function processData(x: number): number { return x + 10; }`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "app.ts"),
      `
      import { processData } from "./serviceA";
      export function main(): void {
        processData(5);
      }
      `,
    );

    const { cache } = await runPipeline();

    // Querying processData in serviceA must only report app.ts
    const impactA = await getImpactRadius(cache, "processData", 2, { file: "src/serviceA.ts" });
    expect(impactA.status).toBe("ok");
    expect(impactA.totalFiles).toBe(1);
    expect(impactA.filesByDepth.get(1)).toEqual(["src/app.ts"]);

    // Querying processData in serviceB must report 0 dependents
    const impactB = await getImpactRadius(cache, "processData", 2, { file: "src/serviceB.ts" });
    expect(impactB.status).toBe("ok");
    expect(impactB.totalFiles).toBe(0);
  });

  it("resolves default exports correctly", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "logger.ts"),
      `
      export default class Logger {
        log(msg: string): void { console.log(msg); }
      }
      `,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "consumer.ts"),
      `
      import Logger from "./logger";
      export function run(): void {
        const l = new Logger();
      }
      `,
    );

    const { cache } = await runPipeline();
    const impact = await getImpactRadius(cache, "Logger");
    expect(impact.status).toBe("ok");
    expect(impact.totalFiles).toBe(1);
    expect(impact.filesByDepth.get(1)).toEqual(["src/consumer.ts"]);
  });

  it("resolves multi-level barrel files and re-exports transitively", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "engine.ts"),
      `export function startEngine(): string { return "vroom"; }`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "barrel1.ts"),
      `export { startEngine } from "./engine";`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "barrel2.ts"),
      `export * from "./barrel1";`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "car.ts"),
      `
      import { startEngine } from "./barrel2";
      export function drive(): void {
        startEngine();
      }
      `,
    );

    const { cache } = await runPipeline();
    const impact = await getImpactRadius(cache, "startEngine");
    expect(impact.status).toBe("ok");
    expect(impact.totalFiles).toBeGreaterThanOrEqual(1);
    expect(impact.filesByDepth.get(1)).toContain("src/car.ts");
    expect(impact.filesByDepth.get(1)).toContain("src/barrel1.ts");
  });

  it("traverses same-file calls and aggregates blast radius", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "math.ts"),
      `
      export function internalAdd(a: number, b: number): number { return a + b; }
      export function publicSum(arr: number[]): number {
        return internalAdd(arr[0] || 0, arr[1] || 0);
      }
      `,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "calculator.ts"),
      `
      import { publicSum } from "./math";
      export function calculate(): number {
        return publicSum([1, 2]);
      }
      `,
    );

    const { cache } = await runPipeline();
    const impact = await getImpactRadius(cache, "internalAdd", 3);
    expect(impact.status).toBe("ok");
    expect(impact.totalFiles).toBe(2);
    // Hop 1: same file math.ts (via publicSum)
    expect(impact.filesByDepth.get(1)).toEqual(["src/math.ts"]);
    // Hop 2: calculator.ts (via calculate calling publicSum)
    expect(impact.filesByDepth.get(2)).toEqual(["src/calculator.ts"]);
  });

  it("provides 360 context including caller kind and same-file callers", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "target.ts"),
      `
      export function execute(): void {}
      export function wrapper(): void {
        execute();
      }
      `,
    );

    const { cache } = await runPipeline();
    const ctx = await getSymbolContext(cache, "execute");
    expect(ctx).toHaveLength(1);
    expect(ctx[0].symbol.name).toBe("execute");
    expect(ctx[0].callers).toHaveLength(1);
    expect(ctx[0].callers[0].file).toBe("src/target.ts");
    expect(ctx[0].callers[0].kind).toBe("call");

    const toolOutput = await handleGraphTool("codebase_symbol", { name: "execute", projectPath: tmpDir });
    expect(toolOutput).toContain("← src/target.ts:4 (call)");
  });

  it("handles schema v1 graphs safely with graph_upgrade_required", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "dummy.ts"), `export function dummy() {}`);

    const { cache } = await runPipeline();
    cache.meta.schemaVersion = 1;
    await saveSymbolGraphMeta(projId, cache.meta);

    const impact = await getImpactRadius(cache, "dummy");
    expect(impact.status).toBe("graph_upgrade_required");
    expect(impact.totalFiles).toBe(0);
  });

  it("normalizes metadata without schemaVersion to 1 and triggers graph_upgrade_required", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "dummy.ts"), `export function dummy() {}`);

    const { cache } = await runPipeline();
    const { schemaVersion: _, ...legacyMeta } = cache.meta;
    await saveSymbolGraphMeta(projId, legacyMeta as SymbolGraphMeta);

    const loaded = await loadSymbolGraphMeta(projId);
    expect(loaded).toBeDefined();
    if (!loaded) throw new Error("Expected loaded meta to be defined");
    expect(loaded.schemaVersion).toBe(1);

    cache.meta = loaded;
    const impact = await getImpactRadius(cache, "dummy");
    expect(impact.status).toBe("graph_upgrade_required");
  });

  it("propagates storage read failures as storage_error (fail-closed)", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "dummy.ts"), `export function dummy() {}`);

    const { cache } = await runPipeline();

    // Mock loadReverseShard to throw StorageReadError
    vi.spyOn(cache, "getReverseSymbolIndex").mockRejectedValueOnce(
      new StorageReadError("Mock Qdrant shard connection failure"),
    );

    const impact = await getImpactRadius(cache, "dummy");
    expect(impact.status).toBe("storage_error");
    expect(impact.message).toContain("Mock Qdrant shard connection failure");
  });
});
