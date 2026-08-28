// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { logger } from "./logger.js";

const DEFAULT_IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "__pycache__",
  "*.pyc",
  ".venv",
  // Anchored, unlike the rest: `venv` and `env` are a virtualenv's names at the
  // root of a project, and ordinary module names anywhere below it. Unanchored
  // they matched at any depth and quietly deleted source — `clap_complete/src/env/`
  // is compiled by cargo and listed in its dep-info, yet was not even a node of
  // the graph, while `pub mod engine;` two lines above it drew its edges; the
  // same for `tracing-subscriber/src/filter/env/`. In a 245-crate registry
  // sample they are the only two, which is the point: the loss is total for the
  // crate it hits and invisible everywhere else.
  //
  // A virtualenv nested deeper stays out by the two routes that already cover
  // it: `.venv`, the common spelling, is still matched at any depth, and a
  // checked-in project lists its own in `.gitignore`, which this filter reads.
  "/venv",
  "/env",
  ".tox",
  "target",
  "_build",
  "deps",
  "bin/Debug",
  "bin/Release",
  "obj",
  ".gradle",
  ".idea",
  ".vscode",
  ".vs",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "*.log",
  "*.tmp",
  "*.swp",
  "*.swo",
  ".DS_Store",
  "Thumbs.db",
  "coverage",
  ".nyc_output",
  ".cache",
  ".parcel-cache",
  ".turbo",
  "vendor",
  ".dart_tool",
];

/**
 * Build an ignore filter for a project directory.
 *
 * Combines (in order):
 *   1. Built-in defaults (node_modules, .git, dist, build, lock files, etc.)
 *   2. .gitignore files (root + nested) — unless RESPECT_GITIGNORE=false
 *   3. .socraticodeignore — optional project-specific exclusions
 *
 * Set env RESPECT_GITIGNORE=false to skip .gitignore processing entirely.
 *
 * The two status lines below log at debug, not info: context-artifact reads
 * build a filter per artifact on every staleness check, so an info line here
 * would fire once per artifact per context search.
 */
export function createIgnoreFilter(projectPath: string): Ignore {
  const ig = ignore();

  // Default patterns
  ig.add(DEFAULT_IGNORE_PATTERNS);

  // .gitignore (unless explicitly disabled)
  const respectGitignore = (process.env.RESPECT_GITIGNORE ?? "true").toLowerCase() !== "false";

  if (respectGitignore) {
    // Root .gitignore
    const rootGitignore = path.join(projectPath, ".gitignore");
    if (fs.existsSync(rootGitignore)) {
      const content = fs.readFileSync(rootGitignore, "utf-8");
      ig.add(content);
    }
  } else {
    logger.debug("Skipping .gitignore processing (RESPECT_GITIGNORE=false)");
  }

  // The same walk finds the nested .gitignore files and the virtualenvs, and it
  // runs whether or not .gitignore is respected: a virtualenv is not a project
  // preference, it is a directory of installed libraries that no reading of the
  // tree should call source.
  scanNestedIgnoreSources(projectPath, projectPath, ig, respectGitignore);

  // .socraticodeignore
  const socraticodeignorePath = path.join(projectPath, ".socraticodeignore");

  if (fs.existsSync(socraticodeignorePath)) {
    const content = fs.readFileSync(socraticodeignorePath, "utf-8");
    ig.add(content);
    logger.debug("Loaded .socraticodeignore rules");
  }

  return ig;
}

/**
 * A literal path as a gitignore pattern that matches it and nothing else.
 *
 * The syntax reads `*`, `?` and `[` as wildcards, so a directory honestly named
 * `env[3]` became a character class and matched none of its own files. A
 * leading `!` or `#` changes what the whole line means, and both are legal in a
 * directory name.
 */
