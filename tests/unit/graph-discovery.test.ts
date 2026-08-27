// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCodeGraph, ensureDynamicLanguages, getGraphableFiles } from "../../src/services/code-graph.js";
import { logger } from "../../src/services/logger.js";
import { canTestPermissionDenied } from "../helpers/fixtures.js";

// Regression for the whitelist .gitignore discovery fix: a `/*` then `!/src/`
// pattern ignores everything at the root but re-includes `src/`. The old walk
// passed `src` (no trailing slash) to shouldIgnore, which `/*` matched, so the
// walk bailed and produced an empty graph. Passing `src/` lets it descend and
// the files under the re-included directory are actually picked up.
describe("getGraphableFiles — whitelist .gitignore", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-discovery-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "/*\n!/src/\n");
    fs.writeFileSync(
      path.join(root, "src", "mod.lua"),
      "local function f()\n  return 1\nend\nreturn f\n",
    );
    // A root-level file the `/*` pattern should keep ignored.
    fs.writeFileSync(path.join(root, "ignored.lua"), "return 1\n");
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("descends into re-included src/ and discovers its files", async () => {
    const { files } = await getGraphableFiles(root);
    expect(files).toContain("src/mod.lua");
    // The `/*` pattern still ignores top-level entries that are not re-included.
    expect(files).not.toContain("ignored.lua");
  });
});

