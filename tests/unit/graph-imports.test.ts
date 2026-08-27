// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { Lang } from "@ast-grep/napi";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { extractImports } from "../../src/services/graph-imports.js";

// Register dynamic language grammars once before all tests
beforeAll(() => {
  ensureDynamicLanguages();
});

describe("graph-imports", () => {
  // ── TypeScript / JavaScript ────────────────────────────────────────────

  describe("TypeScript/JavaScript imports", () => {
    it("extracts static imports", () => {
      const source = `
import { foo } from "./utils.js";
import bar from "../lib/bar.js";
import * as helpers from "./helpers.js";
`;
      const imports = extractImports(source, Lang.TypeScript, ".ts");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./utils.js");
      expect(specs).toContain("../lib/bar.js");
      expect(specs).toContain("./helpers.js");
    });

    it("extracts dynamic imports", () => {
      const source = `
const mod = await import("./dynamic-module.js");
`;
      const imports = extractImports(source, Lang.TypeScript, ".ts");
      const dynamicImports = imports.filter((i) => i.isDynamic);

      expect(dynamicImports.length).toBeGreaterThanOrEqual(1);
      expect(
        dynamicImports.some((i) => i.moduleSpecifier === "./dynamic-module.js"),
      ).toBe(true);
    });

    it("extracts require() calls", () => {
      const source = `
const fs = require("fs");
const local = require("./local-module");
`;
      const imports = extractImports(source, Lang.JavaScript, ".js");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("fs");
      expect(specs).toContain("./local-module");
    });

    it("extracts re-exports", () => {
      const source = `
export { default } from "./base.js";
export * from "./all.js";
`;
      const imports = extractImports(source, Lang.TypeScript, ".ts");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./base.js");
      expect(specs).toContain("./all.js");
    });

    it("handles empty source", () => {
      const imports = extractImports("", Lang.TypeScript, ".ts");
      expect(imports).toHaveLength(0);
    });

    it("handles source with no imports", () => {
      const source = `
function hello() {
  return "world";
}
`;
      const imports = extractImports(source, Lang.TypeScript, ".ts");
      expect(imports).toHaveLength(0);
    });
  });

  // ── Svelte ──────────────────────────────────────────────────────────────

  describe("Svelte imports", () => {
    it("extracts imports from <script> blocks", () => {
      const source = `
<script lang="ts">
  import { onMount } from "svelte";
  import Button from "./Button.svelte";
  import { type Props } from "../types.js";
</script>

<Button>Click me</Button>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("svelte");
      expect(specs).toContain("./Button.svelte");
      expect(specs).toContain("../types.js");
    });

    it("extracts imports from <script module> blocks", () => {
      const source = `
<script lang="ts" module>
  export type Variant = "primary" | "secondary";
  export { default as Button } from "./Button.svelte";
</script>

<script lang="ts">
  import { onMount } from "svelte";
</script>

<div>content</div>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./Button.svelte");
      expect(specs).toContain("svelte");
    });

    it("extracts dynamic imports from Svelte files", () => {
      const source = `
<script lang="ts">
  const Component = await import("./DynamicComponent.svelte");
</script>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const dynamicImports = imports.filter((i) => i.isDynamic);

      expect(dynamicImports.length).toBeGreaterThanOrEqual(1);
      expect(
        dynamicImports.some(
          (i) => i.moduleSpecifier === "./DynamicComponent.svelte",
        ),
      ).toBe(true);
    });

    it("handles Svelte files with no script block", () => {
      const source = `
<div>Just markup, no script</div>
<style>
  div { color: red; }
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      expect(imports).toHaveLength(0);
    });

    it("handles Svelte files with JavaScript (no lang=ts)", () => {
      const source = `
<script>
  import { writable } from "svelte/store";
  import Item from "./Item.svelte";
</script>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("svelte/store");
      expect(specs).toContain("./Item.svelte");
    });
  });

  // ── Vue ────────────────────────────────────────────────────────────────

  describe("Vue imports", () => {
    it("extracts imports from <script> blocks", () => {
      const source = `
<script lang="ts">
  import { ref, computed } from "vue";
  import MyComponent from "./MyComponent.vue";
</script>

<template>
  <MyComponent />
</template>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("vue");
      expect(specs).toContain("./MyComponent.vue");
    });
  });

  // ── CSS @import in Svelte/Vue <style> blocks ────────────────────────────

  describe("CSS @import in Svelte style blocks", () => {
    it("extracts @import from <style> block", () => {
      const source = `
<script lang="ts">
  import { onMount } from "svelte";
</script>

<style>
  @import "./variables.css";
  @import "../mixins.scss";
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("svelte");
      expect(specs).toContain("./variables.css");
      expect(specs).toContain("../mixins.scss");
    });

    it("extracts @import url(...) variant", () => {
      const source = `
<style>
  @import url("./theme.css");
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      expect(imports.some((i) => i.moduleSpecifier === "./theme.css")).toBe(true);
    });

    it("skips external URLs", () => {
      const source = `
<style>
  @import "https://fonts.googleapis.com/css2?family=Inter";
  @import "./local.css";
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).not.toContain("https://fonts.googleapis.com/css2?family=Inter");
      expect(specs).toContain("./local.css");
    });

    it("extracts @import from <style global>", () => {
      const source = `
<style global>
  @import "./global-reset.css";
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      expect(imports.some((i) => i.moduleSpecifier === "./global-reset.css")).toBe(true);
    });

    it("marks CSS imports with isCssImport flag", () => {
      const source = `
<script lang="ts">
  import { onMount } from "svelte";
</script>

<style>
  @import "./variables.css";
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const jsImport = imports.find((i) => i.moduleSpecifier === "svelte");
      const cssImport = imports.find((i) => i.moduleSpecifier === "./variables.css");

      expect(jsImport?.isCssImport).toBeFalsy();
      expect(cssImport?.isCssImport).toBe(true);
    });

    it("handles no style block", () => {
      const source = `
<script>
  import { writable } from "svelte/store";
</script>
<div>content</div>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      // Should only have script imports, no CSS imports
      expect(imports).toHaveLength(1);
      expect(imports[0].moduleSpecifier).toBe("svelte/store");
    });
  });

  describe("CSS @import in Vue style blocks", () => {
    it("extracts @import from <style> block", () => {
      const source = `
<script lang="ts">
  import { ref } from "vue";
</script>

<template>
  <div>content</div>
</template>

<style scoped>
  @import "./component.css";
</style>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("vue");
      expect(specs).toContain("./component.css");
    });

    it("extracts @import url(...) from Vue style", () => {
      const source = `
<style>
  @import url("./variables.scss");
  @import url('./mixins.css');
</style>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./variables.scss");
      expect(specs).toContain("./mixins.css");
    });

    it("extracts @import from all style tag variants (scoped, module, lang)", () => {
      const source = `
<script lang="ts">
  import { ref } from "vue";
</script>

<template><div /></template>

<style lang="scss" scoped>
  @import "./scoped-scss.scss";
</style>

<style module>
  @import "./module.css";
</style>

<style lang="less">
  @import "./theme.less";
</style>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("vue");
      expect(specs).toContain("./scoped-scss.scss");
      expect(specs).toContain("./module.css");
      expect(specs).toContain("./theme.less");
    });
  });

  // ── Stylus @require in style blocks ──────────────────────────────────────

  describe("Stylus @require in style blocks", () => {
    it("extracts @require from Svelte <style lang=\"stylus\">", () => {
      const source = `
<script>
  import App from "./App.svelte";
</script>

<style lang="stylus">
  @require "./variables.styl"
  @require "../mixins.styl"
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./variables.styl");
      expect(specs).toContain("../mixins.styl");
    });

    it("extracts @import and @require from Vue <style lang=\"stylus\">", () => {
      const source = `
<template><div /></template>

<style lang="stylus">
  @import "./base.styl"
  @require "./theme.styl"
</style>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./base.styl");
      expect(specs).toContain("./theme.styl");
    });
  });

  // ── Standalone CSS ──────────────────────────────────────────────────────

  describe("Standalone CSS imports", () => {
    it("extracts @import from CSS files", () => {
      const source = `
@import "./variables.css";
@import url("./mixins.css");

body { color: red; }
`;
      const imports = extractImports(source, Lang.Css, ".css");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./variables.css");
      expect(specs).toContain("./mixins.css");
    });

    it("skips external URLs in CSS files", () => {
      const source = `
@import "https://cdn.example.com/reset.css";
@import "./local.css";
`;
      const imports = extractImports(source, Lang.Css, ".css");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).not.toContain("https://cdn.example.com/reset.css");
      expect(specs).toContain("./local.css");
    });
  });

  // ── Python ─────────────────────────────────────────────────────────────

  describe("Python imports", () => {
    it("extracts import statements", () => {
      const source = `
import os
import json
from typing import List, Dict
from .models import User
from ..utils import helpers
`;
      const imports = extractImports(source, "python", ".py");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("os");
      expect(specs).toContain("json");
      expect(specs).toContain("typing");
      expect(specs).toContain(".models");
      expect(specs).toContain("..utils");
    });
  });

  // ── Java ───────────────────────────────────────────────────────────────

  describe("Java imports", () => {
    it("extracts import declarations", () => {
      const source = `
package com.example;

import java.util.List;
import com.example.models.User;
import static java.lang.Math.PI;
`;
      const imports = extractImports(source, "java", ".java");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
      // Should capture the import paths
      expect(specs.some((s) => s.includes("java.util"))).toBe(true);
    });
  });

  // ── Rust ───────────────────────────────────────────────────────────────

  describe("Rust imports", () => {
    const specsOf = (source: string): string[] =>
      extractImports(source, "rust", ".rs").map((i) => i.moduleSpecifier);

    it("extracts use statements", () => {
      const source = `
use std::collections::HashMap;
use crate::models::User;
mod config;
`;
      const imports = extractImports(source, "rust", ".rs");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
    });

    it("extracts module declarations behind a visibility modifier", () => {
      const specs = specsOf(`
mod private_one;
pub mod public_one;
pub(crate) mod crate_visible;
pub(in crate::outer) mod scoped;
`);

      expect(specs).toEqual(["private_one", "public_one", "crate_visible", "scoped"]);
    });

    it("extracts re-exports", () => {
      const specs = specsOf(`
pub use crate::config::Config;
pub(crate) use crate::db::Pool;
`);

      expect(specs).toEqual(["crate::config::Config", "crate::db::Pool"]);
    });

    it("still skips inline module definitions", () => {
      const specs = specsOf(`
pub mod inline {
    pub fn thing() {}
}
mod declared;
`);

      expect(specs).toEqual(["declared"]);
    });

    it("expands a use group into one path per leaf", () => {
      const specs = specsOf("use crate::{parser, printer::Printer};");

      expect(specs).toEqual(["crate::parser", "crate::printer::Printer"]);
    });

    it("expands nested use groups", () => {
      const specs = specsOf("use crate::{a::{b, c}, d};");

      expect(specs).toEqual(["crate::a::b", "crate::a::c", "crate::d"]);
    });

    it("reads self and glob leaves as the module they name", () => {
      const specs = specsOf(`
use crate::config::{self, Config};
use crate::helpers::*;
`);

      expect(specs).toEqual(["crate::config", "crate::config::Config", "crate::helpers"]);
    });

    it("drops the alias from a renamed import", () => {
      const specs = specsOf("use crate::models::User as DomainUser;");

      expect(specs).toEqual(["crate::models::User"]);
    });

    it("reads a use declaration split across lines", () => {
      const specs = specsOf(`
use crate::{
    alpha,
    beta::Gamma,
};
`);

      expect(specs).toEqual(["crate::alpha", "crate::beta::Gamma"]);
    });

    it("ignores comments written between the leaves of a use group", () => {
      const specs = specsOf(`
use crate::{
    // the one we need
    models::User,
    /* and this one */ helpers::format,
};
`);

      expect(specs).toEqual(["crate::models::User", "crate::helpers::format"]);
    });

    it("names the module a raw identifier escapes, not its escape", () => {
      const specs = specsOf(`
pub mod r#async;
use crate::r#type::Kind;
use crate::r#match::Pattern as r#final;
`);

      // `use` declarations are read before `mod` ones, hence the order.
      expect(specs).toEqual(["crate::type::Kind", "crate::match::Pattern", "async"]);
    });

    it("takes the file of a mod from its path attribute", () => {
      const specs = specsOf(`
#[path = "elsewhere/moved.rs"]
mod moved;
#[cfg(test)]
#[path = "fixtures/support.rs"]
mod support;
mod conventional;
`);

      expect(specs).toEqual(["elsewhere/moved.rs", "fixtures/support.rs", "conventional"]);
    });

    it("extracts an extern crate declaration", () => {
      const specs = specsOf(`
extern crate serde;
#[macro_use]
extern crate log;
extern crate my_lib as shorthand;
`);

      expect(specs).toEqual(["serde", "log", "my_lib"]);
    });

    it("places a mod declared inside an inline module under that module", () => {
      const specs = specsOf(`
mod outer {
    mod inner;
    mod deeper {
        mod leaf;
    }
}
mod beside;
`);

      expect(specs).toEqual(["self::outer::inner", "self::outer::deeper::leaf", "beside"]);
    });

    it("counts an inline module as a level a super:: path climbs", () => {
      const specs = specsOf(`
use super::sibling::Thing;

#[cfg(test)]
mod tests {
    use super::helper;
    use super::super::sibling::Other;
}
`);

      // At file level `super` reaches the parent module; the same word inside
      // `mod tests` reaches the file itself, so it takes one more to leave it.
      expect(specs).toEqual(["super::sibling::Thing", "self::helper", "super::sibling::Other"]);
    });

    it("records nothing for a glob import of the module a test block sits in", () => {
      const specs = specsOf(`
#[cfg(test)]
mod tests {
    use super::*;
}
`);

      // `use super::*;` inside `mod tests` names the file it is written in.
      expect(specs).toEqual([]);
    });

    it("leaves a crate-anchored path alone inside an inline module", () => {
      const specs = specsOf(`
mod tests {
    use crate::db::Connection;
    use serde::Deserialize;
}
`);

      // `crate::` counts from the crate root, which no inline module moves;
      // and a bare head may name another crate, which rebasing would lose.
      expect(specs).toEqual(["crate::db::Connection", "serde::Deserialize"]);
    });
  });

  // ── Go ─────────────────────────────────────────────────────────────────

  describe("Go imports", () => {
    it("extracts import declarations", () => {
      const source = `
package main

import (
    "fmt"
    "os"
    "github.com/user/repo/internal/utils"
)
`;
      const imports = extractImports(source, "go", ".go");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
      expect(specs.some((s) => s.includes("fmt"))).toBe(true);
    });
  });

  // ── Dart (regex-based) ─────────────────────────────────────────────────

  describe("Dart imports (regex)", () => {
    it("extracts import statements", () => {
      const source = `
import 'package:flutter/material.dart';
import 'dart:async';
import '../utils/helpers.dart';
export 'models.dart';
`;
      const imports = extractImports(source, "dart", ".dart");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("package:flutter/material.dart");
      expect(specs).toContain("dart:async");
      expect(specs).toContain("../utils/helpers.dart");
      expect(specs).toContain("models.dart");
    });

    it("extracts part statements", () => {
      const source = `
part 'src/model.dart';
part 'src/widget.dart';
`;
      const imports = extractImports(source, "dart", ".dart");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("src/model.dart");
      expect(specs).toContain("src/widget.dart");
    });
  });

  // ── Lua (regex-based) ──────────────────────────────────────────────────

  describe("Lua imports (regex)", () => {
    it("extracts require calls", () => {
      const source = `
local http = require("socket.http")
local json = require 'cjson'
`;
      const imports = extractImports(source, "lua", ".lua");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("socket.http");
      expect(specs).toContain("cjson");
    });

    it("extracts dofile/loadfile calls", () => {
      const source = `
dofile("config.lua")
loadfile("data.lua")
`;
      const imports = extractImports(source, "lua", ".lua");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("config.lua");
      expect(specs).toContain("data.lua");
    });
  });

  // ── PHP ────────────────────────────────────────────────────────────────

  describe("PHP imports", () => {
    it("extracts use statements", () => {
      const source = `<?php
namespace App\\Controllers;

use App\\Models\\User;
use Illuminate\\Http\\Request;
require_once './config.php';
include './helpers.php';
`;
      const imports = extractImports(source, "php", ".php");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("App\\Models\\User");
      expect(specs).toContain("Illuminate\\Http\\Request");
      expect(specs).toContain("./config.php");
      expect(specs).toContain("./helpers.php");
    });

    it("extracts use with alias", () => {
      const source = `<?php
use App\\Models\\User as UserModel;
use App\\Services\\PaymentService as Payment;
`;
      const imports = extractImports(source, "php", ".php");
      const specs = imports.map((i) => i.moduleSpecifier);

      // Should extract the namespace, not the alias
      expect(specs).toContain("App\\Models\\User");
      expect(specs).toContain("App\\Services\\PaymentService");
      expect(specs).not.toContain("App\\Models\\User as UserModel");
    });

    it("extracts grouped use statements", () => {
      const source = `<?php
use App\\Models\\{User, Post, Comment};
`;
      const imports = extractImports(source, "php", ".php");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("App\\Models\\User");
      expect(specs).toContain("App\\Models\\Post");
      expect(specs).toContain("App\\Models\\Comment");
    });

    it("extracts use function and use const", () => {
      const source = `<?php
use function App\\Helpers\\formatDate;
use const App\\Config\\MAX_RETRIES;
`;
      const imports = extractImports(source, "php", ".php");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("App\\Helpers\\formatDate");
      expect(specs).toContain("App\\Config\\MAX_RETRIES");
    });

    it("extracts every name in a comma-separated use list", () => {
      // Only the first name survived before: the single-use regex matched the
      // head of the statement and the rest of the list was dropped silently.
      const source = `<?php
use App\\Models\\User, App\\Models\\Post;
use function App\\Helpers\\first, App\\Helpers\\second;
use App\\Models\\Role as R, App\\Models\\Team as T;
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toContain("App\\Models\\User");
      expect(specs).toContain("App\\Models\\Post");
      expect(specs).toContain("App\\Helpers\\first");
      expect(specs).toContain("App\\Helpers\\second");
      expect(specs).toContain("App\\Models\\Role");
      expect(specs).toContain("App\\Models\\Team");
    });

    it("does not split a group's members into separate clauses", () => {
      // A group's internal commas separate members of one clause; the
      // statement-level commas above separate clauses. Splitting a group on
      // them yields `App\Models\{Alpha` and `Beta}`, neither of which names
      // anything. (PHP rejects a group and a further clause in one statement,
      // so the two forms only ever meet across statements, as here.)
      const source = `<?php
use App\\Models\\{Alpha, Beta};
use App\\Services\\Payments, App\\Services\\Refunds;
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([
        "App\\Models\\Alpha",
        "App\\Models\\Beta",
        "App\\Services\\Payments",
        "App\\Services\\Refunds",
      ]);
    });

    it("strips function and const modifiers carried by group members", () => {
      // A group can carry the modifier per member rather than on the statement,
      // mixing a function, a constant and a class in one declaration. Left on,
      // the modifier became part of the name and the real one was lost.
      const source = `<?php
use App\\Helpers\\{function first, const MAX, User};
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([
        "App\\Helpers\\first",
        "App\\Helpers\\MAX",
        "App\\Helpers\\User",
      ]);
    });

    it("handles a group split across lines", () => {
      const source = `<?php
use App\\Models\\{
    User,
    Post,
};
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual(["App\\Models\\User", "App\\Models\\Post"]);
    });

    it("keeps the leading backslash of a fully-qualified use", () => {
      // Extraction reports what the source says; the resolver strips it.
      const source = `<?php
use \\App\\Models\\User;
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toContain("\\App\\Models\\User");
    });

    it("extracts __DIR__ and dirname(__FILE__) joined requires as source-relative paths", () => {
      // The dominant include idiom outside Composer projects. The old regex
      // demanded a quote right after require/(, so the __DIR__ prefix killed
      // the match and these statements yielded nothing at all.
      const source = `<?php
require_once __DIR__ . '/inc/util.php';
include __DIR__ . "/../lib/legacy.php";
require_once(__DIR__ . '/bootstrap.php');
require_once dirname(__FILE__) . '/old-school.php';
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toContain("./inc/util.php");
      expect(specs).toContain("./../lib/legacy.php");
      expect(specs).toContain("./bootstrap.php");
      expect(specs).toContain("./old-school.php");
    });

    it("extracts a bare require path unchanged", () => {
      const source = `<?php
require 'inc/util.php';
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toContain("inc/util.php");
    });

    it("extracts a require in return position", () => {
      // `return require __DIR__ . '/x.php';` is a return_statement, not an
      // expression_statement, and it is the standard shape of a config or
      // route file. Scanning only expression statements dropped all of them.
      const source = `<?php
return require __DIR__ . '/config.php';
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual(["./config.php"]);
    });

    it("extracts an include from any expression position", () => {
      // Matching the include expressions themselves rather than a list of
      // statement kinds means assignment, return, conditional and
      // error-suppressed forms all come along without being enumerated.
      const source = `<?php
$c = include 'assigned.php';
@include('suppressed.php');
if (true) { include_once 'conditional.php'; }
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      // Document order, not grouped by construct kind.
      expect(specs).toEqual(["assigned.php", "suppressed.php", "conditional.php"]);
    });

    it("does not mistake a method named after the construct for an include", () => {
      // `require` is a language construct, but nothing stops a method being
      // named after one, and `$loader->require('x.php')` includes no file.
      const source = `<?php
class Loader {
    public function boot($loader) {
        $loader->require('not-an-include.php');
        $loader->include_once("also-not.php");
        return Registry::require('nope.php');
    }
}
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([]);
    });

    it("does not read an include out of a comment or a string", () => {
      // Both were real: this project's own tests carry Blade directives in
      // string literals, and its comments say things like "does NOT include
      // 'event'" — the old statement-text scan turned both into specifiers.
      const source = `<?php
// The ENUM does NOT include 'event' before the migration runs.
function template(): string {
    return "@include('partials/related-element-hosts')";
}
$msg = "remember to include 'legislative_session' here";
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([]);
    });

    it("ignores a require joined to a constant or variable it cannot know", () => {
      // ABSPATH and $base are run-time values. Taking the literal tail alone
      // would invent a path the code may never include.
      const source = `<?php
require_once ABSPATH . '/wp-admin/includes/file.php';
require_once $base . '/config.php';
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([]);
    });
  });

  // ── Ruby ───────────────────────────────────────────────────────────────

  describe("Ruby imports", () => {
    it("extracts require statements", () => {
      const source = `
require 'json'
require_relative './models/user'
require_relative '../lib/helpers'
`;
      const imports = extractImports(source, "ruby", ".rb");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
    });
  });

  // ── C/C++ ──────────────────────────────────────────────────────────────

  describe("C/C++ imports", () => {
    it("extracts include directives", () => {
      const source = `
#include <stdio.h>
#include "local_header.h"
#include "../utils/math.h"
`;
      const imports = extractImports(source, "c", ".c");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
    });
  });

  // ── Shell/Bash ─────────────────────────────────────────────────────────

  describe("Shell imports", () => {
    it("extracts source commands", () => {
      const source = `
#!/bin/bash
source ./config.sh
. ./utils.sh
`;
      const imports = extractImports(source, "bash", ".sh");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
    });
  });

  // ── Kotlin ──────────────────────────────────────────────────────────────

  describe("Kotlin imports", () => {
    it("extracts import headers", () => {
      const source = `
package com.example.app

import com.example.models.User
import com.example.utils.StringHelper
import kotlinx.coroutines.launch
`;
      const imports = extractImports(source, "kotlin", ".kt");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThanOrEqual(3);
      expect(specs.some((s) => s.includes("com.example.models.User"))).toBe(
        true,
      );
      expect(
        specs.some((s) => s.includes("com.example.utils.StringHelper")),
      ).toBe(true);
    });

    it("handles wildcard imports", () => {
      const source = `
import com.example.models.*
`;
      const imports = extractImports(source, "kotlin", ".kt");

      expect(imports.length).toBeGreaterThanOrEqual(1);
      expect(
        imports.some((i) => i.moduleSpecifier.includes("com.example.models")),
      ).toBe(true);
    });
  });

  // ── Scala ───────────────────────────────────────────────────────────────

  describe("Scala imports", () => {
    it("extracts import declarations", () => {
      const source = `
package com.example

import scala.collection.mutable.ListBuffer
import com.example.models.User
import com.example.services._
`;
      const imports = extractImports(source, "scala", ".scala");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThanOrEqual(2);
      expect(
        specs.some(
          (s) => s.includes("scala.collection") || s.includes("ListBuffer"),
        ),
      ).toBe(true);
    });
  });

  // ── Swift ───────────────────────────────────────────────────────────────

  describe("Swift imports", () => {
    it("extracts import declarations", () => {
      const source = `
import Foundation
import UIKit
import SwiftUI
`;
      const imports = extractImports(source, "swift", ".swift");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThanOrEqual(3);
      expect(specs).toContain("Foundation");
      expect(specs).toContain("UIKit");
      expect(specs).toContain("SwiftUI");
    });

    it("handles no imports", () => {
      const source = `
func hello() -> String {
    return "world"
}
`;
      const imports = extractImports(source, "swift", ".swift");
      expect(imports).toHaveLength(0);
    });
  });

  // ── C# ─────────────────────────────────────────────────────────────────

  describe("C# imports", () => {
    it("extracts using directives", () => {
      const source = `
using System;
using System.Collections.Generic;
using MyApp.Models;
`;
      const imports = extractImports(source, "csharp", ".cs");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThanOrEqual(3);
      expect(specs.some((s) => s.includes("System"))).toBe(true);
      expect(specs.some((s) => s.includes("MyApp.Models"))).toBe(true);
    });

    it("extracts static using directives", () => {
      const source = `
using static System.Math;
`;
      const imports = extractImports(source, "csharp", ".cs");

      expect(imports.length).toBeGreaterThanOrEqual(1);
      expect(
        imports.some((i) => i.moduleSpecifier.includes("System.Math")),
      ).toBe(true);
    });

    it("skips using alias directives", () => {
      const source = `
using Alias = System.Collections.Generic.List<int>;
`;
      const imports = extractImports(source, "csharp", ".cs");
      // Using aliases (using X = ...) should be filtered out
      expect(imports).toHaveLength(0);
    });
  });
});
