// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
//
// Tests for EMBEDDING_DOCUMENT_INCLUDE_PATH.
//
// The variable is read lazily — at the point of use, and once more when the
// embedding config loads so its value reaches the logs — so a case only has to
// set it before calling in, with no module-cache juggling. `vi.stubEnv` sets it
// and `vi.unstubAllEnvs()` puts the shell's own value back, which also keeps a
// setting exported in the developer's shell from deciding what these assertions
// see.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEmbeddingConfig,
  resetEmbeddingConfig,
} from "../../src/services/embedding-config.js";
import { prepareDocumentText } from "../../src/services/embeddings.js";
import { logger } from "../../src/services/logger.js";

beforeEach(() => {
  resetEmbeddingConfig();
  // Start from a clean slate: the path setting unset, the task prefixes at their
  // defaults — most cases below spell the document prefix out in the expected
  // string — and the default provider, so the config-loading cases don't depend
  // on the developer's shell either.
  vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", undefined);
  vi.stubEnv("EMBEDDING_QUERY_PREFIX", undefined);
  vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", undefined);
  vi.stubEnv("EMBEDDING_PROVIDER", "ollama");
});

afterEach(() => {
  resetEmbeddingConfig();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("EMBEDDING_DOCUMENT_INCLUDE_PATH", () => {
  it("includes the path by default", () => {
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "search_document: src/app.ts\nconst a = 1;",
    );
  });

  it.each(["false", "False", "FALSE", "0", "no", "NO"])("drops the path for %j", (raw) => {
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", raw);
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "search_document: const a = 1;",
    );
  });

  it.each(["true", "True", "TRUE", "1", "yes", "YES"])("keeps the path for %j", (raw) => {
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", raw);
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "search_document: src/app.ts\nconst a = 1;",
    );
  });

  // A trailing space is easy to end up with — `- EMBEDDING_DOCUMENT_INCLUDE_PATH=false `
  // in a compose file, or a trailing space on a .env line — and must not be
  // mistaken for an invalid value.
  it.each(["false ", " false", "\tfalse\n"])("ignores whitespace around %j", (raw) => {
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", raw);
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "search_document: const a = 1;",
    );
  });

  // `"EMBEDDING_DOCUMENT_INCLUDE_PATH": ""` in an MCP host config, or
  // `- EMBEDDING_DOCUMENT_INCLUDE_PATH=` in a compose file, means "leave the
  // default alone" — not "fail to start".
  it.each(["", " "])("treats %j as unset and keeps the default", (raw) => {
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", raw);
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "search_document: src/app.ts\nconst a = 1;",
    );
  });

  it.each(["maybe", "off"])("rejects the invalid value %j", (raw) => {
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", raw);
    expect(() => prepareDocumentText("const a = 1;", "src/app.ts")).toThrow(
      `Invalid EMBEDDING_DOCUMENT_INCLUDE_PATH: "${raw}". Must be "true", "1", "yes", ` +
        `"false", "0", or "no" (case-insensitive), or left unset.`,
    );
  });

  // A context artifact's "path" is a context:<name>:<path> identifier, so
  // dropping the path drops the artifact name from the embedded text as well.
  it("drops the context artifact identifier along with the path", () => {
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", "false");
    expect(prepareDocumentText("some notes", "context:design:docs/plan.md")).toBe(
      "search_document: some notes",
    );
  });
});

// The two settings compose: EMBEDDING_DOCUMENT_PREFIX decides what goes in front
// of the text, EMBEDDING_DOCUMENT_INCLUDE_PATH only decides whether the path sits
// between the prefix and the content. Turning the path off must not disturb the
// configured prefix, and the prefix supplies whatever separation there is — the
// path no longer contributes its newline.
describe("EMBEDDING_DOCUMENT_INCLUDE_PATH combined with EMBEDDING_DOCUMENT_PREFIX", () => {
  it("keeps a configured prefix when the path is off", () => {
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "passage: ");
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", "false");
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "passage: const a = 1;",
    );
  });

  it("embeds the bare content when both the prefix and the path are off", () => {
    // bge-m3 wants no prefix at all, so with the path off nothing is prepended.
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "");
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", "false");
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe("const a = 1;");
  });

  it("adds no separator of its own to a prefix that does not end in one", () => {
    // The path used to carry the newline that separated it from the content.
    // With the path off, a prefix without a trailing space runs straight into
    // the content — that is the prefix's business, not this setting's.
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "検索文書:");
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", "false");
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "検索文書:const a = 1;",
    );
  });
});

// The value is logged from loadEmbeddingConfig() rather than at module load,
// because the MCP notification transport is only registered once the server is
// connected — anything logged during module evaluation goes to stderr, which
// hosts such as Cline drop.
describe("path reporting in the embedding config log", () => {
  it("logs the resolved value", () => {
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", "false");
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    loadEmbeddingConfig();

    expect(infoSpy).toHaveBeenCalledWith(
      "Embedding config loaded",
      expect.objectContaining({ documentIncludesPath: false }),
    );
  });

  // Config load is inside a tool call, so an invalid value surfaces there
  // instead of taking the server down during module evaluation.
  it("rejects an invalid value while loading the config", () => {
    vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", "maybe");
    expect(() => loadEmbeddingConfig()).toThrow(
      'Invalid EMBEDDING_DOCUMENT_INCLUDE_PATH: "maybe". Must be "true", "1", "yes", ' +
        '"false", "0", or "no" (case-insensitive), or left unset.',
    );
  });
});
