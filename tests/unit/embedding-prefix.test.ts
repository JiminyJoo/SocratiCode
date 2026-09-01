// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
//
// Tests for EMBEDDING_QUERY_PREFIX / EMBEDDING_DOCUMENT_PREFIX.
//
// Both are read lazily — at the point of use, and once more when the
// embedding config loads so their values reach the logs — so a case only has to
// set the variables before calling in, with no module-cache juggling.
// `vi.stubEnv` sets them and `vi.unstubAllEnvs()` puts the shell's own values
// back, which also keeps a prefix exported in the developer's shell (to run a
// model such as bge-m3) from deciding what these assertions see.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEmbeddingConfig,
  resetEmbeddingConfig,
} from "../../src/services/embedding-config.js";
import type { EmbeddingProvider } from "../../src/services/embedding-types.js";
import {
  generateQueryEmbedding,
  prepareDocumentText,
} from "../../src/services/embeddings.js";
import { logger } from "../../src/services/logger.js";

// Mock the provider factory so the query-side tests never touch Docker/Ollama/API.
vi.mock("../../src/services/embedding-provider.js", () => ({
  getEmbeddingProvider: vi.fn(),
}));

import { getEmbeddingProvider } from "../../src/services/embedding-provider.js";

/** Build a fake provider whose embedSingle() returns a predictable vector. */
function makeMockProvider() {
  return {
    name: "mock",
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    embedSingle: vi.fn(async (_text: string) => [0.1, 0.2, 0.3]),
    ensureReady: vi.fn(async () => ({ modelPulled: false, containerStarted: false, imagePulled: false })),
    healthCheck: vi.fn(async () => ({ available: true, modelReady: true, statusLines: [] })),
  };
}

/** Wire the mock provider in and hand it back for assertions. */
function useMockProvider() {
  const provider = makeMockProvider();
  vi.mocked(getEmbeddingProvider).mockResolvedValue(provider as unknown as EmbeddingProvider);
  return provider;
}

beforeEach(() => {
  resetEmbeddingConfig();
  // Start from a clean slate: no prefixes set, the file path embedded as it is
  // by default — the prepareDocumentText cases below expect it in the output —
  // and the default provider, so the config-loading cases don't depend on the
  // developer's shell either.
  vi.stubEnv("EMBEDDING_QUERY_PREFIX", undefined);
  vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", undefined);
  vi.stubEnv("EMBEDDING_DOCUMENT_INCLUDE_PATH", undefined);
  vi.stubEnv("EMBEDDING_PROVIDER", "ollama");
});

afterEach(() => {
  resetEmbeddingConfig();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("EMBEDDING_DOCUMENT_PREFIX", () => {
  it("falls back to the nomic-embed-text default when unset", () => {
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "search_document: src/app.ts\nconst a = 1;",
    );
  });

  it("treats an explicit empty string as 'no prefix' rather than falling back", () => {
    // bge-m3 expects no prefix at all, so "" must not be replaced by the default.
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "");
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "src/app.ts\nconst a = 1;",
    );
  });

  it("accepts the multilingual-e5 prefix", () => {
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "passage: ");
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "passage: src/app.ts\nconst a = 1;",
    );
  });

  it("accepts non-ASCII prefixes such as the ruri-v3 scheme", () => {
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "検索文書: ");
    expect(prepareDocumentText("const a = 1;", "src/app.ts")).toBe(
      "検索文書: src/app.ts\nconst a = 1;",
    );
  });

  it("prefixes only the head of a multi-line body, leaving the rest untouched", () => {
    // The cases above all use a one-line body at a shallow path. The prefix goes
    // in front of the path once — not in front of each line of the content.
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "passage: ");
    expect(
      prepareDocumentText(
        "const a = 1;\nconst b = 2;\n",
        "src/services/deep/app.ts",
      ),
    ).toBe("passage: src/services/deep/app.ts\nconst a = 1;\nconst b = 2;\n");
  });
});

describe("EMBEDDING_QUERY_PREFIX", () => {
  it("falls back to the nomic-embed-text default when unset", async () => {
    const provider = useMockProvider();
    await generateQueryEmbedding("find auth logic");
    expect(provider.embedSingle).toHaveBeenCalledWith("search_query: find auth logic");
  });

  it("uses the configured prefix", async () => {
    vi.stubEnv("EMBEDDING_QUERY_PREFIX", "検索クエリ: ");
    const provider = useMockProvider();
    await generateQueryEmbedding("find auth logic");
    expect(provider.embedSingle).toHaveBeenCalledWith("検索クエリ: find auth logic");
  });

  it("sends the bare query when set to an explicit empty string", async () => {
    vi.stubEnv("EMBEDDING_QUERY_PREFIX", "");
    const provider = useMockProvider();
    await generateQueryEmbedding("find auth logic");
    expect(provider.embedSingle).toHaveBeenCalledWith("find auth logic");
  });
});

// The values are logged from loadEmbeddingConfig() rather than at module load,
// because the MCP notification transport is only registered once the server is
// connected — anything logged during module evaluation goes to stderr, which
// hosts such as Cline drop.
describe("prefix reporting in the embedding config log", () => {
  it("logs the resolved values", () => {
    vi.stubEnv("EMBEDDING_QUERY_PREFIX", "query: ");
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "passage: ");
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    loadEmbeddingConfig();

    expect(infoSpy).toHaveBeenCalledWith(
      "Embedding config loaded",
      expect.objectContaining({
        queryPrefix: "query: ",
        documentPrefix: "passage: ",
      }),
    );
  });

  it("warns when only the query side is set", () => {
    vi.stubEnv("EMBEDDING_QUERY_PREFIX", "query: ");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    loadEmbeddingConfig();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("EMBEDDING_DOCUMENT_PREFIX"),
      { queryPrefixSet: true, documentPrefixSet: false },
    );
  });

  it("warns when only the document side is set", () => {
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "passage: ");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    loadEmbeddingConfig();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("EMBEDDING_QUERY_PREFIX"),
      { queryPrefixSet: false, documentPrefixSet: true },
    );
  });

  it("stays quiet when both sides are set", () => {
    vi.stubEnv("EMBEDDING_QUERY_PREFIX", "query: ");
    vi.stubEnv("EMBEDDING_DOCUMENT_PREFIX", "passage: ");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    loadEmbeddingConfig();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays quiet when neither side is set", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    loadEmbeddingConfig();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
