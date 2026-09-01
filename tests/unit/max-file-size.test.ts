// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "MAX_FILE_SIZE_MB";

describe("MAX_FILE_SIZE_MB", () => {
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

  it("keeps the default byte limit", async () => {
    delete process.env[ENV_KEY];
    const { MAX_FILE_BYTES } = await import("../../src/constants.js");
    expect(MAX_FILE_BYTES).toBe(5_000_000);
  });

  it("keeps finite limits accepted by earlier releases", async () => {
    process.env[ENV_KEY] = "0";
    const { MAX_FILE_BYTES } = await import("../../src/constants.js");
    expect(MAX_FILE_BYTES).toBe(0);
  });

  it("rejects a value that cannot be persisted in an effective profile", async () => {
    process.env[ENV_KEY] = "not-a-number";
    await expect(import("../../src/constants.js")).rejects.toThrow(
      /Invalid MAX_FILE_SIZE_MB/,
    );
  });
});