describe("getGraphableFiles / buildCodeGraph — extensionless", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-graph-extless-"));
    // No-shebang Python (waf wscript) — grammar-bearing → graph-eligible.
    fs.writeFileSync(
      path.join(root, "wscript"),
      "def configure(conf):\n    return 1\n\ndef build(bld):\n    return configure(bld)\n",
    );
    // perl shebang → detected as .txt → grammar-less → NOT in graph.
    fs.writeFileSync(path.join(root, "helper"), "#!/usr/bin/perl\nprint 1;\n");
    // Non-code extensionless → not in graph.
    fs.writeFileSync(path.join(root, "NOTICE"), "All rights reserved.\n");
    // SPECIAL_FILE with a shell recipe: must NOT be content-detected into the
    // graph as a shell node (handled by name elsewhere).
    fs.writeFileSync(
      path.join(root, "Makefile"),
      "build:\n\tset -euo pipefail\n\tif [ -f foo ]; then \\\n\t\techo yes; \\\n\tfi\n",
    );
    // Extensionless dotfile with shell content: sniffs to .sh, but the index
    // (glob dot:false) never sees it, so the graph must skip it too.
    fs.writeFileSync(
      path.join(root, ".profile"),
      'set -eu\nif [ -d "$HOME/bin" ]; then\n  export PATH="$HOME/bin"\nfi\n',
    );
    // Extensioned file: admitted by extension alone, so detection never runs and
    // it must carry no detectedExts entry.
    fs.writeFileSync(path.join(root, "mod.py"), "def f():\n    return 1\n");
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("includes grammar-bearing extensionless files, excludes .txt-detected and non-code", async () => {
    const { files } = await getGraphableFiles(root);
    expect(files).toContain("wscript");
    expect(files).not.toContain("helper"); // .txt — grammar-less, stays out of graph
    expect(files).not.toContain("NOTICE");
    expect(files).not.toContain("Makefile"); // SPECIAL_FILE — never content-detected
    expect(files).not.toContain(".profile"); // extensionless dotfile — matches index dot:false policy
  });

  it("excludes all extensionless files when INDEX_EXTENSIONLESS=false", async () => {
    vi.stubEnv("INDEX_EXTENSIONLESS", "false");
    try {
      const { files } = await getGraphableFiles(root);
      expect(files).not.toContain("wscript");
      expect(files).not.toContain("helper");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("includes a detected extensionless dotfile when INCLUDE_DOT_FILES=true", async () => {
    vi.stubEnv("INCLUDE_DOT_FILES", "true");
    try {
      const { files } = await getGraphableFiles(root);
      expect(files).toContain(".profile"); // shell dotfile now admitted (matches the index)
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("extracts symbols for a detected extensionless Python file", async () => {
    const graph = await buildCodeGraph(root);
    const symbols = graph.symbolsByFile.get("wscript");
    expect(symbols).toBeDefined();
    expect((symbols ?? []).map((s) => s.name)).toEqual(expect.arrayContaining(["configure", "build"]));
  });

  it("carries the discovery-detected extension for admitted extensionless files", async () => {
    const { files, detectedExts } = await getGraphableFiles(root);
    expect(files).toContain("wscript");
    expect(detectedExts.get("wscript")).toBe(".py");
    // Extensioned files are admitted by extension, so detection never ran.
    expect(files).toContain("mod.py");
    expect(detectedExts.has("mod.py")).toBe(false);
    // Rejected extensionless files carry no entry either.
    expect(detectedExts.has("NOTICE")).toBe(false);
  });

  it("returns files in lexicographic order", async () => {
    // wscript is written before mod.py above, so this fails on a filesystem that
    // yields creation order. Where readdir is already sorted it cannot fail —
    // the interleaving test below is the one that pins the sort on those.
    const { files } = await getGraphableFiles(root);
    expect(files).toEqual(["mod.py", "wscript"]);
  });
});

// The half of the sort's job that is observable on every filesystem, sorted
// readdir included: a depth-first walk yields a directory's contents before the
// sibling entries that sort after it, because "/" (0x2F) sorts after "." (0x2E).
// So the raw traversal order is not lexicographic even when each readdir is.
describe("getGraphableFiles — depth-first interleaving", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-discovery-order-"));
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    fs.writeFileSync(path.join(root, "a", "x.py"), "def x():\n    return 1\n");
    fs.writeFileSync(path.join(root, "a.py"), "def y():\n    return 2\n");
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("puts a.py before a/x.py, the opposite of what the walk yields", async () => {
    const { files } = await getGraphableFiles(root);
    expect(files).toEqual(["a.py", "a/x.py"]);
  });
});

// A directory the walk cannot read takes its whole subtree out of the file list
// before any of those files has a path to report, so they never reach the build
// loop's skip accounting. The log is the only trace, which is what this pins.
describe("getGraphableFiles — unreadable directory", () => {
  let root: string;
  let locked: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-discovery-eacces-"));
    fs.writeFileSync(path.join(root, "top.py"), "def a():\n    return 1\n");
    locked = path.join(root, "locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "hidden.py"), "def b():\n    return 2\n");
  });

  afterAll(() => {
    try {
      fs.chmodSync(locked, 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it.skipIf(!canTestPermissionDenied)(
    "logs the directory and omits its subtree",
    async () => {
      const debug = vi.spyOn(logger, "debug");
      fs.chmodSync(locked, 0o000);
      try {
        const { files } = await getGraphableFiles(root);

        expect(files).toEqual(["top.py"]);
        expect(debug).toHaveBeenCalledWith(
          "Could not read directory in graph discovery (subtree omitted)",
          expect.objectContaining({ dir: "locked", error: expect.stringContaining("EACCES") }),
        );
      } finally {
        fs.chmodSync(locked, 0o755);
        debug.mockRestore();
      }
    },
  );
});

// Sorting discovery output also settles buildJvmSuffixMap's tie-break for a class
// path that two modules both provide: it keeps the first path it sees, so the
// winner is the lexicographically first module rather than whichever the walk
// reached first. "mod-b/…" sorts before "mod/…" ("-" 0x2D < "/" 0x2F) while the
// walk descends "mod" first, so the two orders disagree on this fixture.
describe("buildCodeGraph — duplicate JVM class path tie-break", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-jvm-tiebreak-"));
    for (const module of ["mod", "mod-b"]) {
      const dir = path.join(root, module, "src", "main", "java", "com", "example");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "Foo.java"), "package com.example;\n\npublic class Foo {}\n");
    }
    const appDir = path.join(root, "app", "src", "main", "java", "com", "other");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "App.java"),
      "package com.other;\n\nimport com.example.Foo;\n\npublic class App {}\n",
    );
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("resolves a duplicated class to the lexicographically first module", async () => {
    const graph = await buildCodeGraph(root);
    const app = graph.nodes.find(
      (n) => n.relativePath === "app/src/main/java/com/other/App.java",
    );
    expect(app?.dependencies).toEqual(["mod-b/src/main/java/com/example/Foo.java"]);
  });
});

// ── Go module resolution through the real pipeline (#45 root + #82 nested) ─
// These drive the actual getGraphableFiles → buildCodeGraph path, where
// go.mod is NOT part of the graphable file set (it has no AST grammar).
// The first #82 attempt scanned the file set for go.mod and so produced 0
// edges for EVERY Go project — root or nested — while its hand-built unit
// tests stayed green. These end-to-end checks fail under that approach.
function writeLayout(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-go-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe("buildCodeGraph — Go module resolution (issues #45 & #82)", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const r of roots) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // Confirms getGraphableFiles admits the .go files (it does) and that
  // buildCodeGraph then builds Go edges — independent of any unit test's
  // hand-built file set.
  async function buildGraph(layout: Record<string, string>): Promise<ReturnType<typeof buildCodeGraph>> {
    const dir = writeLayout(layout);
    roots.push(dir);
    return buildCodeGraph(dir);
  }

  it("produces Go edges when go.mod is at the indexed root (#45 still works)", async () => {
    const graph = await buildGraph({
      "go.mod": "module github.com/example/myapp\n\ngo 1.22\n",
      "main.go": [
        "package main",
        "",
        "import \"github.com/example/myapp/internal/middleware\"",
        "",
        "func main() {",
        "\tif middleware.Authorize(\"admin\") {}",
        "}",
      ].join("\n"),
      "internal/middleware/auth.go": [
        "package middleware",
        "",
        "func Authorize(role string) bool { return role == \"admin\" }",
      ].join("\n"),
    });

    // The root-level module path resolves the import to a real file and an
    // edge is created. This is the #45 behavior that must not regress.
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(
      graph.edges.some(
        (e) => e.source === "main.go" && e.target === "internal/middleware/auth.go",
      ),
    ).toBe(true);
  });

  it("produces Go edges when go.mod is nested below the indexed root (#82)", async () => {
    // The exact monorepo shape from the issue: go.mod lives in `backend/`,
    // one level below the path passed to buildCodeGraph.
    const graph = await buildGraph({
      "docker-compose.yml": "services: {}\n",
      "frontend/src/app.ts": "export const x = 1;\n",
      "backend/go.mod": "module github.com/example/myapp-backend\n\ngo 1.22\n",
      "backend/internal/middleware/auth.go": [
        "package middleware",
        "",
        "func Authorize(role string) bool { return role == \"admin\" }",
      ].join("\n"),
      "backend/internal/service/user.go": [
        "package service",
        "",
        "import \"github.com/example/myapp-backend/internal/middleware\"",
        "",
        "func CanDeleteUser(role string) bool {",
        "\treturn middleware.Authorize(role)",
        "}",
      ].join("\n"),
      "backend/cmd/server/main.go": [
        "package main",
        "",
        "import (",
        "\t\"github.com/example/myapp-backend/internal/middleware\"",
        "\t\"github.com/example/myapp-backend/internal/service\"",
        ")",
        "",
        "func main() {",
        "\tif middleware.Authorize(\"admin\") {",
        "\t\t_ = service.CanDeleteUser(\"admin\")",
        "\t}",
        "}",
      ].join("\n"),
    });

    // Non-Go files are unaffected and still produce edges.
    expect(graph.edges.some((e) => e.source === "frontend/src/app.ts")).toBe(false);

    // The nested module is discovered from disk (go.mod is not graphable)
    // and both cross-package imports resolve to real edges.
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "backend/cmd/server/main.go" &&
          e.target === "backend/internal/middleware/auth.go",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "backend/internal/service/user.go" &&
          e.target === "backend/internal/middleware/auth.go",
      ),
    ).toBe(true);
  });

  it("resolves a nested module under a single-character dir `z/` (depth tie-break)", async () => {
    // Root module `github.com/example/root` + nested `github.com/example/z`
    // under `z/`. A string-length tie-break (`.` and `z` are both length 1)
    // can mis-attribute `z/` files to the root; directory depth must not.
    const graph = await buildGraph({
      "go.mod": "module github.com/example/root\n\ngo 1.22\n",
      "main.go": "package main\n\nfunc main() {}\n",
      "z/go.mod": "module github.com/example/z\n\ngo 1.22\n",
      "z/svc/bar.go": "package svc\n\nfunc Bar() {}\n",
      "z/caller/main.go": [
        "package main",
        "",
        "import \"github.com/example/z/svc\"",
        "",
        "func main() { _ = svc.Bar() }",
      ].join("\n"),
    });

    // The `z/` module owns its files (depth 1 > root depth 0), so the
    // import `github.com/example/z/svc` resolves to z/svc/bar.go and an edge
    // is created. Under the buggy string-length tie-break this would either
    // fail to resolve or attribute the edge to the root module.
    expect(
      graph.edges.some(
        (e) => e.source === "z/caller/main.go" && e.target === "z/svc/bar.go",
      ),
    ).toBe(true);
  });

  it("discovers a symlinked go.mod (no symlink regression vs the old single read)", async () => {
    // readdirSync Dirents don't follow symlinks: a symlinked go.mod reports
    // isFile()===false. The old root-level readFileSync DID follow it, so the
    // new tree walk must too — otherwise a root-level symlinked go.mod
    // regresses to 0 edges (PR #84 review).
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-go-symlink-src-"));
    roots.push(target);
    const realGoMod = path.join(target, "go.mod.real");
    fs.writeFileSync(realGoMod, "module github.com/example/symlinked\n\ngo 1.22\n");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-go-e2e-"));
    roots.push(dir);
    // go.mod is a symlink to a file OUTSIDE the indexed tree.
    fs.symlinkSync(realGoMod, path.join(dir, "go.mod"));
    fs.writeFileSync(
      path.join(dir, "main.go"),
      [
        "package main",
        "",
        'import "github.com/example/symlinked/internal/middleware"',
        "",
        'func main() { _ = middleware.Authorize("admin") }',
      ].join("\n"),
    );
    fs.mkdirSync(path.join(dir, "internal", "middleware"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "internal", "middleware", "auth.go"),
      [
        "package middleware",
        "",
        'func Authorize(role string) bool { return role == "admin" }',
      ].join("\n"),
    );

    const graph = await buildCodeGraph(dir);
    expect(
      graph.edges.some(
        (e) => e.source === "main.go" && e.target === "internal/middleware/auth.go",
      ),
    ).toBe(true);
  });

  it("ignores a stray go.mod under a default-ignored dir (build/) so it can't shadow the real module", async () => {
    // findGoModFiles reuses createIgnoreFilter; `build/` is in the default
    // skip list (and hard-skipped in findNestedGitignores). If discovery ever
    // bypassed the filter, the stray build/go.mod — declaring the SAME module
    // path as the root and alphabetically first — would win module selection
    // in resolveImport with an empty package map and silently drop every edge:
    // the same silent-zero-edge class #82 fixes. This case fails the moment
    // shouldIgnore is stubbed to a no-op.
    const graph = await buildGraph({
      "go.mod": "module github.com/example/myapp\n\ngo 1.22\n",
      "main.go": [
        "package main",
        "",
        'import "github.com/example/myapp/internal/middleware"',
        "",
        'func main() { _ = middleware.Authorize("admin") }',
      ].join("\n"),
      "internal/middleware/auth.go": [
        "package middleware",
        "",
        'func Authorize(role string) bool { return role == "admin" }',
      ].join("\n"),
      // Stray module under an ignored dir: same module path as the root, so it
      // would shadow the root module if discovery ever picked it up.
      "build/go.mod": "module github.com/example/myapp\n\ngo 1.22\n",
    });

    expect(
      graph.edges.some(
        (e) => e.source === "main.go" && e.target === "internal/middleware/auth.go",
      ),
    ).toBe(true);
  });
});

