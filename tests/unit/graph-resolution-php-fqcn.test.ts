// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPhpFqcnMap, buildPhpPsr4Map, resolveImport } from "../../src/services/graph-resolution.js";

/**
 * PSR-4 can only describe code whose namespaces a composer.json declares. A
 * package that registers its namespaces at run time ships `"autoload": {}` or
 * no manifest at all, so every `use` it makes and every `use` of it resolved to
 * nothing while its symbols extracted perfectly (issue #120). The declarations
 * themselves say where each class lives, and that is what this map reads.
 */
describe("PHP declaration-derived FQCN resolution", () => {
  let root: string;
  const fileSet = new Set<string>();

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    fileSet.add(rel);
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "php-fqcn-"));

    // A plugin in the WordPress shape: a manifest that declares no autoload
    // map, with the namespace registered imperatively at run time instead.
    mkdirSync(path.join(root, "plugin"), { recursive: true });
    writeFileSync(
      path.join(root, "plugin/composer.json"),
      JSON.stringify({ autoload: {} }),
    );
    write("plugin/plugin.php", `<?php
$loader->addNamespace('Acme', __DIR__ . '/src/acme');
`);
    write("plugin/src/acme/schema/RoleSchema.php", `<?php
namespace Acme\\Schema;

final class RoleSchema {}
`);
    write("plugin/src/acme/schema/Contracts.php", `<?php
namespace Acme\\Schema;

interface Storable {}
trait Timestamps {}
`);
    // Two namespaces in one file, braced form.
    write("plugin/src/acme/Mixed.php", `<?php
namespace Acme\\First { class Alpha {} }
namespace Acme\\Second { class Beta {} }
`);
    // Global namespace: no `namespace` declaration at all.
    write("plugin/legacy.php", `<?php
class LegacyHelper {}
`);
    // Shapes that must not register: an anonymous class, a doc-comment
    // mention, and an indented word inside a string.
    write("plugin/src/acme/Noise.php", `<?php
namespace Acme\\Noise;

/**
 * class DocBlockOnly
 */
class Real {
    public function make() { return new class {}; }
}
`);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const resolve = (spec: string, psr4?: Map<string, string[]>): string | null =>
    resolveImport(
      spec, path.join(root, "plugin/src/acme/Caller.php"), root,
      fileSet, "php", undefined, undefined, undefined, undefined,
      psr4 ?? buildPhpPsr4Map(root), undefined, undefined, undefined,
      buildPhpFqcnMap(fileSet, root),
    );

  it("maps a class to the file that declares it, with no manifest involved", () => {
    expect(buildPhpFqcnMap(fileSet, root).get("Acme\\Schema\\RoleSchema"))
      .toEqual(["plugin/src/acme/schema/RoleSchema.php"]);
  });

  it("resolves a use statement no autoload map can describe", () => {
    // The path bears no resemblance to the namespace — the class name and the
    // file name differ, and the directory case does too.
    expect(resolve("Acme\\Schema\\RoleSchema")).toBe("plugin/src/acme/schema/RoleSchema.php");
  });

  it("registers interfaces and traits alongside classes", () => {
    const map = buildPhpFqcnMap(fileSet, root);
    for (const name of ["Storable", "Timestamps"]) {
      expect(map.get(`Acme\\Schema\\${name}`)).toEqual(["plugin/src/acme/schema/Contracts.php"]);
    }
  });

  it("attributes each declaration to the braced namespace it sits in", () => {
    const map = buildPhpFqcnMap(fileSet, root);
    expect(map.get("Acme\\First\\Alpha")).toEqual(["plugin/src/acme/Mixed.php"]);
    expect(map.get("Acme\\Second\\Beta")).toEqual(["plugin/src/acme/Mixed.php"]);
    // Not attributed to the wrong one, which a file-scoped-only reading would do.
    expect(map.has("Acme\\First\\Beta")).toBe(false);
  });

  it("keys a global-namespace class on its bare name", () => {
    expect(buildPhpFqcnMap(fileSet, root).get("LegacyHelper")).toEqual(["plugin/legacy.php"]);
    expect(resolve("\\LegacyHelper")).toBe("plugin/legacy.php");
  });

  it("ignores anonymous classes and doc-comment mentions", () => {
    const map = buildPhpFqcnMap(fileSet, root);
    expect(map.get("Acme\\Noise\\Real")).toEqual(["plugin/src/acme/Noise.php"]);
    expect(map.has("Acme\\Noise\\DocBlockOnly")).toBe(false);
  });

  it("lets a declared PSR-4 prefix win over the declarations", () => {
    // composer.json is the authority where it exists, so the two must be made
    // to disagree for the assertion to mean anything: `Acme\Schema\Contracts`
    // is a real file that PSR-4 places, and the declaration map has no entry
    // for that FQCN — while `RoleSchema` below is the reverse. Pointing them
    // at the same file would pass with the branches in either order.
    const psr4 = new Map([["Acme\\Schema\\", ["plugin/src/acme/schema"]]]);
    expect(resolve("Acme\\Schema\\Contracts", psr4)).toBe("plugin/src/acme/schema/Contracts.php");
  });

  it("does not let the declarations override a PSR-4 hit on a different file", () => {
    // Both routes can answer for this FQCN and they answer differently: the
    // declaration map says Contracts.php (which declares `Acme\Schema\Status`),
    // PSR-4 says a same-named file under its own base dir. PSR-4 must win.
    const decoy = mkdtempSync(path.join(tmpdir(), "php-fqcn-order-"));
    try {
      const set = new Set<string>();
      const put = (rel: string, body: string): void => {
        const abs = path.join(decoy, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, body);
        set.add(rel);
      };
      // Declared by the manifest at declared/Thing.php...
      put("declared/Thing.php", "<?php\nnamespace Other;\nclass Something {}\n");
      // ...while a second file actually declares the FQCN being asked for.
      put("elsewhere/Other.php", "<?php\nnamespace Ns;\nclass Thing {}\n");

      const psr4 = new Map([["Ns\\", ["declared"]]]);
      const result = resolveImport(
        "Ns\\Thing", path.join(decoy, "caller.php"), decoy, set, "php",
        undefined, undefined, undefined, undefined, psr4, undefined, undefined,
        undefined, buildPhpFqcnMap(set, decoy),
      );

      expect(result).toBe("declared/Thing.php");
      expect(result).not.toBe("elsewhere/Other.php");
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it("falls through to the declarations when PSR-4 declares a prefix but not this class", () => {
    // A partial map is the common case, not an edge one: a repo with a
    // Composer-managed theme and a hand-loaded plugin has both regimes at once.
    const psr4 = new Map([["Acme\\", ["nowhere"]]]);
    expect(resolve("Acme\\Schema\\RoleSchema", psr4)).toBe("plugin/src/acme/schema/RoleSchema.php");
  });

  it("returns null for a class nothing in the project declares", () => {
    expect(resolve("Acme\\Schema\\Absent")).toBeNull();
    expect(resolve("Vendor\\Package\\Thing")).toBeNull();
  });

  it("picks the lexically first file when two declare the same FQCN", () => {
    // A collision means two files literally declaring the same class, which in
    // practice is a vendored duplicate. Either is a true "depends on this
    // FQCN" edge; the sort is what makes the pick reproducible.
    const dup = mkdtempSync(path.join(tmpdir(), "php-fqcn-dup-"));
    try {
      const dupSet = new Set<string>();
      for (const rel of ["z-later/Dup.php", "a-earlier/Dup.php"]) {
        const abs = path.join(dup, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, "<?php\nnamespace Shared;\n\nclass Dup {}\n");
        dupSet.add(rel);
      }
      expect(buildPhpFqcnMap(dupSet, dup).get("Shared\\Dup"))
        .toEqual(["a-earlier/Dup.php", "z-later/Dup.php"]);
      expect(resolveImport(
        "Shared\\Dup", path.join(dup, "caller.php"), dup, dupSet, "php",
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, buildPhpFqcnMap(dupSet, dup),
      )).toBe("a-earlier/Dup.php");
    } finally {
      rmSync(dup, { recursive: true, force: true });
    }
  });

  it("reads only PHP files, and survives one it cannot read", () => {
    const mixed = mkdtempSync(path.join(tmpdir(), "php-fqcn-mixed-"));
    try {
      writeFileSync(path.join(mixed, "Real.php"), "<?php\nnamespace Ok;\nclass Real {}\n");
      // Present in the set but never written: a file removed between discovery
      // and this read must not take the whole map down with it.
      const mixedSet = new Set(["Real.php", "gone.php", "notes.md"]);
      const map = buildPhpFqcnMap(mixedSet, mixed);
      expect(map.get("Ok\\Real")).toEqual(["Real.php"]);
      expect(map.size).toBe(1);
    } finally {
      rmSync(mixed, { recursive: true, force: true });
    }
  });
});
