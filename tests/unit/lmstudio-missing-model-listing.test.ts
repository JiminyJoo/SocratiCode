// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEmbeddingConfig } from "../../src/services/embedding-config.js";
import { LMStudioEmbeddingProvider, resetLMStudioClient } from "../../src/services/provider-lmstudio.js";

/**
 * A fake OpenAI client stands in for the server. The axis that matters is how
 * /v1/models fails: a 404 or 405 means the endpoint is absent — the shape of
 * HuggingFace Text Embeddings Inference (TEI) — whereas a refused connection or a
 * 401 means something else is wrong and must keep the LM Studio guidance.
 *
 * LMSTUDIO_ALLOW_MISSING_MODEL_LISTING is resolved by getEmbeddingConfig() on every
 * call, so each case only needs vi.stubEnv plus a config reset — no module reloading.
 */
const fake = vi.hoisted(() => ({
  behaviour: {
    /** HTTP status models.list() fails with. undefined means it succeeds. */
    listStatus: undefined as number | undefined,
    /** Fail models.list() with a transport error, which carries no status. */
    listTransportError: false,
    /** Model ids returned when models.list() succeeds. */
    listedModels: [] as string[],
    /** Fail embeddings.create() to simulate a dead server. */
    embedFails: false,
    /** Width of the vectors embeddings.create() returns. */
    embeddingLength: 0,
  },
  calls: { list: 0, embed: 0 },
}));

vi.mock("openai", () => {
  class FakeOpenAI {
    models = {
      list: async () => {
        fake.calls.list++;
        if (fake.behaviour.listTransportError) {
          throw new Error("connect ECONNREFUSED 127.0.0.1:18080");
        }
        if (fake.behaviour.listStatus !== undefined) {
          const err = new Error(
            `${fake.behaviour.listStatus} status code (no body)`,
          ) as Error & { status: number };
          err.status = fake.behaviour.listStatus;
          throw err;
        }
        return { data: fake.behaviour.listedModels.map((id) => ({ id })) };
      },
    };
    embeddings = {
      create: async ({ input }: { input: string[] }) => {
        fake.calls.embed++;
        if (fake.behaviour.embedFails) throw new Error("connection refused");
        const embedding = Array.from({ length: fake.behaviour.embeddingLength }, () => 0.1);
        return { data: input.map((_, index) => ({ index, embedding })) };
      },
    };
  }
  return { default: FakeOpenAI, OpenAI: FakeOpenAI };
});

const MODEL = "BAAI/bge-m3";
const DIMENSIONS = 1024;

/** Apply the lmstudio env, plus overrides, and drop the cached config. */
function setEnv(overrides: Record<string, string | undefined> = {}): void {
  const env: Record<string, string | undefined> = {
    EMBEDDING_PROVIDER: "lmstudio",
    LMSTUDIO_URL: "http://localhost:18080/v1",
    EMBEDDING_MODEL: MODEL,
    EMBEDDING_DIMENSIONS: String(DIMENSIONS),
    EMBEDDING_CONTEXT_LENGTH: undefined,
    LMSTUDIO_API_KEY: undefined,
    // Explicitly unset so an exported flag in the developer's shell cannot leak in.
    LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: undefined,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  resetEmbeddingConfig();
}

beforeEach(() => {
  fake.behaviour.listStatus = undefined;
  fake.behaviour.listTransportError = false;
  fake.behaviour.listedModels = [MODEL];
  fake.behaviour.embedFails = false;
  fake.behaviour.embeddingLength = DIMENSIONS;
  fake.calls.list = 0;
  fake.calls.embed = 0;
  resetEmbeddingConfig();
  resetLMStudioClient();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEmbeddingConfig();
  resetLMStudioClient();
});

describe("ensureReady — default behaviour is unchanged", () => {
  it("succeeds when /v1/models lists the configured model", async () => {
    setEnv();
    await expect(
      new LMStudioEmbeddingProvider().ensureReady(),
    ).resolves.toMatchObject({ modelPulled: false });
    expect(fake.calls.list).toBe(1);
    // The default path must not spend an embedding call on probing.
    expect(fake.calls.embed).toBe(0);
  });

  it("fails with the LM Studio message when /v1/models is missing and the flag is unset", async () => {
    setEnv();
    fake.behaviour.listStatus = 404;
    await expect(
      new LMStudioEmbeddingProvider().ensureReady(),
    ).rejects.toThrow(/LMSTUDIO_ALLOW_MISSING_MODEL_LISTING/);
    expect(fake.calls.embed).toBe(0);
  });

  it("still fails when the model is absent from a working listing", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listedModels = ["some-other-model"];
    await expect(
      new LMStudioEmbeddingProvider().ensureReady(),
    ).rejects.toThrow(/is not loaded/);
  });
});

