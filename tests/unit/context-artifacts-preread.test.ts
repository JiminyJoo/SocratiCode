// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * `ensureArtifactsIndexed` reads every artifact to compute its staleness hash,
 * then re-indexes the stale ones. Without threading that content through,
 * `indexArtifact` walks the directory and re-reads every file to reproduce what
 * the caller already held — the largest cost on the search path, since reading
 * and hashing file contents dominates a directory read.
 *
 * These tests pin the contract rather than the timing: content handed in is the
 * content indexed, and a caller that hands nothing in still reads for itself.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactIndexState } from "../../src/types.js";

let rootDir: string;
let existingMetadata: ArtifactIndexState[] | null = null;
const upsertedContent: string[] = [];

vi.mock("../../src/services/embeddings.js", () => ({
  generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  prepareDocumentText: vi.fn((content: string, filePath: string) =>
    `search_document: ${filePath}\n${content}`,
  ),
}));

vi.mock("../../src/services/qdrant.js", () => ({
  deleteArtifactChunks: vi.fn(async () => undefined),
  deleteCollection: vi.fn(async () => undefined),
  deleteContextMetadata: vi.fn(async () => undefined),
  ensureCollection: vi.fn(async () => undefined),
  ensurePayloadIndex: vi.fn(async () => undefined),
  getCollectionInfo: vi.fn(async () => ({ pointsCount: 1 })),
  loadContextMetadata: vi.fn(async () => existingMetadata),
  saveContextMetadata: vi.fn(async (
    _collection: string,
    _projectPath: string,
    artifacts: ArtifactIndexState[],
  ) => {
    existingMetadata = [...artifacts];
  }),
  searchChunks: vi.fn(async () => []),
  searchChunksWithFilter: vi.fn(async () => []),
  upsertPreEmbeddedChunks: vi.fn(async (_collection: string, points: Array<{ payload: Record<string, unknown> }>) => {
    for (const p of points) upsertedContent.push(String(p.payload.content));
    return { pointsSkipped: 0 };
  }),
}));

const { ensureArtifactsIndexed, indexArtifact, readArtifactContent } = await import(
  "../../src/services/context-artifacts.js"
);

beforeAll(async () => {
  rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-preread-"));
});

afterAll(async () => {
  await fsp.rm(rootDir, { recursive: true, force: true });
});

let caseIndex = 0;

beforeEach(() => {
  caseIndex += 1;
  existingMetadata = null;
  upsertedContent.length = 0;
});

async function createProject(files: Record<string, string>): Promise<string> {
  const projectDir = path.join(rootDir, `case-${caseIndex}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(projectDir, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
  }
  return projectDir;
}

describe("indexArtifact preread content", () => {
  it("indexes the content it was handed instead of re-reading the artifact", async () => {
    const projectDir = await createProject({ "notes.md": "ON_DISK_MARKER" });

    // Deliberately not what is on disk. If indexArtifact re-read the file, the
    // disk text would reach Qdrant and this assertion would catch it.
    const preread = {
      content: "HANDED_IN_MARKER",
      contentHash: "0123456789abcdef",
      exclusions: { ignored: 0, binary: 0, unreadable: 0 },
    };

    const state = await indexArtifact(
      projectDir,
      { name: "notes", path: "./notes.md", description: "Notes" },
      "context_test",
      preread,
    );

    expect(upsertedContent.join("\n")).toContain("HANDED_IN_MARKER");
    expect(upsertedContent.join("\n")).not.toContain("ON_DISK_MARKER");
    expect(state.contentHash).toBe("0123456789abcdef");
  });

  it("still reads for itself when handed nothing", async () => {
    const projectDir = await createProject({ "notes.md": "ON_DISK_MARKER" });

    const state = await indexArtifact(
      projectDir,
      { name: "notes", path: "./notes.md", description: "Notes" },
      "context_test",
    );

    expect(upsertedContent.join("\n")).toContain("ON_DISK_MARKER");
    const onDisk = await readArtifactContent("./notes.md", projectDir);
    expect(state.contentHash).toBe(onDisk.contentHash);
  });
});

describe("ensureArtifactsIndexed threading", () => {
  it("indexes exactly the content it hashed for the staleness check", async () => {
    const projectDir = await createProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [{ name: "deploy", path: "./deploy", description: "Manifests" }],
      }),
      "deploy/service.yaml": "kind: Service",
      "deploy/__pycache__/stale.txt": "PYCACHE_MARKER",
    });

    const { reindexed, errors } = await ensureArtifactsIndexed(projectDir);

    expect(errors).toHaveLength(0);
    expect(reindexed).toEqual(["deploy"]);

    const indexed = upsertedContent.join("\n");
    expect(indexed).toContain("kind: Service");
    // The exclusions applied during the staleness read carry through to what is
    // indexed — the two cannot disagree, because there is only one read.
    expect(indexed).not.toContain("PYCACHE_MARKER");

    const onDisk = await readArtifactContent("./deploy", projectDir);
    expect(existingMetadata?.[0].contentHash).toBe(onDisk.contentHash);
  });

  it("leaves an unchanged artifact alone", async () => {
    const projectDir = await createProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [{ name: "deploy", path: "./deploy", description: "Manifests" }],
      }),
      "deploy/service.yaml": "kind: Service",
    });

    expect((await ensureArtifactsIndexed(projectDir)).reindexed).toEqual(["deploy"]);
    upsertedContent.length = 0;

    const second = await ensureArtifactsIndexed(projectDir);
    expect(second.reindexed).toEqual([]);
    expect(second.upToDate).toEqual(["deploy"]);
    expect(upsertedContent).toHaveLength(0);
  });
});
