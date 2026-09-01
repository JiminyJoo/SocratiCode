// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
//
// MAX_CHUNK_CHARS caps every chunk regardless of chunking strategy. On the
// small-file single-chunk path, chunkByAstRegions and chunkByLines it only
// truncates: content past the cap is dropped before the chunk is stored — no
// vector, no payload, no BM25 text — so no search retrieves it. On
// chunkByCharacters, the minified/bundled path, the cap is the split boundary
// instead, so a lower cap yields more chunks. The cap therefore has to match
// the embedding model's context window.
//
// MAX_CHUNK_CHARS is read once at module load in src/constants.ts, so each case
// resets the module cache and re-imports to make the env-var IIFE run again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "MAX_CHUNK_CHARS";

describe("MAX_CHUNK_CHARS", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
    vi.resetModules();
  });

  describe("default — backwards compatibility", () => {
    it("is 2000 when the variable is unset", async () => {
      delete process.env[ENV_KEY];
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });

    it("is 2000 when the variable is empty", async () => {
      process.env[ENV_KEY] = "";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });
  });

  describe("override", () => {
    it("accepts a smaller cap for short-context models", async () => {
      process.env[ENV_KEY] = "600";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(600);
    });

    // Not "a cap for long-context models": 8000 is past the effective embedding
    // limit of the default provider (nomic-embed-text at CHARS_PER_TOKEN_ESTIMATE=1.0
    // and a 2048-token context), so the provider pre-truncates and the characters
    // past that point reach the payload and the BM25 text but not the vector.
    // Validation is deliberately lower-bound only — see src/constants.ts.
    it("accepts a cap above the default provider's effective embedding limit", async () => {
      process.env[ENV_KEY] = "8000";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(8000);
    });

    // 1 is the smallest value validation allows, not a usable one: prepareDocumentText
    // prepends the document prefix, the path and a newline, so the embedded text
    // is essentially that header alone.
    it("accepts 1, the smallest value validation allows", async () => {
      process.env[ENV_KEY] = "1";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(1);
    });

    it("accepts scientific notation that resolves to an integer", async () => {
      process.env[ENV_KEY] = "2e3";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });
  });

  describe("validation — a bad value fails at load, not mid-index", () => {
    for (const bad of ["0", "-100", "abc", "1.5", " ", "1_000"]) {
      it(`rejects ${JSON.stringify(bad)}`, async () => {
        process.env[ENV_KEY] = bad;
        await expect(import("../../src/constants.js")).rejects.toThrow(
          /Invalid MAX_CHUNK_CHARS/,
        );
      });
    }

    it("names the offending value and the default in the message", async () => {
      process.env[ENV_KEY] = "nope";
      const err = await import("../../src/constants.js").then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain('"nope"');
      expect(err?.message).toContain("2000");
    });
  });

  describe("the cap is what chunking actually applies", () => {
    it("truncates an over-long chunk to the configured cap", async () => {
      process.env[ENV_KEY] = "120";
      const { chunkFileContent } = await import("../../src/services/indexer.js");
      // A single 500-char line has an average line length of exactly
      // MAX_AVG_LINE_LENGTH, so the minified heuristic (avgLineLength > 500) does
      // not fire: this takes the small-file single-chunk branch and so exercises
      // applyCharCap, the truncation-only path.
      const long = "x".repeat(500);
      const chunks = chunkFileContent("/tmp/notes.txt", "notes.txt", long);
      // Exactly one chunk holding exactly the first 120 characters: a bound of
      // "at most 120, at least one chunk" would also hold if this path re-split
      // the input, which is what distinguishes truncation from splitting.
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe(long.slice(0, 120));
    });

    it("keeps more content in total when the cap is raised", async () => {
      // 62 short lines: below CHUNK_SIZE and well below MAX_AVG_LINE_LENGTH, so this
      // also takes the small-file single-chunk branch. The cap only truncates here —
      // it does not move any boundary.
      const body = ["function a() {", ...Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`), "}"].join("\n");

      process.env[ENV_KEY] = "200";
      vi.resetModules();
      const small = await import("../../src/services/indexer.js");
      const smallTotal = small
        .chunkFileContent("/tmp/sample.txt", "sample.txt", body)
        .reduce((n, c) => n + c.content.length, 0);

      process.env[ENV_KEY] = "4000";
      vi.resetModules();
      const large = await import("../../src/services/indexer.js");
      const largeTotal = large
        .chunkFileContent("/tmp/sample.txt", "sample.txt", body)
        .reduce((n, c) => n + c.content.length, 0);

      // A lower cap discards the tail of each chunk, so less content survives.
      expect(largeTotal).toBeGreaterThan(smallTotal);
    });

    // The minified/bundled path (chunkByCharacters) is the only one where the cap
    // decides chunk boundaries rather than merely truncating, so it is the only
    // place a lower cap yields more chunks. Four lines of 3000 characters put the
    // average line length above MAX_AVG_LINE_LENGTH (500) and so select it.
    it("splits minified content into more chunks as the cap falls", async () => {
      const minified = Array.from({ length: 4 }, () => "x".repeat(3000)).join("\n");

      process.env[ENV_KEY] = "3000";
      vi.resetModules();
      const wide = await import("../../src/services/indexer.js");
      const wideChunks = wide.chunkFileContent("/tmp/bundle.js", "bundle.js", minified);

      process.env[ENV_KEY] = "500";
      vi.resetModules();
      const narrow = await import("../../src/services/indexer.js");
      const narrowChunks = narrow.chunkFileContent("/tmp/bundle.js", "bundle.js", minified);

      expect(wideChunks.length).toBeGreaterThan(0);
      expect(narrowChunks.length).toBeGreaterThan(wideChunks.length);
      for (const c of narrowChunks) {
        expect(c.content.length).toBeLessThanOrEqual(500);
      }
    });
  });
});