function escapeIgnorePattern(literal: string): string {
  return literal.replace(/[[\]*?\\!#]/g, (character) => `\\${character}`);
}

/**
 * What the path is, or null when the question cannot be answered.
 *
 * The `throwIfNoEntry` option only covers a missing entry; an unreadable parent
 * directory still throws EACCES, and the `existsSync` this replaced threw for
 * nothing at all. A marker we cannot stat is simply not a marker.
 */
function statOrNull(candidate: string): fs.Stats | null {
  try {
    return fs.statSync(candidate, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/** Whether the path is a file, answering false for a directory or nothing. */
function isFile(candidate: string): boolean {
  return statOrNull(candidate)?.isFile() ?? false;
}

/** Whether the path is a directory, answering false for a file or nothing. */
function isDirectory(candidate: string): boolean {
  return statOrNull(candidate)?.isDirectory() ?? false;
}

/**
 * Walk the subdirectories once, collecting what the tree itself says should be
 * ignored: the rules of every nested .gitignore, and every environment
 * directory holding installed libraries.
 *
 * A virtualenv is recognised by the `pyvenv.cfg` PEP 405 puts at its root, not
 * by its directory's name. The name alone cannot do it: `venv` and `env` are
 * also ordinary module names, and matching them at any depth deleted real
 * source — `clap_complete/src/env/`, which cargo compiles, was not even a node.
 * They are matched at the project root only now, and the proof covers what that
 * anchoring gives up: a virtualenv nested deeper, whatever it is called.
 *
 * The extra cost is one `existsSync` per directory visited, in a walk that was
 * already making one for `.gitignore`.
 */
function scanNestedIgnoreSources(
  rootPath: string,
  currentPath: string,
  ig: Ignore,
  readGitignores: boolean,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirName = entry.name;
    const dirPath = path.join(currentPath, dirName);

    // Checked before the skip list below, which would otherwise walk past a
    // `venv/` without ever looking inside it.
    //
    // Two markers, because two tools build these directories: `pyvenv.cfg` for
    // a PEP 405 virtualenv, `conda-meta/` for a conda environment. Both hold
    // installed libraries and neither is source.
    //
    // Each marker is checked in the shape its tool actually writes — a file for
    // one, a directory for the other. Merely existing is not enough: a source
    // directory holding a file named `conda-meta` would otherwise disappear
    // whole, and a discarded source file costs far more than a kept one.
    if (isFile(path.join(dirPath, "pyvenv.cfg")) || isDirectory(path.join(dirPath, "conda-meta"))) {
      const relDir = path.relative(rootPath, dirPath).split(path.sep).join("/");
      // Anchored with a leading slash, because a gitignore pattern carrying no
      // slash of its own matches that name at **every** depth. An environment
      // sitting directly under the root produces exactly such a pattern — its
      // relative path is a bare name — so a root-level `toolbox/` was deleting
      // `packages/app/toolbox/` too, in any language.
      //
      // It also undid this file's own reason for existing: with a root-level
      // `env/` present, the pattern `env/` came back and excluded
      // `clap_complete/src/env/mod.rs` again, which is the case the anchoring
      // of the defaults above was written to keep. Verified against the
      // installed `ignore` package: `env/` matches that path, `/env/` does not,
      // and both still catch `env/lib/dep.py` at the root.
      if (relDir) ig.add(`/${escapeIgnorePattern(relDir)}/`);
      continue;
    }

    // Skip directories we know should be ignored.
    //
    // `venv` is not among them by name any more, and that is the same decision
    // as anchoring the default patterns rather than a separate one. Skipping it
    // wherever it stood stopped this walk at any directory so called, so it never reached
    // the marker of a real environment nested under one:
    // `crates/venv/backend/env/` had its installed libraries indexed, because
    // the walk turned back two levels above the `pyvenv.cfg` that would have
    // excluded them, and a nested `.gitignore` below it stopped being read.
    //
    // `.venv` stays: the default patterns ignore that spelling at every depth,
    // so descending into it would look for a marker in a directory already
    // gone. The same argument holds for `venv` and `env` directly under the
    // root, which `/venv` and `/env` above already exclude — a virtualenv old
    // enough to have written no `pyvenv.cfg` would otherwise be walked to its
    // `site-packages` reading `.gitignore` files for nothing. Only at the root:
    // one level down those names are ordinary modules again.
    if (dirName === "node_modules" || dirName === ".git" || dirName === ".svn" ||
        dirName === ".hg" || dirName === "dist" || dirName === "build" ||
        dirName === "__pycache__" || dirName === ".venv" ||
        dirName === "target" || dirName === ".gradle" || dirName === ".next" ||
        (currentPath === rootPath && (dirName === "venv" || dirName === "env"))) {
      continue;
    }

    const gitignorePath = path.join(dirPath, ".gitignore");

    if (readGitignores && fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      const relDir = path.relative(rootPath, dirPath).split(path.sep).join("/");

      // Prefix each pattern with the relative directory
      const lines = content.split("\n");
      const prefixedPatterns: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        // Handle negation patterns
        if (trimmed.startsWith("!")) {
          prefixedPatterns.push(`!${relDir}/${trimmed.slice(1)}`);
        } else {
          prefixedPatterns.push(`${relDir}/${trimmed}`);
        }
      }

      if (prefixedPatterns.length > 0) {
        ig.add(prefixedPatterns);
      }
    }

    // Recurse into subdirectory
    scanNestedIgnoreSources(rootPath, dirPath, ig, readGitignores);
  }
}

/**
 * Check if a relative path should be ignored.
 */
export function shouldIgnore(ig: Ignore, relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return ig.ignores(normalized);
}
