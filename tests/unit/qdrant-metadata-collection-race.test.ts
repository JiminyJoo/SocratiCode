// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
//
// ensureMetadataCollection() is awaited from more than ten exported functions,
// several of which run concurrently at startup. It is guarded by a boolean that
// is only set *after* creation finishes, so concurrent callers used to all see
// "does not exist" and all call createCollection — every caller but the first
// got a 409 Conflict, surfacing as
// `loadProjectHashes(...) failed [status 409]: Conflict` and aborting indexing.
//
// These tests drive the private helper through its exported callers and assert
// that (a) concurrent callers create the collection exactly once, (b) every
// shape of "already exists" from a *different process* counts as success rather
// than an error, (c) the payload index is ensured even when creation is skipped,
// and (d) a transient failure of either call, or a cache reset, leaves the next
// caller free to try again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockGetCollections = vi.fn();
const mockCreateCollection = vi.fn();
const mockCreatePayloadIndex = vi.fn();
const mockRetrieve = vi.fn();

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    getCollections = mockGetCollections;
    createCollection = mockCreateCollection;
    createPayloadIndex = mockCreatePayloadIndex;
    retrieve = mockRetrieve;
  },
}));

/** A rejection shaped like the Qdrant REST client's 409 Conflict. */
function conflict(): Error & { status: number } {
  const err: Error & { status?: number } = new Error("Conflict");
  err.status = 409;
  return err as Error & { status: number };
}

/** A 409 exposed as `statusCode` instead of `status`, as some clients report it. */
function conflictWithStatusCode(): Error & { statusCode: number } {
  const err: Error & { statusCode?: number } = new Error("Conflict");
  err.statusCode = 409;
  return err as Error & { statusCode: number };
}

/** A rejection that only says "already exists", carrying no status at all. */
function alreadyExistsMessage(collection: string): Error {
  return new Error(`Collection \`${collection}\` already exists!`);
}

/** A rejection shaped like a transient Qdrant outage. */
function unavailable(): Error & { status: number } {
  const err: Error & { status?: number } = new Error("Service Unavailable");
  err.status = 503;
  return err as Error & { status: number };
}

/**
 * The metadata collection name as the module under test builds it.
 *
 * `src/services/qdrant.ts` prepends `QDRANT_COLLECTION_PREFIX` to
 * `socraticode_metadata` at module load, so hardcoding the unprefixed name
 * breaks whenever the env var is set. Read it back from the same module
 * registry the test just imported from, after `vi.resetModules()`.
 */
async function metadataCollectionName(): Promise<string> {
  const { QDRANT_COLLECTION_PREFIX } = await import("../../src/constants.js");
  return `${QDRANT_COLLECTION_PREFIX}socraticode_metadata`;
}

