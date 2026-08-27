// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { Lang, parse } from "@ast-grep/napi";
import { analyzeElixirTemplate, isElixirTemplateExtension } from "./elixir-templates.js";
import { logger } from "./logger.js";

// ── Import extraction per language ───────────────────────────────────────

export interface ImportInfo {
  moduleSpecifier: string; // The raw import string
  isDynamic: boolean;
  isCssImport?: boolean;   // True when extracted from a CSS/style context
}

/**
 * Per-language dedupe set for import-extraction failures. Without this, a
 * missing PHP grammar would emit one warn per file (potentially hundreds).
 * We log the first failure per language at warn level (with the underlying
 * error attached) and silently skip subsequent failures.
 */
const importExtractionWarned = new Set<string>();

/**
 * Reset the per-language dedupe set. Intended for tests that want to assert
 * deterministically on extraction warnings.
 */
export function resetImportExtractionWarnings(): void {
  importExtractionWarned.clear();
}

/** Extract CSS/SCSS/Stylus @import statements from raw style source text. */
function extractCssImports(source: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  // CSS/SCSS: @import "./foo.css"; @import url("./foo.css");
  for (const match of source.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?/gm)) {
    const spec = match[1];
    if (spec.startsWith("http://") || spec.startsWith("https://")) continue;
    imports.push({ moduleSpecifier: spec, isDynamic: false, isCssImport: true });
  }
  // Stylus: @require "foo" (quoted form only; bare-identifier syntax not supported)
  for (const match of source.matchAll(/@require\s+['"]([^'"]+)['"]/gm)) {
    const spec = match[1];
    if (spec.startsWith("http://") || spec.startsWith("https://")) continue;
    imports.push({ moduleSpecifier: spec, isDynamic: false, isCssImport: true });
  }
  return imports;
}

/**
 * Split a PHP `use` statement body on the commas that separate its clauses,
 * leaving the ones inside a `{…}` group alone.
 *
 * `use App\{User, Post}, Other\Thing;` is one declaration holding two clauses,
 * and the group's internal commas separate members of the first clause rather
 * than clauses of the statement. A plain `split(",")` cannot tell the two
 * apart, and matching only the first clause is what dropped every name after
 * the first comma.
 */
function splitPhpUseClauses(body: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      clauses.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  clauses.push(current);
  return clauses.map((clause) => clause.trim()).filter(Boolean);
}

/**
 * Every namespace path a PHP `use` declaration names.
 *
 * Handles the single (`use A\B;`), aliased (`use A\B as C;`), grouped
 * (`use A\{B, C};`) and comma-list (`use A\B, A\C;`) forms, with the
 * statement-level `function`/`const` modifiers stripped. A leading `\` on a
 * fully-qualified name is left on the specifier — the resolver strips it, so
 * `node.imports` keeps reporting what the source actually says.
 */
function phpUseSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const body = text.replace(/^use\s+(?:function\s+|const\s+)?/, "").replace(/;\s*$/, "");

  for (const clause of splitPhpUseClauses(body)) {
    // Grouped: A\B\{C, D as E, function f, const K}
    const group = clause.match(/^([\w\\]+)\\\{([^}]*)\}$/);
    if (group) {
      for (const member of group[2].split(",")) {
        // A group may carry `function`/`const` per member as well as at the
        // statement level — `use App\{function first, const MAX, User};` is one
        // declaration importing a function, a constant and a class. Left on,
        // the modifier became part of the name (`App\function first`), which
        // names nothing and loses the real one.
        const name = member
          .trim()
          .replace(/^(?:function|const)\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) specs.push(`${group[1]}\\${name}`);
      }
      continue;
    }
    // Single: A\B, \A\B, A\B as C
    const single = clause.match(/^([\w\\]+)/);
    if (single) specs.push(single[1].trim());
  }

  return specs;
}