// ── Rust crate resolution through the real pipeline ───────────────────────
// Cargo.toml has no AST grammar, so it is never in the graphable file set —
// the same trap #82 documents for go.mod. These drive the real
// getGraphableFiles → buildCodeGraph path over a workspace laid out the way
// Cargo generates one, where every edge below was absent before crate roots
// were read.
describe("buildCodeGraph — Rust crate resolution", () => {
  const roots: string[] = [];
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;

  beforeAll(async () => {
    ensureDynamicLanguages();
    const dir = writeLayout({
      "Cargo.toml": '[workspace]\nmembers = ["crates/cli", "crates/core"]\n',

      "crates/core/Cargo.toml": '[package]\nname = "app-core"\nedition = "2021"\n',
      "crates/core/src/lib.rs": ["pub mod store;", "", "pub use store::Store;"].join("\n"),
      "crates/core/src/store.rs": [
        "mod open;",
        "mod support;",
        "",
        "pub struct Store;",
        "pub struct StoreError;",
      ].join("\n"),
      "crates/core/src/store/open.rs": [
        "use super::Store;",
        "mod detail;",
        "",
        "pub fn open() -> Store { Store }",
      ].join("\n"),
      "crates/core/src/store/support.rs": "pub fn helper() {}",
      // A test block two levels down: `super` inside it counts from the file,
      // so reaching `store::support` from here takes one climb more than the
      // file's own depth suggests.
      "crates/core/src/store/open/detail.rs": [
        "pub fn detail() {}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "    use super::*;",
        "    use super::super::super::support::helper;",
        "",
        "    #[test]",
        "    fn works() { detail(); helper(); }",
        "}",
      ].join("\n"),

      "crates/cli/Cargo.toml": '[package]\nname = "app-cli"\nedition = "2021"\n',
      "crates/cli/src/main.rs": [
        "mod runner;",
        "",
        "use app_core::{Store, store::StoreError};",
        "",
        "fn main() { runner::run(); }",
      ].join("\n"),
      "crates/cli/src/runner.rs": ["use serde::Deserialize;", "", "pub fn run() {}"].join("\n"),
    });
    roots.push(dir);
    graph = await buildCodeGraph(dir);
  });

  afterAll(() => {
    for (const r of roots) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  const edge = (source: string, target: string): boolean =>
    graph.edges.some((e) => e.source === source && e.target === target);

  it("follows a pub mod declaration", () => {
    expect(edge("crates/core/src/lib.rs", "crates/core/src/store.rs")).toBe(true);
  });

  it("follows super:: to a parent module living beside its directory", () => {
    expect(edge("crates/core/src/store/open.rs", "crates/core/src/store.rs")).toBe(true);
  });

  it("follows a path into a sibling crate by its Cargo name", () => {
    // `app_core::Store` is re-exported from the library root; the underscored
    // import name only reaches the dashed package because the manifest says so.
    expect(edge("crates/cli/src/main.rs", "crates/core/src/lib.rs")).toBe(true);
    // The group's other leaf names a module one level down, and lands there.
    expect(edge("crates/cli/src/main.rs", "crates/core/src/store.rs")).toBe(true);
  });

  it("follows a mod declaration inside a binary crate", () => {
    expect(edge("crates/cli/src/main.rs", "crates/cli/src/runner.rs")).toBe(true);
  });

  it("draws no edge into a crate for a third-party path", () => {
    // `runner.rs` imports `serde` and nothing else. Asserting that every edge
    // ends in a `.rs` file would hold on an empty set too — and did, while the
    // resolver was returning nothing at all; the edges leaving this one file
    // are what says a third-party path resolved to nothing.
    const leaving = graph.edges
      .filter((e) => e.source === "crates/cli/src/runner.rs")
      .map((e) => e.target);

    expect(leaving).toEqual([]);
  });

  it("draws no edge at the parent module for a test block's glob import", () => {
    // `use super::*;` inside `#[cfg(test)] mod tests` names the file it is
    // written in. Counted from the file instead, it lands on the parent
    // module and closes a cycle with the `mod detail;` pointing the other way.
    expect(edge("crates/core/src/store/open/detail.rs", "crates/core/src/store/open.rs")).toBe(
      false,
    );
  });

  it("counts the inline test module as a level a super:: path climbs", () => {
    expect(
      edge("crates/core/src/store/open/detail.rs", "crates/core/src/store/support.rs"),
    ).toBe(true);
  });
});
