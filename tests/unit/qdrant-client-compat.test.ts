// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  qdrantClientBreaksOnThisNode,
  readInstalledQdrantClientVersion,
} from "../../src/services/qdrant-client-compat.js";

/**
 * The startup guard refuses only the PAIR that breaks: Node 26+ with
 * @qdrant/js-client-rest < 1.19 (undici 6 vs Node 26's fetch). These tests
 * pin the pair logic and the version reader; getting either wrong turns the
 * guard back into what it replaced — a blanket Node 26 refusal that turns
 * away working installs, or a silent boot into a client whose first request
 * dies with an opaque undici error.
 */
describe("qdrant-client-compat", () => {
  describe("readInstalledQdrantClientVersion", () => {
    it("reads the version of the actually installed client", () => {
      // The package's exports map exposes only ".", so the reader resolves
      // the entry and walks up; the result must equal what node_modules
      // really contains, not a guess.
      const expected = JSON.parse(
        fs.readFileSync(
          path.join(process.cwd(), "node_modules/@qdrant/js-client-rest/package.json"),
          "utf8",
        ),
      ).version;

      expect(readInstalledQdrantClientVersion()).toBe(expected);
    });
  });

  describe("qdrantClientBreaksOnThisNode", () => {
    it("never breaks below Node 26, whatever the client", () => {
      for (const version of ["1.18.0", "1.19.0", null]) {
        for (const major of [18, 20, 22, 24, 25]) {
          expect(qdrantClientBreaksOnThisNode(major, version), `${major}/${version}`).toBe(false);
        }
      }
    });

    it("breaks on Node 26+ with a pre-1.19 client", () => {
      expect(qdrantClientBreaksOnThisNode(26, "1.18.0")).toBe(true);
      expect(qdrantClientBreaksOnThisNode(26, "1.17.0")).toBe(true);
      expect(qdrantClientBreaksOnThisNode(27, "1.18.5")).toBe(true);
    });

    it("does not break on Node 26+ with 1.19 or newer", () => {
      // The whole point of the versioned guard: a working install must not
      // be turned away.
      expect(qdrantClientBreaksOnThisNode(26, "1.19.0")).toBe(false);
      expect(qdrantClientBreaksOnThisNode(26, "1.20.3")).toBe(false);
      expect(qdrantClientBreaksOnThisNode(27, "2.0.0")).toBe(false);
    });

    it("fails closed on Node 26+ when the version is unknown or unparseable", () => {
      // Booting anyway would trade the guard's clear message for the opaque
      // UND_ERR_INVALID_ARG at the first qdrant call.
      expect(qdrantClientBreaksOnThisNode(26, null)).toBe(true);
      expect(qdrantClientBreaksOnThisNode(26, "not-a-version")).toBe(true);
    });

    it("treats a non-finite node major as not breaking", () => {
      // An unparseable process.versions.node must not brick startup on
      // Node versions the guard was never about.
      expect(qdrantClientBreaksOnThisNode(Number.NaN, "1.18.0")).toBe(false);
    });
  });
});
