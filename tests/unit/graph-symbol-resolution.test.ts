// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { describe, expect, it } from "vitest";
import {
  computeUnresolvedPct,
  resolveCallSites,
} from "../../src/services/graph-symbol-resolution.js";
import type { CodeGraph, SymbolEdge, SymbolNode } from "../../src/types.js";

function mkGraph(): CodeGraph {
  return {
    nodes: [
      {
        relativePath: "src/a.ts",
        imports: [],
        exports: [],
        dependencies: ["src/b.ts"],
        dependents: [],
      },
      {
        relativePath: "src/b.ts",
        imports: [],
        exports: [],
        dependencies: ["src/c.ts"],
        dependents: ["src/a.ts"],
      },
      {
        relativePath: "src/c.ts",
        imports: [],
        exports: [],
        dependencies: [],
        dependents: ["src/b.ts"],
      },
    ],
    edges: [],
  };
}

describe("graph-symbol-resolution", () => {
  it("resolves a local call to unique confidence", () => {
    const graph = mkGraph();
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/a.ts",
        [
          { id: "src/a.ts::foo#1", name: "foo", qualifiedName: "foo", kind: "function", file: "src/a.ts", line: 1, endLine: 3, language: "typescript" },
          { id: "src/a.ts::caller#5", name: "caller", qualifiedName: "caller", kind: "function", file: "src/a.ts", line: 5, endLine: 8, language: "typescript" },
        ],
      ],
    ]);
    const edges: SymbolEdge[] = [
      {
        callerId: "src/a.ts::caller#5",
        calleeName: "foo",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/a.ts", line: 6 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/a.ts", edges]]);
    resolveCallSites(graph, symbolsByFile, outgoing);
    expect(edges[0].confidence).toBe("local");
    expect(edges[0].calleeCandidates).toContain("src/a.ts::foo#1");
  });

  it("resolves an imported call by walking dependencies", () => {
    const graph = mkGraph();
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/a.ts",
        [{ id: "src/a.ts::caller#1", name: "caller", qualifiedName: "caller", kind: "function", file: "src/a.ts", line: 1, endLine: 3, language: "typescript" }],
      ],
      [
        "src/b.ts",
        [{ id: "src/b.ts::helper#1", name: "helper", qualifiedName: "helper", kind: "function", file: "src/b.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
    ]);
    const edges: SymbolEdge[] = [
      {
        callerId: "src/a.ts::caller#1",
        calleeName: "helper",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/a.ts", line: 2 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/a.ts", edges]]);
    resolveCallSites(graph, symbolsByFile, outgoing);
    expect(["unique", "multiple-candidates"]).toContain(edges[0].confidence);
    expect(edges[0].calleeCandidates).toContain("src/b.ts::helper#1");
  });

  it("leaves a call unresolved when no symbol matches anywhere", () => {
    const graph = mkGraph();
    const symbolsByFile = new Map<string, SymbolNode[]>();
    const edges: SymbolEdge[] = [
      {
        callerId: "src/a.ts::<module>#1",
        calleeName: "doesNotExist",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/a.ts", line: 1 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/a.ts", edges]]);
    resolveCallSites(graph, symbolsByFile, outgoing);
    expect(edges[0].confidence).toBe("unresolved");
    expect(edges[0].calleeCandidates).toEqual([]);
  });

  it("preserves module identity when two dependencies export the same symbol name", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          relativePath: "src/app.ts",
          imports: ["./serviceA", "./serviceB"],
          exports: [],
          dependencies: ["src/serviceA.ts", "src/serviceB.ts"],
          dependents: [],
        },
        {
          relativePath: "src/serviceA.ts",
          imports: [],
          exports: ["processData"],
          dependencies: [],
          dependents: ["src/app.ts"],
        },
        {
          relativePath: "src/serviceB.ts",
          imports: [],
          exports: ["processData"],
          dependencies: [],
          dependents: ["src/app.ts"],
        },
      ],
      edges: [],
    };
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/app.ts",
        [{ id: "src/app.ts::run#1", name: "run", qualifiedName: "run", kind: "function", file: "src/app.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
      [
        "src/serviceA.ts",
        [{ id: "src/serviceA.ts::processData#1", name: "processData", qualifiedName: "processData", kind: "function", file: "src/serviceA.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
      [
        "src/serviceB.ts",
        [{ id: "src/serviceB.ts::processData#1", name: "processData", qualifiedName: "processData", kind: "function", file: "src/serviceB.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
    ]);

    // app.ts specifically imports processData from serviceA
    const edges: SymbolEdge[] = [
      {
        callerId: "src/app.ts::run#1",
        calleeName: "processData",
        kind: "call",
        sourceModule: "./serviceA",
        importedName: "processData",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/app.ts", line: 3 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/app.ts", edges]]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    expect(edges[0].confidence).toBe("unique");
    expect(edges[0].calleeCandidates).toEqual(["src/serviceA.ts::processData#1"]);
  });

  it("resolves default imports to default exported symbol", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          relativePath: "src/main.ts",
          imports: ["./logger"],
          exports: [],
          dependencies: ["src/logger.ts"],
          dependents: [],
        },
        {
          relativePath: "src/logger.ts",
          imports: [],
          exports: ["default"],
          dependencies: [],
          dependents: ["src/main.ts"],
        },
      ],
      edges: [],
    };
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/main.ts",
        [{ id: "src/main.ts::main#1", name: "main", qualifiedName: "main", kind: "function", file: "src/main.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
      [
        "src/logger.ts",
        [{ id: "src/logger.ts::Logger#1", name: "Logger", qualifiedName: "Logger", exportedAs: "default", kind: "class", file: "src/logger.ts", line: 1, endLine: 10, language: "typescript" }],
      ],
    ]);

    const edges: SymbolEdge[] = [
      {
        callerId: "src/main.ts::main#1",
        calleeName: "Logger",
        kind: "call",
        sourceModule: "./logger",
        importedName: "default",
        localAlias: "Logger",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/main.ts", line: 2 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/main.ts", edges]]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    expect(edges[0].confidence).toBe("unique");
    expect(edges[0].calleeCandidates).toEqual(["src/logger.ts::Logger#1"]);
  });

  it("resolves multi-level re-export barrel chains with cycle protection", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          relativePath: "src/client.ts",
          imports: ["./barrelA"],
          exports: [],
          dependencies: ["src/barrelA.ts"],
          dependents: [],
        },
        {
          relativePath: "src/barrelA.ts",
          imports: ["./barrelB"],
          exports: ["helper"],
          dependencies: ["src/barrelB.ts"],
          dependents: ["src/client.ts", "src/barrelB.ts"],
        },
        {
          relativePath: "src/barrelB.ts",
          imports: ["./barrelA", "./target"],
          exports: ["helper"],
          dependencies: ["src/barrelA.ts", "src/target.ts"],
          dependents: ["src/barrelA.ts"],
        },
        {
          relativePath: "src/target.ts",
          imports: [],
          exports: ["helper"],
          dependencies: [],
          dependents: ["src/barrelB.ts"],
        },
      ],
      edges: [],
    };
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/client.ts",
        [{ id: "src/client.ts::run#1", name: "run", qualifiedName: "run", kind: "function", file: "src/client.ts", line: 1, endLine: 3, language: "typescript" }],
      ],
      [
        "src/target.ts",
        [{ id: "src/target.ts::helper#1", name: "helper", qualifiedName: "helper", kind: "function", file: "src/target.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/client.ts",
        [
          {
            callerId: "src/client.ts::run#1",
            calleeName: "helper",
            kind: "call",
            sourceModule: "./barrelA",
            importedName: "helper",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/client.ts", line: 2 },
          },
        ],
      ],
      [
        "src/barrelA.ts",
        [
          {
            callerId: "src/barrelA.ts::<module>#1",
            calleeName: "helper",
            kind: "reexport",
            sourceModule: "./barrelB",
            importedName: "helper",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrelA.ts", line: 1 },
          },
        ],
      ],
      [
        "src/barrelB.ts",
        [
          // Circular wildcard re-export to A plus wildcard re-export to target
          {
            callerId: "src/barrelB.ts::<module>#1",
            calleeName: "*",
            kind: "reexport",
            sourceModule: "./barrelA",
            importedName: "*",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrelB.ts", line: 1 },
          },
          {
            callerId: "src/barrelB.ts::<module>#1",
            calleeName: "*",
            kind: "reexport",
            sourceModule: "./target",
            importedName: "*",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrelB.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    const clientEdge = outgoing.get("src/client.ts")?.[0];
    expect(clientEdge).toBeDefined();
    expect(clientEdge?.confidence).toBe("unique");
    expect(clientEdge?.calleeCandidates).toEqual(["src/target.ts::helper#1"]);
  });

  it("resolves aliased named re-export when preceded by wildcard re-export from same dep", () => {
    const graph: CodeGraph = {
      nodes: [
        { filePath: "/project/src/barrel.ts", relativePath: "src/barrel.ts", language: "typescript", dependencies: ["src/dep.ts"], imports: [], exports: [], dependents: [] },
        { filePath: "/project/src/dep.ts", relativePath: "src/dep.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
        { filePath: "/project/src/consumer.ts", relativePath: "src/consumer.ts", language: "typescript", dependencies: ["src/barrel.ts"], imports: [], exports: [], dependents: [] },
      ],
      edges: [],
    };

    const symOriginal: SymbolNode = {
      id: "src/dep.ts::computeCore#1",
      name: "computeCore",
      qualifiedName: "computeCore",
      kind: "function",
      file: "src/dep.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["src/dep.ts", [symOriginal]],
      ["src/barrel.ts", []],
      ["src/consumer.ts", []],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/barrel.ts",
        [
          // 1. Wildcard re-export from dep
          {
            callerId: "src/barrel.ts::<module>#1",
            calleeName: "*",
            kind: "reexport",
            sourceModule: "./dep",
            importedName: "*",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrel.ts", line: 1 },
          },
          // 2. Aliased re-export from same dep: export { computeCore as customAlias } from './dep'
          {
            callerId: "src/barrel.ts::<module>#1",
            calleeName: "customAlias",
            kind: "reexport",
            sourceModule: "./dep",
            importedName: "computeCore",
            localAlias: "customAlias",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrel.ts", line: 2 },
          },
        ],
      ],
      [
        "src/consumer.ts",
        [
          {
            callerId: "src/consumer.ts::main#1",
            calleeName: "customAlias",
            kind: "call",
            sourceModule: "./barrel",
            importedName: "customAlias",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/consumer.ts", line: 3 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    const edge = outgoing.get("src/consumer.ts")?.[0];
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe("unique");
    expect(edge?.calleeCandidates).toEqual(["src/dep.ts::computeCore#1"]);
  });

  it("prioritizes exact normalized module match over suffix match in resolveDepFile", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          filePath: "/project/src/app.ts",
          relativePath: "src/app.ts",
          language: "typescript",
          dependencies: ["src/button.ts", "src/components/button.ts"],
          imports: [],
          exports: [],
          dependents: [],
        },
        { filePath: "/project/src/button.ts", relativePath: "src/button.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
        { filePath: "/project/src/components/button.ts", relativePath: "src/components/button.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
      ],
      edges: [],
    };

    const symButton: SymbolNode = {
      id: "src/button.ts::render#1",
      name: "render",
      qualifiedName: "render",
      kind: "function",
      file: "src/button.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };
    const symCompButton: SymbolNode = {
      id: "src/components/button.ts::render#1",
      name: "render",
      qualifiedName: "render",
      kind: "function",
      file: "src/components/button.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["src/button.ts", [symButton]],
      ["src/components/button.ts", [symCompButton]],
      ["src/app.ts", []],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/app.ts",
        [
          {
            callerId: "src/app.ts::main#1",
            calleeName: "render",
            kind: "call",
            sourceModule: "./button",
            importedName: "render",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/app.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    const edge = outgoing.get("src/app.ts")?.[0];
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe("unique");
    expect(edge?.calleeCandidates).toEqual(["src/button.ts::render#1"]);
  });

  it("resolves modules located in dotted directories such as v1.0", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          filePath: "/project/src/client.ts",
          relativePath: "src/client.ts",
          language: "typescript",
          dependencies: ["src/api/v1.0/service.ts"],
          imports: [],
          exports: [],
          dependents: [],
        },
        {
          filePath: "/project/src/api/v1.0/service.ts",
          relativePath: "src/api/v1.0/service.ts",
          language: "typescript",
          dependencies: [],
          imports: [],
          exports: [],
          dependents: [],
        },
      ],
      edges: [],
    };

    const symService: SymbolNode = {
      id: "src/api/v1.0/service.ts::fetchData#1",
      name: "fetchData",
      qualifiedName: "fetchData",
      kind: "function",
      file: "src/api/v1.0/service.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["src/api/v1.0/service.ts", [symService]],
      ["src/client.ts", []],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/client.ts",
        [
          {
            callerId: "src/client.ts::main#1",
            calleeName: "fetchData",
            kind: "call",
            sourceModule: "./api/v1.0/service",
            importedName: "fetchData",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/client.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);
    const edge = outgoing.get("src/client.ts")?.[0];
    expect(edge?.confidence).toBe("unique");
    expect(edge?.calleeCandidates).toEqual(["src/api/v1.0/service.ts::fetchData#1"]);
  });

  it("does not arbitrarily resolve when suffix matches are ambiguous across dependencies", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          filePath: "/project/src/app.ts",
          relativePath: "src/app.ts",
          language: "typescript",
          dependencies: ["packages/pkg-a/utils.ts", "packages/pkg-b/utils.ts"],
          imports: [],
          exports: [],
          dependents: [],
        },
        { filePath: "/project/packages/pkg-a/utils.ts", relativePath: "packages/pkg-a/utils.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
        { filePath: "/project/packages/pkg-b/utils.ts", relativePath: "packages/pkg-b/utils.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
      ],
      edges: [],
    };

    const symA: SymbolNode = {
      id: "packages/pkg-a/utils.ts::helper#1",
      name: "helper",
      qualifiedName: "helper",
      kind: "function",
      file: "packages/pkg-a/utils.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };
    const symB: SymbolNode = {
      id: "packages/pkg-b/utils.ts::helper#1",
      name: "helper",
      qualifiedName: "helper",
      kind: "function",
      file: "packages/pkg-b/utils.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["packages/pkg-a/utils.ts", [symA]],
      ["packages/pkg-b/utils.ts", [symB]],
      ["src/app.ts", []],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/app.ts",
        [
          {
            callerId: "src/app.ts::main#1",
            calleeName: "helper",
            kind: "call",
            sourceModule: "utils",
            importedName: "helper",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/app.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);
    const edge = outgoing.get("src/app.ts")?.[0];
    expect(edge?.confidence).toBe("unresolved");
    expect(edge?.calleeCandidates).toHaveLength(0);
  });

  it("computeUnresolvedPct returns 0 when no edges", () => {
    expect(computeUnresolvedPct(new Map())).toBe(0);
  });

  it("computeUnresolvedPct reports correct percentage", () => {
    const map = new Map<string, SymbolEdge[]>([
      [
        "src/a.ts",
        [
          { callerId: "x", calleeName: "y", kind: "call", calleeCandidates: ["x"], confidence: "unique", callSite: { file: "x", line: 1 } },
          { callerId: "x", calleeName: "z", kind: "call", calleeCandidates: [], confidence: "unresolved", callSite: { file: "x", line: 2 } },
        ],
      ],
    ]);
    expect(computeUnresolvedPct(map)).toBe(50);
  });

  it("does not resolve an internal helper through an aliased namespace re-export barrel", () => {
    const graph: CodeGraph = {
      nodes: [
        { relativePath: "src/index.ts", imports: ["./helpers"], exports: ["utils"], dependencies: ["src/helpers.ts"], dependents: ["src/app.ts"] },
        { relativePath: "src/helpers.ts", imports: [], exports: ["secret"], dependencies: [], dependents: ["src/index.ts"] },
        { relativePath: "src/app.ts", imports: ["./index"], exports: [], dependencies: ["src/index.ts"], dependents: [] },
      ],
      edges: [],
    };
    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["src/index.ts", [{ id: "src/index.ts::<module>#1", name: "<module>", qualifiedName: "<module>", kind: "function", file: "src/index.ts", line: 1, endLine: 1, language: "typescript" }]],
      ["src/helpers.ts", [{ id: "src/helpers.ts::secret#1", name: "secret", qualifiedName: "secret", kind: "function", file: "src/helpers.ts", line: 1, endLine: 3, language: "typescript" }]],
      ["src/app.ts", [{ id: "src/app.ts::main#1", name: "main", qualifiedName: "main", kind: "function", file: "src/app.ts", line: 1, endLine: 5, language: "typescript" }]],
    ]);
    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/index.ts",
        [
          {
            callerId: "src/index.ts::<module>#1",
            calleeName: "utils",
            kind: "reexport",
            sourceModule: "./helpers",
            localAlias: "utils",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/index.ts", line: 1 },
          },
        ],
      ],
      [
        "src/app.ts",
        [
          {
            callerId: "src/app.ts::main#1",
            calleeName: "secret",
            kind: "call",
            sourceModule: "./index",
            importedName: "secret",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/app.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);
    const appEdge = outgoing.get("src/app.ts")?.[0];
    expect(appEdge?.confidence).toBe("unresolved");
    expect(appEdge?.calleeCandidates).toHaveLength(0);
  });
});