describe("ensureReady — LMSTUDIO_ALLOW_MISSING_MODEL_LISTING=true", () => {
  it("falls back to an embedding probe when the listing returns 404", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listStatus = 404;
    await expect(
      new LMStudioEmbeddingProvider().ensureReady(),
    ).resolves.toMatchObject({ modelPulled: false });
    expect(fake.calls.list).toBe(1);
    expect(fake.calls.embed).toBe(1);
  });

  it("falls back to an embedding probe when the listing returns 405", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listStatus = 405;
    await expect(
      new LMStudioEmbeddingProvider().ensureReady(),
    ).resolves.toMatchObject({ modelPulled: false });
    expect(fake.calls.embed).toBe(1);
  });

  it("does not probe when the server refuses the connection", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listTransportError = true;
    await expect(
      new LMStudioEmbeddingProvider().ensureReady(),
    ).rejects.toThrow(/Local Server tab > Start Server/);
    expect(fake.calls.embed).toBe(0);
  });

  it("does not probe when the listing is rejected with 401", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listStatus = 401;
    await expect(
      new LMStudioEmbeddingProvider().ensureReady(),
    ).rejects.toThrow(/LM Studio is not reachable/);
    expect(fake.calls.embed).toBe(0);
  });

  it("reports both errors when the probe also fails", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listStatus = 404;
    fake.behaviour.embedFails = true;
    const err = await new LMStudioEmbeddingProvider()
      .ensureReady()
      .catch((e: unknown) => e as Error);
    expect(err.message).toContain("Model listing error");
    expect(err.message).toContain("Embedding probe error");
  });

  it("fails when the probe's vector width disagrees with EMBEDDING_DIMENSIONS", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listStatus = 404;
    fake.behaviour.embeddingLength = 768;
    const err = await new LMStudioEmbeddingProvider()
      .ensureReady()
      .catch((e: unknown) => e as Error);
    // Both the expected and the observed width belong in the message.
    expect(err.message).toContain("768");
    expect(err.message).toContain("1024");
  });

  it.each(["true", "TRUE", "True", " true ", "1", "yes"])(
    "treats %j as enabled",
    async (value) => {
      setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: value });
      fake.behaviour.listStatus = 404;
      await expect(
        new LMStudioEmbeddingProvider().ensureReady(),
      ).resolves.toMatchObject({ modelPulled: false });
      expect(fake.calls.embed).toBe(1);
    },
  );

  it.each(["false", "FALSE", "0", "no", "", "  "])(
    "treats %j as disabled",
    async (value) => {
      setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: value });
      fake.behaviour.listStatus = 404;
      await expect(
        new LMStudioEmbeddingProvider().ensureReady(),
      ).rejects.toThrow(/LMSTUDIO_ALLOW_MISSING_MODEL_LISTING/);
      expect(fake.calls.embed).toBe(0);
    },
  );

  // A misspelling used to be read as "disabled", so the operator saw the
  // missing-listing failure they thought they had opted out of.
  it.each(["ture", "on", "enabled"])(
    "refuses to start on the unrecognised value %j",
    async (value) => {
      setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: value });
      fake.behaviour.listStatus = 404;
      await expect(
        new LMStudioEmbeddingProvider().ensureReady(),
      ).rejects.toThrow(
        new RegExp(`Invalid LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "${value}"`),
      );
      expect(fake.calls.list).toBe(0);
      expect(fake.calls.embed).toBe(0);
    },
  );
});

describe("healthCheck — a server without /v1/models is not reported as down", () => {
  it("reports the loaded model when /v1/models answers and the flag is unset", async () => {
    setEnv();
    const status = await new LMStudioEmbeddingProvider().healthCheck();
    expect(status.available).toBe(true);
    expect(status.modelReady).toBe(true);
    expect(status.statusLines.join("\n")).toContain("LM Studio: Reachable");
    expect(fake.calls.embed).toBe(0);
  });

  it("reports the loaded model when /v1/models answers and the flag is set", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    const status = await new LMStudioEmbeddingProvider().healthCheck();
    expect(status.available).toBe(true);
    expect(status.modelReady).toBe(true);
    expect(status.statusLines.join("\n")).toContain("LM Studio: Reachable");
    // A working listing needs no probe even with the flag on.
    expect(fake.calls.embed).toBe(0);
  });

  it("reports available via the embedding probe when the flag is set", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listStatus = 404;
    const status = await new LMStudioEmbeddingProvider().healthCheck();
    expect(status.available).toBe(true);
    expect(status.modelReady).toBe(true);
    expect(status.statusLines.join("\n")).toContain("/v1/embeddings");
  });

  // ensureReady() refuses a probe whose width disagrees with EMBEDDING_DIMENSIONS,
  // so healthCheck must not call the same configuration ready.
  it("reports the model as not ready when the probe width disagrees", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listStatus = 404;
    fake.behaviour.embeddingLength = 768;
    const status = await new LMStudioEmbeddingProvider().healthCheck();
    expect(status.available).toBe(true);
    expect(status.modelReady).toBe(false);
    const text = status.statusLines.join("\n");
    expect(text).toContain("768-dimensional");
    expect(text).toContain("EMBEDDING_DIMENSIONS");
  });

  it("reports unavailable when neither endpoint answers", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listStatus = 404;
    fake.behaviour.embedFails = true;
    const status = await new LMStudioEmbeddingProvider().healthCheck();
    expect(status.available).toBe(false);
    expect(status.modelReady).toBe(false);
  });

  it("keeps the original message when the flag is unset", async () => {
    setEnv();
    fake.behaviour.listStatus = 404;
    const status = await new LMStudioEmbeddingProvider().healthCheck();
    expect(status.available).toBe(false);
    expect(status.statusLines.join("\n")).toContain("LM Studio: Not reachable");
  });

  it("keeps the original message when the server refuses the connection", async () => {
    setEnv({ LMSTUDIO_ALLOW_MISSING_MODEL_LISTING: "true" });
    fake.behaviour.listTransportError = true;
    const status = await new LMStudioEmbeddingProvider().healthCheck();
    expect(status.available).toBe(false);
    expect(status.statusLines.join("\n")).toContain("LM Studio: Not reachable");
    expect(fake.calls.embed).toBe(0);
  });
});
