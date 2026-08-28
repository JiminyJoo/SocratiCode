// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodeGraph, ensureDynamicLanguages } from "../../src/services/code-graph.js";

// Every other test on the Rust graph builds a tree and asserts what we believe
// is right. That is how two regressions reached `main`: our belief was wrong in
// the same way on both sides of the assertion. This one asks the compiler
// instead — it builds a crate, runs `cargo check`, and takes the dep-info cargo
// leaves behind (`target/debug/deps/*.d`) as the list of sources rustc actually
// opened. A file rustc read that our graph never reaches is a defect, whatever
// our fixtures say.
//
// The crate is deliberately dependency-free so the check needs no network, and
// it carries the shapes that were broken: a `mod` written inside a macro body,
// a `#[cfg_attr(…, path = …)]` relocation, and a module named `env` — the name
// the ignore list used to delete at any depth.

function haveCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The sources rustc opened, per cargo's own dep-info, relative to the crate. */
function sourcesRustcRead(root: string): Set<string> {
  const deps = path.join(root, "target", "debug", "deps");
  const read = new Set<string>();
  for (const name of fs.readdirSync(deps)) {
    if (!name.endsWith(".d")) continue;
    for (const line of fs.readFileSync(path.join(deps, name), "utf8").split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      for (const raw of line.slice(colon + 1).trim().split(/\s+/)) {
        if (!raw.endsWith(".rs")) continue;
        const rel = path.relative(root, path.resolve(root, raw));
        if (!rel || rel.startsWith("..") || rel.startsWith("target/")) continue;
        read.add(rel);
      }
    }
  }
  return read;
}

const write = (root: string, rel: string, body: string): void => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

// The condition is in the name because a skip is silent otherwise: vitest
// prints the title and nothing about why, and a suite that quietly stops
// running reads exactly like a suite that passes. In CI it cannot skip — the
// `rust-graph-vs-cargo` job checks `rustc --version` before it gets here.
describe.skipIf(!haveCargo())("the Rust graph against cargo's dep-info (needs cargo on PATH)", () => {
  let root: string;
  let read: Set<string>;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-cargo-"));

    write(root, "Cargo.toml", ['[package]', 'name = "oracle"', 'version = "0.1.0"', 'edition = "2021"', "", "[dependencies]", ""].join("\n"));

    // A macro body is not a module level: it opens no scope, so `mod plain;`
    // written inside one still resolves next to the file that wrote it.
    write(
      root,
      "src/lib.rs",
      [
        "macro_rules! declare {",
        "    ($($item:item)*) => { $($item)* };",
        "}",
        "",
        "declare! {",
        "    mod hidden;",
        "}",
        "",
        "#[cfg_attr(unix, path = \"under_unix.rs\")]",
        "#[cfg_attr(windows, path = \"under_windows.rs\")]",
        "mod platform;",
        "",
        "pub mod env;",
        "",
        "include!(\"pasted.rs\");",
        "",
        "pub fn all() -> u32 {",
        "    hidden::value() + platform::value() + env::value() + pasted()",
        "}",
        "",
      ].join("\n"),
    );

    write(root, "src/hidden.rs", "pub fn value() -> u32 {\n    1\n}\n");
    write(root, "src/under_unix.rs", "pub fn value() -> u32 {\n    2\n}\n");
    write(root, "src/under_windows.rs", "pub fn value() -> u32 {\n    2\n}\n");
    write(root, "src/env/mod.rs", "pub fn value() -> u32 {\n    3\n}\n");
    // Pasted rather than declared: `pasted()` is called unqualified from
    // `lib.rs` above, which only compiles because `include!` puts it there.
    write(root, "src/pasted.rs", "fn pasted() -> u32 {\n    4\n}\n");

    // `--offline` because the crate declares no dependencies: nothing here
    // should ever reach the network, and asking for it makes that a failure
    // instead of a slow success.
    try {
      execFileSync("cargo", ["check", "--offline", "--quiet"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (err) {
      // Without this the failure surfaces as a bare non-zero exit from
      // `beforeAll`, which says nothing about the crate that would not build —
      // and the whole oracle rests on that build.
      const details = err instanceof Error && "stderr" in err ? String(err.stderr) : String(err);
      throw new Error(`the fixture crate did not compile, so there is no oracle:\n${details}`);
    }

    read = sourcesRustcRead(root);
  }, 180_000);

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("reads a dep-info that names the files rustc opened", () => {
    // Guards the oracle itself: a half-written dep-info would let every
    // assertion below pass by having nothing to check.
    expect(read.has("src/lib.rs")).toBe(true);
    expect(read.has("src/hidden.rs")).toBe(true);
    expect(read.size).toBeGreaterThanOrEqual(4);
  });

  it("reaches every source rustc read, walking from the crate root", async () => {
    const graph = await buildCodeGraph(root);
    const outgoing = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const from = outgoing.get(edge.source);
      if (from) from.push(edge.target);
      else outgoing.set(edge.source, [edge.target]);
    }

    const seen = new Set<string>(["src/lib.rs"]);
    const queue = ["src/lib.rs"];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      for (const next of outgoing.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    const missed = [...read].filter((f) => !seen.has(f)).sort();
    expect(missed).toEqual([]);
  });

  it("draws no edge into a file rustc never opened, apart from the other cfg arm", async () => {
    const graph = await buildCodeGraph(root);
    // The graph fixes no target, so it draws both arms of the `cfg_attr` — the
    // arm this platform does not build is expected and is the only one.
    const otherArm = process.platform === "win32" ? "src/under_unix.rs" : "src/under_windows.rs";
    const strangers = graph.edges
      .map((e) => e.target)
      .filter((t) => t.endsWith(".rs") && !read.has(t) && t !== otherArm);
    expect([...new Set(strangers)]).toEqual([]);
  });
});
