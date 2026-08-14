// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Support facts this module encodes (each verified by running the client
 * against a live Qdrant on the real Node majors):
 *
 *   - @qdrant/js-client-rest < 1.19 bundles undici 6, whose Agent the client
 *     hands to Node's built-in fetch. Node 26's built-in fetch (undici 8)
 *     renamed the legacy `onError` handler hook, so the v6 Agent fails
 *     validation and every request dies with
 *     `UND_ERR_INVALID_ARG: invalid onError method`.
 *   - 1.19+ bundles undici 7 and works on Node 26+
 *     (https://github.com/qdrant/qdrant-js/issues/134, fixed in 1.19).
 *
 * So "does this process break?" is a property of the PAIR (node major,
 * installed client version), not of the Node version alone. The startup
 * guard in index.ts uses these helpers to refuse only the pair that
 * actually breaks.
 */

const QDRANT_CLIENT_PACKAGE = "@qdrant/js-client-rest";

/**
 * Version of the installed @qdrant/js-client-rest, or null when it cannot
 * be determined.
 *
 * The package's `exports` map exposes only `.`, so
 * `require("@qdrant/js-client-rest/package.json")` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED; instead the entry file is resolved and the
 * walk goes upward to the nearest package.json that declares the package's
 * own name (the entry sits inside dist/, whose parent directories may hold
 * unrelated package.json files, hence the name check).
 */
export function readInstalledQdrantClientVersion(): string | null {
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve(QDRANT_CLIENT_PACKAGE);
  } catch {
    return null; // not installed / not resolvable from here
  }
  let dir = path.dirname(entry);
  // Walk toward the filesystem root; the package root is at most a few
  // levels above the entry file.
  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (parsed?.name === QDRANT_CLIENT_PACKAGE && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // no package.json at this level (or unreadable/malformed) — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Whether the (node major, installed client version) pair is the one that
 * breaks: Node 26+ with a client older than 1.19.
 *
 * An undeterminable version on Node 26+ refuses too (returns true): the
 * alternative is booting into a possibly-broken client whose first request
 * dies with an opaque undici error, which is exactly what the guard exists
 * to prevent. On Node < 26 the client version is irrelevant.
 */
export function qdrantClientBreaksOnThisNode(
  nodeMajor: number,
  clientVersion: string | null,
): boolean {
  if (!Number.isFinite(nodeMajor) || nodeMajor < 26) return false;
  if (clientVersion === null) return true;
  // Full semver shape required (prerelease/build tags allowed): a partial
  // match like `1.19.not-a-version` is NOT a version the registry could
  // have served, so it fails closed with every other unparseable string
  // rather than being half-read as a 1.19.
  const match = clientVersion.match(/^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/);
  if (!match) return true;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  return major < 1 || (major === 1 && minor < 19);
}