/** Defer resolution so we can hold createCollection open across callers. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ensureMetadataCollection concurrency", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetCollections.mockReset();
    mockCreateCollection.mockReset();
    mockCreatePayloadIndex.mockReset();
    mockRetrieve.mockReset();
    // The metadata collection does not exist yet, so every caller wants to create it.
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreatePayloadIndex.mockResolvedValue(undefined);
    mockRetrieve.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates the collection once when three callers start together", async () => {
    const gate = deferred<void>();
    mockCreateCollection.mockImplementation(() => gate.promise);

    const { loadProjectHashes } = await import("../../src/services/qdrant.js");

    // All three observe "does not exist" before any creation finishes.
    const all = Promise.all([
      loadProjectHashes("codebase_a"),
      loadProjectHashes("codebase_b"),
      loadProjectHashes("codebase_c"),
    ]);
    gate.resolve();
    await all;

    expect(mockCreateCollection).toHaveBeenCalledTimes(1);
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(1);
  });

  it("does not report an error when another process wins the race", async () => {
    mockCreateCollection.mockRejectedValue(conflict());

    const { loadProjectHashes } = await import("../../src/services/qdrant.js");

    // A 409 means the collection now exists, which is the desired end state.
    await expect(loadProjectHashes("codebase_a")).resolves.toBeNull();
    expect(mockCreateCollection).toHaveBeenCalledTimes(1);
  });

  it("accepts an already-exists message that carries no status", async () => {
    mockCreateCollection.mockRejectedValue(alreadyExistsMessage(await metadataCollectionName()));

    const { loadProjectHashes } = await import("../../src/services/qdrant.js");

    await expect(loadProjectHashes("codebase_a")).resolves.toBeNull();
    expect(mockCreateCollection).toHaveBeenCalledTimes(1);
  });

  it("accepts a 409 reported as statusCode rather than status", async () => {
    mockCreateCollection.mockRejectedValue(conflictWithStatusCode());

    const { loadProjectHashes } = await import("../../src/services/qdrant.js");

    await expect(loadProjectHashes("codebase_a")).resolves.toBeNull();
    expect(mockCreateCollection).toHaveBeenCalledTimes(1);
  });

  it("tolerates a conflict on the payload index too", async () => {
    mockCreateCollection.mockRejectedValue(conflict());
    mockCreatePayloadIndex.mockRejectedValue(conflict());

    const { loadProjectHashes } = await import("../../src/services/qdrant.js");

    await expect(loadProjectHashes("codebase_a")).resolves.toBeNull();
  });

  it("still surfaces failures that are not conflicts", async () => {
    mockCreateCollection.mockRejectedValue(unavailable());

    const { loadProjectHashes } = await import("../../src/services/qdrant.js");

    await expect(loadProjectHashes("codebase_a")).rejects.toThrow(/Service Unavailable/);
  });

  it("rejects when the payload index fails, then retries the index next call", async () => {
    const collection = await metadataCollectionName();
    // The collection is created on the first attempt and exists from then on, so
    // the second attempt reaches the index without recreating anything.
    mockGetCollections
      .mockResolvedValueOnce({ collections: [] })
      .mockResolvedValue({ collections: [{ name: collection }] });
    mockCreateCollection.mockResolvedValue(undefined);
    mockCreatePayloadIndex.mockRejectedValueOnce(unavailable()).mockResolvedValue(undefined);

    const { loadProjectHashes } = await import("../../src/services/qdrant.js");

    // A collection without its `collectionName` index is not usable. Reporting
    // success here would mark the collection ready and strand it unindexed for
    // the rest of the process, so the failure has to reach the caller.
    await expect(loadProjectHashes("codebase_a")).rejects.toThrow(/Service Unavailable/);

    // Nothing was cached as ready, so the next caller retries the index — and
    // this time it lands.
    await expect(loadProjectHashes("codebase_b")).resolves.toBeNull();

    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(2);
    expect(mockCreatePayloadIndex).toHaveBeenLastCalledWith(collection, {
      field_name: "collectionName",
      field_schema: "keyword",
    });
    // The collection itself was only ever created once.
    expect(mockCreateCollection).toHaveBeenCalledTimes(1);
  });

  it("retries creation after a transient failure instead of caching it", async () => {
    mockCreateCollection.mockRejectedValueOnce(unavailable()).mockResolvedValueOnce(undefined);

    const { loadProjectHashes } = await import("../../src/services/qdrant.js");

    // The first attempt propagates the failure.
    await expect(loadProjectHashes("codebase_a")).rejects.toThrow(/Service Unavailable/);
    // The in-flight promise must have been cleared, so a second call tries again
    // instead of reusing the rejected promise forever.
    await expect(loadProjectHashes("codebase_a")).resolves.toBeNull();

    expect(mockCreateCollection).toHaveBeenCalledTimes(2);
  });

  it("lets a cache reset during creation stand", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    mockCreateCollection.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });

    const { loadProjectHashes, resetMetadataCollectionCache } = await import(
      "../../src/services/qdrant.js"
    );

    const first = loadProjectHashes("codebase_a");
    await entered.promise;
    // The reset lands while the first caller is still creating the collection.
    resetMetadataCollectionCache();
    gate.resolve();
    await first;

    // The finished attempt is no longer the current one, so it must not mark the
    // cache ready again — the next caller has to re-check the server.
    await loadProjectHashes("codebase_b");
    expect(mockGetCollections).toHaveBeenCalledTimes(2);
  });

  it("skips creation but still ensures the index when the collection exists", async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: await metadataCollectionName() }],
    });

    const { loadProjectHashes } = await import("../../src/services/qdrant.js");

    await loadProjectHashes("codebase_a");
    await loadProjectHashes("codebase_b");

    expect(mockCreateCollection).not.toHaveBeenCalled();
    // An earlier run may have created the collection and then failed before
    // indexing it, so the index is ensured even when creation is skipped.
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(1);
    // The readiness flag short-circuits the second call, so only one listing happens.
    expect(mockGetCollections).toHaveBeenCalledTimes(1);
  });
});
