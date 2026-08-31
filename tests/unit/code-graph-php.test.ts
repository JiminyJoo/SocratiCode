// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodeGraph } from "../../src/services/code-graph.js";

/**
 * End-to-end PHP edges, through the real `buildCodeGraph` pass.
 *
 * Every other PHP test calls `extractImports` or `resolveImport` directly with
 * hand-written inputs, which cannot catch a break between the two: a specifier
 * the extractor stops emitting, or emits in a shape the resolver no longer
 * accepts, passes both halves' tests and produces a graph with no edges. That
 * is the failure mode issue #120 was reported as, so it gets a test that
 * exercises the whole path.
 *
 * The fixture is the shape that motivated the fix: one Composer-managed
 * package with a declared PSR-4 map beside one that declares `"autoload": {}`
 * and registers its namespace at run time, plus the include idioms that tree
 * uses instead of `use`.
 */
describe("PHP code graph edges", () => {
  let root: string;
  let edges: Set<string>;

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-php-graph-"));

    // ── Theme: a declared PSR-4 map, in a nested manifest ────────────────
    write("theme/composer.json", JSON.stringify({
      autoload: { "psr-4": { "App\\": "app/" } },
    }));
    write("theme/app/Support/WeekRange.php", `<?php
namespace App\\Support;

class WeekRange {}
`);
    write("theme/app/View/FrontPage.php", `<?php
namespace App\\View;

use App\\Support\\WeekRange;

class FrontPage {}
`);

    // ── Plugin: no autoload map, namespace registered at run time ────────
    write("plugin/composer.json", JSON.stringify({ autoload: {} }));
    write("plugin/src/acme/schema/RoleSchema.php", `<?php
namespace Acme\\Schema;

class RoleSchema {}
`);
    write("plugin/src/acme/service/RoleService.php", `<?php
namespace Acme\\Service;

use \\Acme\\Schema\\RoleSchema;

class RoleService {}
`);

    // ── Include idioms, no namespaces involved ───────────────────────────
    write("plugin/inc/helpers.php", `<?php
function acme_help() {}
`);
    write("plugin/bootstrap.php", `<?php
require_once __DIR__ . '/inc/helpers.php';
require_once dirname(__FILE__) . '/src/acme/schema/RoleSchema.php';
`);
    write("plugin/legacy/loader.php", `<?php
require_once __DIR__ . '/../inc/helpers.php';
require_once ABSPATH . '/never-resolvable.php';
`);

    // ── Bare requires, resolved against the include_path's two entries ───
    // Nothing else in the fixture reaches either target, so each edge below
    // can only have come from the bare form.
    write("lib/common.php", `<?php
function common() {}
`);
    write("plugin/legacy/needs-root.php", `<?php
require 'lib/common.php';
`);
    write("plugin/inc/sibling.php", `<?php
function sibling() {}
`);
    write("plugin/inc/needs-sibling.php", `<?php
require 'sibling.php';
`);
    // Same bare name in both places: the including file's own directory is
    // first on the include_path, so the sibling wins over the root copy.
    write("shadowed.php", `<?php
function root_copy() {}
`);
    write("plugin/inc/shadowed.php", `<?php
function sibling_copy() {}
`);
    write("plugin/inc/needs-shadowed.php", `<?php
require 'shadowed.php';
`);

    const graph = await buildCodeGraph(root);
    edges = new Set(graph.edges.map((e) => `${e.source} -> ${e.target}`));
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("resolves a use statement through a nested composer PSR-4 map", () => {
    expect(edges).toContain("theme/app/View/FrontPage.php -> theme/app/Support/WeekRange.php");
  });

  it("resolves a use statement in a package that declares no autoload map", () => {
    // The runtime-autoloader case: composer.json says `"autoload": {}`, so
    // only the declarations themselves place the class. The leading backslash
    // on the `use` is part of the case — it is what the map-less path used to
    // turn into an absolute path pointing outside the project.
    expect(edges).toContain(
      "plugin/src/acme/service/RoleService.php -> plugin/src/acme/schema/RoleSchema.php",
    );
  });

  it("resolves __DIR__-joined requires", () => {
    expect(edges).toContain("plugin/bootstrap.php -> plugin/inc/helpers.php");
    expect(edges).toContain("plugin/bootstrap.php -> plugin/src/acme/schema/RoleSchema.php");
  });

  it("resolves a dirname(__DIR__)-style walk up out of the including directory", () => {
    expect(edges).toContain("plugin/legacy/loader.php -> plugin/inc/helpers.php");
  });

  it("resolves a bare require against the source directory", () => {
    expect(edges).toContain("plugin/inc/needs-sibling.php -> plugin/inc/sibling.php");
  });

  it("resolves a bare require against the project root when the source dir misses", () => {
    expect(edges).toContain("plugin/legacy/needs-root.php -> lib/common.php");
  });

  it("prefers the source directory over the project root for a bare require", () => {
    expect(edges).toContain("plugin/inc/needs-shadowed.php -> plugin/inc/shadowed.php");
    expect(edges).not.toContain("plugin/inc/needs-shadowed.php -> shadowed.php");
  });

  it("draws no edge for an include joined to a run-time constant", () => {
    expect([...edges].some((e) => e.includes("never-resolvable"))).toBe(false);
  });
});