/**
 * The path a PHP `require`/`include` names, or null when it names nothing
 * statically knowable.
 *
 * Two shapes are literal. A quoted path (`require './x.php'`) is taken as
 * written. `__DIR__ . '/x.php'` and its `dirname(__FILE__)` spelling are
 * compile-time constants naming the including file's own directory, so they
 * are equivalent to a source-relative path and are emitted as one — which is
 * what the resolver's relative branch already knows how to handle. This is
 * the dominant include idiom in WordPress and in any plugin-style tree that
 * predates Composer, and the previous regex could not match it: it required a
 * quote immediately after `require`/`(`, so the `__DIR__ .` prefix killed the
 * match and the statement produced no specifier at all.
 *
 * Anything else stays null rather than being guessed. `require ABSPATH .
 * '/x.php'` and `require $base . '/x.php'` depend on a value this pass cannot
 * know, and inventing a path from the literal tail alone would draw an edge to
 * a file the code may never include.
 *
 * Both patterns are anchored, because the text handed to them is one
 * include/require expression node rather than a whole statement — see
 * PHP_REQUIRE_KINDS.
 */
const PHP_REQUIRE_DIR_JOINED =
  /^(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__|dirname\s*\(\s*__FILE__\s*\))\s*\.\s*['"]([^'"]+)['"]/;
const PHP_REQUIRE_QUOTED =
  /^(?:require|include)(?:_once)?\s*[(]?\s*['"]([^'"]+)['"]/;

/**
 * The AST node kinds PHP's four include constructs produce.
 *
 * Matching these rather than scanning statement text is what keeps the pattern
 * off everything that merely reads like an include. The parser has already
 * decided what is code: a comment saying "does NOT include 'event'", a string
 * holding a Blade directive (`"@include('partials/card')"`), and a method
 * named after the construct (`$loader->require('x.php')`) produce no node here,
 * while `@include('x.php')` — the error-suppressed form, which is real — still
 * does. Scanning `expression_statement` text matched the first three and was
 * the source of every junk specifier this extractor produced.
 *
 * It also removes the need to enumerate the statements an include can sit in.
 * `return require __DIR__ . '/config.php';` is a return_statement and
 * `$c = include 'c.php';` an expression_statement; as expressions they are the
 * same node kind, so both are found without either being named.
 */
const PHP_REQUIRE_KINDS = [
  "require_expression",
  "require_once_expression",
  "include_expression",
  "include_once_expression",
];

function phpRequireSpecifier(text: string): string | null {
  const dirRelative = text.match(PHP_REQUIRE_DIR_JOINED);
  if (dirRelative) {
    // `__DIR__` is the directory itself, so the literal's leading separator is
    // a joiner rather than an absolute-path anchor. `./` makes the result
    // explicitly source-relative for the resolver; `__DIR__ . '/../lib/x.php'`
    // becomes `./../lib/x.php`, which normalizes to the parent directory.
    const rest = dirRelative[1].replace(/^\/+/, "");
    return rest ? `./${rest}` : null;
  }

  const quoted = text.match(PHP_REQUIRE_QUOTED);
  return quoted ? quoted[1] : null;
}

/** Extract JS/TS imports from an ast-grep root node. Shared by JS/TS and Svelte/Vue handlers. */
function extractJsTsImportsFromNode(sgNode: ReturnType<ReturnType<typeof parse>["root"]>): ImportInfo[] {
  const imports: ImportInfo[] = [];

  // import ... from "..."
  for (const node of sgNode.findAll({ rule: { kind: "import_statement" } })) {
    const sourceNode = node.find({ rule: { kind: "string" } });
    if (sourceNode) {
      const spec = sourceNode.text().replace(/['"]/g, "");
      imports.push({ moduleSpecifier: spec, isDynamic: false });
    }
  }
  // require("...")
  for (const node of sgNode.findAll({ rule: { kind: "call_expression" } })) {
    const text = node.text();
    const match = text.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (match) {
      imports.push({ moduleSpecifier: match[1], isDynamic: false });
    }
  }
  // dynamic import("...")
  for (const node of sgNode.findAll({ rule: { kind: "call_expression" } })) {
    const text = node.text();
    const match = text.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (match) {
      imports.push({ moduleSpecifier: match[1], isDynamic: true });
    }
  }
  // export ... from "..."
  for (const node of sgNode.findAll({ rule: { kind: "export_statement" } })) {
    const sourceNode = node.find({ rule: { kind: "string" } });
    if (sourceNode) {
      const spec = sourceNode.text().replace(/['"]/g, "");
      imports.push({ moduleSpecifier: spec, isDynamic: false });
    }
  }

  return imports;
}

/** Split a `use` group body on its top-level commas, ignoring nested groups. */
function splitRustUseList(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * The module a raw identifier names. `mod r#async;` declares the module
 * `async`, whose file rustc looks for as `async.rs` — the `r#` is how the
 * source escapes a keyword, not part of the name. Without stripping it, the
 * path `crate::r#async::poll` resolves to nothing and falls back to the crate
 * root, which draws an edge at the wrong file.
 */
function stripRawIdent(segment: string): string {
  return segment.startsWith("r#") ? segment.slice(2) : segment;
}

/**
 * One leaf of a `use` tree as a module path: the alias is dropped, and so are
 * trailing `self` and `*`, which name the module the path already reached
 * rather than something under it.
 */
function rustUseLeafPath(leaf: string): string {
  const segments = leaf
    .replace(/\s+as\s+(?:r#)?\w+\s*$/, "")
    .split("::")
    .map((segment) => stripRawIdent(segment.trim()))
    .filter(Boolean);
  while (segments.length > 0 && ["self", "*"].includes(segments[segments.length - 1])) {
    segments.pop();
  }
  return segments.join("::");
}

/**
 * Strip comments from a `use` declaration before its text is parsed as a path.
 *
 * A `use` tree may be spread over several lines with comments between the
 * leaves, and the text of the AST node carries them. Left in, they become path
 * segments: `crate::{ // note\n models::User }` yields the specifier
 * `crate::// note\n    models::User`, which names no module and falls back to
 * the crate root. A `use` holds no string literals, so removing comment spans
 * from the raw text is safe.
 */
function stripRustComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * The chain of inline `mod` blocks enclosing a node, outermost first.
 *
 * `mod tests { … }` opens a module without opening a file, so a path written
 * inside it is relative to a position one level below the file. The chain is
 * what lets that position be reconstructed; it is empty for the overwhelming
 * majority of declarations, which sit at the top of a file.
 */
function rustInlineModules(node: SgNodeLike): string[] {
  const chain: string[] = [];
  let current = node.parent();
  while (current) {
    if (current.kind() === "mod_item") {
      const name = current.field("name")?.text();
      if (name) chain.unshift(stripRawIdent(name));
    }
    current = current.parent();
  }
  return chain;
}

/** The subset of the ast-grep node API this module reads. */
interface SgNodeLike {
  kind(): string;
  text(): string;
  parent(): SgNodeLike | null;
  prev(): SgNodeLike | null;
  field(name: string): SgNodeLike | null;
}

/**
 * Rewrite a path written inside inline modules so it means the same thing when
 * read from the file's own position.
 *
 * `self` and `super` count module levels, and an inline `mod` is a level that
 * the file system does not show. `use super::open_store;` inside
 * `mod tests { … }` in `store/open.rs` names that very file — but counted from
 * the file it reads as the parent module, and an edge is drawn at
 * `store.rs`, which the source never imports. That edge also closes a cycle
 * with the `mod open;` declaration pointing the other way, and `#[cfg(test)]
 * mod tests` sits in a large share of all Rust files.
 *
 * Returns null when the path names the file itself, which is not an edge.
 * Paths anchored at `crate` are unaffected, and a bare head is left alone:
 * inside `mod tests`, `use some_crate::Thing;` is how a test reaches another
 * crate of the project, and rebasing it would lose that edge.
 */
function rustPathFromInline(path: string, inline: string[]): string | null {
  if (inline.length === 0) return path;
  const segments = path.split("::").filter(Boolean);
  if (segments.length === 0) return null;
  if (segments[0] === "crate") return path;

  let climbed = 0;
  let rest = segments;
  if (rest[0] === "self") {
    rest = rest.slice(1);
  } else {
    while (rest.length > 0 && rest[0] === "super") {
      climbed++;
      rest = rest.slice(1);
    }
    if (climbed === 0) return path;
  }

  // Each `super` first consumes an inline level; only what is left of the
  // climb reaches the file system.
  const remainingClimb = Math.max(0, climbed - inline.length);
  const prefix = inline.slice(0, Math.max(0, inline.length - climbed));
  if (remainingClimb > 0) {
    return [...Array(remainingClimb).fill("super"), ...rest].join("::");
  }
  const rebased = [...prefix, ...rest];
  return rebased.length === 0 ? null : ["self", ...rebased].join("::");
}

/**
 * The file a `#[path = "…"]` attribute points at, relative to the directory
 * the declaring file sits in — never to the directory that file's submodules
 * live in. Both `src/a/b.rs` and `src/a/mod.rs` resolve `#[path = "moved.rs"]`
 * to `src/a/moved.rs`.
 *
 * Attributes are siblings preceding the `mod` in the tree, and several may
 * stack (`#[cfg(test)]` above `#[path = …]`), so the walk goes back through
 * all of them.
 */
function rustPathAttribute(node: SgNodeLike): string | null {
  let previous = node.prev();
  while (previous?.kind() === "attribute_item") {
    const match = previous.text().match(/^#\[\s*path\s*=\s*"([^"]+)"\s*\]$/);
    if (match) return match[1];
    previous = previous.prev();
  }
  return null;
}

/**
 * Flatten one `use` tree into the module paths it names, one per leaf:
 *
 *   crate::config::Config     → ["crate::config::Config"]
 *   crate::{a::Thing, b}      → ["crate::a::Thing", "crate::b"]
 *   crate::a::{self, b as c}  → ["crate::a", "crate::a::b"]
 *   crate::a::*               → ["crate::a"]
 *
 * A braced group is not a module path and never resolved to one; recording the
 * leaves instead is what lets `use crate::{parser, printer}` draw an edge to
 * each of the two files rather than to their parent module — or, in a flat
 * crate with no parent module file, to nothing at all.
 */
export function expandRustUseTree(tree: string): string[] {
  const trimmed = tree.trim();
  if (!trimmed) return [];

  const open = trimmed.indexOf("{");
  if (open === -1) {
    const leaf = rustUseLeafPath(trimmed);
    return leaf ? [leaf] : [];
  }
  const close = trimmed.lastIndexOf("}");
  if (close < open) return [];

  const prefix = trimmed.slice(0, open).replace(/::\s*$/, "").trim();
  const paths: string[] = [];
  for (const part of splitRustUseList(trimmed.slice(open + 1, close))) {
    for (const expanded of expandRustUseTree(part)) {
      paths.push(prefix ? `${prefix}::${expanded}` : expanded);
    }
    // `self` and `*` expand to nothing, so the group's own prefix is what the
    // leaf named: `use crate::a::{self, b}` imports `crate::a` as well as
    // `crate::a::b`.
    if ((part === "self" || part === "*") && prefix) paths.push(prefix);
  }
  return paths;
}

/**
 * Extract import statements from source code using ast-grep.
 * Returns raw module specifiers for each language's import syntax.
 */
export function extractImports(source: string, lang: Lang | string, ext: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const langKey = String(lang);

  if (isElixirTemplateExtension(ext)) {
    const analysis = analyzeElixirTemplate(source, ext);
    if (!analysis) return imports;
    for (const moduleSpecifier of analysis.moduleReferences) {
      imports.push({ moduleSpecifier, isDynamic: false });
    }
    if (analysis.elixirSource) {
      for (const item of extractImports(analysis.elixirSource, "elixir", ".ex")) {
        if (!imports.some((existing) => existing.moduleSpecifier === item.moduleSpecifier)) imports.push(item);
      }
    }
    return imports;
  }

  // ── Regex-only extraction for languages without AST grammars ──────────
  if (langKey === "dart") {
    // import 'package:foo/bar.dart'; / import 'relative.dart'; / export '...'
    for (const match of source.matchAll(/^(?:import|export)\s+['"]([^'"]+)['"]/gm)) {
      imports.push({ moduleSpecifier: match[1], isDynamic: false });
    }
    // part 'src/model.dart';
    for (const match of source.matchAll(/^part\s+['"]([^'"]+)['"]/gm)) {
      imports.push({ moduleSpecifier: match[1], isDynamic: false });
    }
    return imports;
  }

  if (langKey === "lua") {
    // require("foo.bar") / require 'foo'
    for (const match of source.matchAll(/require\s*[(]?\s*['"]([^'"]+)['"]\s*[)]?/gm)) {
      imports.push({ moduleSpecifier: match[1], isDynamic: false });
    }
    // dofile("path.lua") / loadfile("path.lua")
    for (const match of source.matchAll(/(?:dofile|loadfile)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
      imports.push({ moduleSpecifier: match[1], isDynamic: false });
    }
    return imports;
  }

  // ── Svelte/Vue: parse as HTML, extract <script> blocks, re-parse as TS ──
  if (langKey === "svelte" || langKey === "vue") {
    try {
      const htmlRoot = parse(Lang.Html, source).root();
      const scriptElements = htmlRoot.findAll({ rule: { kind: "script_element" } });

      for (const scriptEl of scriptElements) {
        const rawText = scriptEl.find({ rule: { kind: "raw_text" } });
        if (!rawText) continue;

        const scriptContent = rawText.text();
        if (!scriptContent.trim()) continue;

        // Default to TypeScript (superset of JS, safe for both)
        const scriptRoot = parse(Lang.TypeScript, scriptContent).root();
        imports.push(...extractJsTsImportsFromNode(scriptRoot));
      }

      // Also extract CSS @import from <style> blocks
      const styleElements = htmlRoot.findAll({ rule: { kind: "style_element" } });
      for (const styleEl of styleElements) {
        const rawText = styleEl.find({ rule: { kind: "raw_text" } });
        if (rawText) imports.push(...extractCssImports(rawText.text()));
      }
    } catch (err) {
      logger.warn("Failed to parse Svelte/Vue file for imports", { error: String(err) });
    }
    return imports;
  }

  // ── AST-based extraction for languages with grammar support ───────────
  try {
    const sgNode = parse(lang, source).root();

    switch (langKey) {
      case "python": {
        // import foo / import foo.bar
        for (const node of sgNode.findAll({ rule: { kind: "import_statement" } })) {
          const text = node.text();
          const match = text.match(/^import\s+(.+)/);
          if (match) {
            for (const mod of match[1].split(",")) {
              const cleaned = mod.trim().split(/\s+as\s+/)[0].trim();
              if (cleaned) imports.push({ moduleSpecifier: cleaned, isDynamic: false });
            }
          }
        }
        // from foo import bar
        for (const node of sgNode.findAll({ rule: { kind: "import_from_statement" } })) {
          const text = node.text();
          const match = text.match(/^from\s+(\S+)\s+import/);
          if (match) {
            imports.push({ moduleSpecifier: match[1], isDynamic: false });
          }
        }
        break;
      }

      case "Css": {
        imports.push(...extractCssImports(source));
        break;
      }

      case "JavaScript":
      case "TypeScript":
      case "Tsx": {
        imports.push(...extractJsTsImportsFromNode(sgNode));
        break;
      }

      case "java": {
        // import com.example.Foo;
        for (const node of sgNode.findAll({ rule: { kind: "import_declaration" } })) {
          const text = node.text();
          const match = text.match(/^import\s+(?:static\s+)?([^;]+)/);
          if (match) {
            imports.push({ moduleSpecifier: match[1].trim(), isDynamic: false });
          }
        }
        break;
      }

      case "kotlin": {
        for (const node of sgNode.findAll({ rule: { kind: "import_header" } })) {
          const text = node.text();
          const match = text.match(/^import\s+(.+)/);
          if (match) {
            imports.push({ moduleSpecifier: match[1].trim(), isDynamic: false });
          }
        }
        break;
      }

      case "go": {
        // import "fmt" or import ("fmt"; "os")
        for (const node of sgNode.findAll({ rule: { kind: "import_spec" } })) {
          const pathNode = node.find({ rule: { kind: "interpreted_string_literal" } });
          if (pathNode) {
            const spec = pathNode.text().replace(/"/g, "");
            imports.push({ moduleSpecifier: spec, isDynamic: false });
          }
        }
        break;
      }

      case "rust": {
        // use std::collections::HashMap;  /  pub use crate::config::Config;
        //
        // A `use_declaration` node carries its visibility modifier, so the
        // optional `pub` / `pub(crate)` / `pub(in path)` prefix has to be
        // consumed here: without it every re-export in the tree was dropped
        // before reaching the resolver, and re-exports are how a Rust crate
        // publishes its own modules.
        for (const node of sgNode.findAll({ rule: { kind: "use_declaration" } })) {
          const text = stripRustComments(node.text());
          const match = text.match(/^(?:pub\s*(?:\([^)]*\)\s*)?)?use\s+([\s\S]+?)\s*;?\s*$/);
          if (!match) continue;
          const inline = rustInlineModules(node as unknown as SgNodeLike);
          for (const spec of expandRustUseTree(match[1])) {
            const fromInline = rustPathFromInline(spec, inline);
            if (fromInline) imports.push({ moduleSpecifier: fromInline, isDynamic: false });
          }
        }
        // mod foo;  /  pub mod foo;  /  pub(crate) mod foo;  /  mod r#async;
        for (const node of sgNode.findAll({ rule: { kind: "mod_item" } })) {
          // A body makes it a module definition, not a declaration pointing at
          // another file. Reading the field rather than looking for a brace in
          // the text keeps an attribute that happens to carry one out of it.
          if (node.field("body")) continue;
          const match = node
            .text()
            .match(/^(?:pub\s*(?:\([^)]*\)\s*)?)?mod\s+((?:r#)?\w+)\s*;/);
          if (!match) continue;
          const typed = node as unknown as SgNodeLike;
          // `#[path = "…"]` moves the file away from every convention, and only
          // the attribute says where. It travels as a path with its extension,
          // which no module path ever has, and the resolver reads it as one.
          const declaredPath = rustPathAttribute(typed);
          if (declaredPath) {
            imports.push({ moduleSpecifier: declaredPath, isDynamic: false });
            continue;
          }
          const inline = rustInlineModules(typed);
          const name = stripRawIdent(match[1]);
          // Declared inside `mod outer { … }`, the file sits under `outer/`,
          // not beside the declaring file.
          const spec = inline.length === 0 ? name : ["self", ...inline, name].join("::");
          imports.push({ moduleSpecifier: spec, isDynamic: false });
        }
        // extern crate serde;  /  #[macro_use] extern crate log as logging;
        //
        // The 2015 way of naming a dependency, still written today above a
        // `#[macro_use]`. The crate it names cannot collide with a local
        // module of the same name — rustc rejects that — so the bare name is
        // safe to resolve the way a `mod` declaration is.
        for (const node of sgNode.findAll({ rule: { kind: "extern_crate_declaration" } })) {
          const name = node.field("name")?.text();
          if (name && name !== "self") {
            imports.push({ moduleSpecifier: stripRawIdent(name), isDynamic: false });
          }
        }
        break;
      }

      case "csharp": {
        // using System.Collections;
        for (const node of sgNode.findAll({ rule: { kind: "using_directive" } })) {
          const text = node.text();
          // Skip using aliases: using Foo = Bar.Baz;
          if (text.match(/^using\s+\w+\s*=/)) continue;
          const match = text.match(/^using\s+(?:static\s+)?([^;=]+)/);
          if (match) {
            imports.push({ moduleSpecifier: match[1].trim(), isDynamic: false });
          }
        }
        break;
      }

      case "ruby": {
        // require "json" / require_relative "./helper"
        for (const node of sgNode.findAll({ rule: { kind: "call" } })) {
          const text = node.text();
          const reqMatch = text.match(/^require(?:_relative)?\s*[(]?\s*['"]([^'"]+)['"]/);
          if (reqMatch) {
            imports.push({
              moduleSpecifier: reqMatch[1],
              isDynamic: false,
            });
          }
        }
        break;
      }

      case "swift": {
        // import Foundation
        for (const node of sgNode.findAll({ rule: { kind: "import_declaration" } })) {
          const text = node.text();
          const match = text.match(/^import\s+(.+)/);
          if (match) {
            imports.push({ moduleSpecifier: match[1].trim(), isDynamic: false });
          }
        }
        break;
      }

      case "scala": {
        for (const node of sgNode.findAll({ rule: { kind: "import_declaration" } })) {
          const text = node.text();
          const match = text.match(/^import\s+(.+)/);
          if (match) {
            imports.push({ moduleSpecifier: match[1].trim(), isDynamic: false });
          }
        }
        break;
      }

      case "c":
      case "cpp": {
        // #include "myfile.h" or #include <stdio.h>
        for (const node of sgNode.findAll({ rule: { kind: "preproc_include" } })) {
          const text = node.text();
          // Only track local includes (quoted), not system includes (angle brackets)
          const localMatch = text.match(/#include\s+"([^"]+)"/);
          if (localMatch) {
            imports.push({ moduleSpecifier: localMatch[1], isDynamic: false });
          }
        }
        break;
      }
      case "php": {
        // use App\Models\User;
        // use App\Models\User as UserModel;
        // use function App\Helpers\format;
        // use const App\Config\MAX;
        // use App\Models\{User, Post, Comment};
        // use App\Models\User, App\Models\Post;
        for (const node of sgNode.findAll({ rule: { kind: "namespace_use_declaration" } })) {
          for (const spec of phpUseSpecifiers(node.text())) {
            imports.push({ moduleSpecifier: spec, isDynamic: false });
          }
        }
        // require/require_once/include/include_once, quoted or __DIR__-joined,
        // taken from the include expressions themselves. Collected across the
        // four kinds and re-sorted by position, so the specifiers stay in
        // document order rather than being grouped by construct.
        const requireNodes = PHP_REQUIRE_KINDS
          .flatMap((kind) => sgNode.findAll({ rule: { kind } }))
          .sort((a, b) => a.range().start.index - b.range().start.index);
        for (const node of requireNodes) {
          const spec = phpRequireSpecifier(node.text());
          if (spec) imports.push({ moduleSpecifier: spec, isDynamic: false });
        }
        break;
      }
      case "elixir": {
        // alias/import/require/use MyApp.Module [,...]
        const addImport = (moduleSpecifier: string): void => {
          if (!imports.some((item) => item.moduleSpecifier === moduleSpecifier)) {
            imports.push({ moduleSpecifier, isDynamic: false });
          }
        };
        for (const node of sgNode.findAll({ rule: { kind: "call" } })) {
          const target = node.field("target");
          const directive = target?.kind() === "identifier" ? target.text() : null;
          if (!directive || !["alias", "import", "require", "use"].includes(directive)) continue;
          const args = (node.children().find((child) => child.kind() === "arguments")?.text() ?? "")
            .replace(/^\(\s*/, "");
          const match = args.match(/^([A-Z]\w*(?:\.[A-Z]\w*)*)(?:\.\{([^}]+)\})?/);
          if (!match) continue;
          if (match[2]) {
            for (const member of match[2].split(",")) {
              const name = member.trim();
              if (/^[A-Z]\w*(?:\.[A-Z]\w*)*$/.test(name)) {
                addImport(`${match[1]}.${name}`);
              }
            }
          } else {
            addImport(match[1]);
          }
        }
        break;
      }

      case "bash": {
        // source ./script.sh or . ./script.sh
        for (const node of sgNode.findAll({ rule: { kind: "command" } })) {
          const text = node.text();
          const match = text.match(/^(?:source|\.)\s+(.+)/);
          if (match) {
            imports.push({ moduleSpecifier: match[1].trim(), isDynamic: false });
          }
        }
        break;
      }

      default:
        // Unsupported language for import extraction
        break;
    }
  } catch (err) {
    const langKey = String(lang);
    if (!importExtractionWarned.has(langKey)) {
      importExtractionWarned.add(langKey);
      logger.warn(
        "Failed to parse file for imports; subsequent failures will be suppressed for this language",
        {
          lang: langKey,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return imports;
}
