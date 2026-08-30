// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { describe, expect, it } from "vitest";
import {
  describeGraphBuilder,
  findCircularDependencies,
  generateMermaidDiagram,
  getFileDependencies,
  getGraphStats,
  isGraphBuilderStale,
  isImportResolutionLow,
  LOW_IMPORT_RESOLUTION_MIN_IMPORTS,
} from "../../src/services/graph-analysis.js";
import type { CodeGraph, CodeGraphEdge, CodeGraphNode } from "../../src/types.js";

// ── Helper to build mock graphs ────────────────────────────────────────

function makeNode(
  relativePath: string,
  deps: string[] = [],
  dependents: string[] = [],
): CodeGraphNode {
  return {
    filePath: `/project/${relativePath}`,
    relativePath,
    imports: deps.map((d) => `./${d}`),
    exports: [],
    dependencies: deps,
    dependents,
  };
}

function makeEdge(
  source: string,
  target: string,
  type: "import" | "re-export" | "dynamic-import" = "import",
): CodeGraphEdge {
  return { source, target, type };
}

function makeGraph(nodes: CodeGraphNode[], edges: CodeGraphEdge[]): CodeGraph {
  return { nodes, edges };
}

// ── A realistic small graph ──────────────────────────────────────────────
// index.ts → utils.ts → helpers.ts
// index.ts → types.ts
// types.ts (orphan-ish: no imports)

function createSampleGraph(): CodeGraph {
  const nodes: CodeGraphNode[] = [
    makeNode("src/index.ts", ["src/utils.ts", "src/types.ts"], []),
    makeNode("src/utils.ts", ["src/helpers.ts"], ["src/index.ts"]),
    makeNode("src/helpers.ts", [], ["src/utils.ts"]),
    makeNode("src/types.ts", [], ["src/index.ts"]),
  ];

  const edges: CodeGraphEdge[] = [
    makeEdge("src/index.ts", "src/utils.ts"),
    makeEdge("src/index.ts", "src/types.ts"),
    makeEdge("src/utils.ts", "src/helpers.ts"),
  ];

  return makeGraph(nodes, edges);
}

// ── A graph with circular dependencies ────────────────────────────────

function createCircularGraph(): CodeGraph {
  // A → B → C → A (cycle)
  const nodes: CodeGraphNode[] = [
    makeNode("a.ts", ["b.ts"], ["c.ts"]),
    makeNode("b.ts", ["c.ts"], ["a.ts"]),
    makeNode("c.ts", ["a.ts"], ["b.ts"]),
  ];

  const edges: CodeGraphEdge[] = [
    makeEdge("a.ts", "b.ts"),
    makeEdge("b.ts", "c.ts"),
    makeEdge("c.ts", "a.ts"),
  ];

  return makeGraph(nodes, edges);
}

describe("graph-analysis", () => {
  describe("getFileDependencies", () => {
    it("returns imports and importedBy for a file", () => {
      const graph = createSampleGraph();
      const deps = getFileDependencies(graph, "src/index.ts");

      expect(deps.imports).toContain("src/utils.ts");
      expect(deps.imports).toContain("src/types.ts");
      expect(deps.importedBy).toHaveLength(0); // nothing imports index.ts
    });

    it("returns dependents correctly", () => {
      const graph = createSampleGraph();
      const deps = getFileDependencies(graph, "src/utils.ts");

      expect(deps.imports).toContain("src/helpers.ts");
      expect(deps.importedBy).toContain("src/index.ts");
    });

    it("returns empty arrays for leaf files with no dependents", () => {
      const graph = createSampleGraph();
      const deps = getFileDependencies(graph, "src/helpers.ts");

      expect(deps.imports).toHaveLength(0);
      expect(deps.importedBy).toContain("src/utils.ts");
    });

    it("returns empty arrays for non-existent file", () => {
      const graph = createSampleGraph();
      const deps = getFileDependencies(graph, "nonexistent.ts");

      expect(deps.imports).toHaveLength(0);
      expect(deps.importedBy).toHaveLength(0);
    });

    it("normalizes Windows backslash paths to match forward-slash graph keys", () => {
      const graph = createSampleGraph();
      // Graph keys use forward slashes; simulate a Windows-style query
      const deps = getFileDependencies(graph, "src\\index.ts");

      expect(deps.imports).toContain("src/utils.ts");
      expect(deps.imports).toContain("src/types.ts");
    });

    it("normalizes deeply nested Windows paths", () => {
      const nodes: CodeGraphNode[] = [
        makeNode("src/services/graph/analysis.ts", ["src/types.ts"], []),
        makeNode("src/types.ts", [], ["src/services/graph/analysis.ts"]),
      ];
      const edges: CodeGraphEdge[] = [
        makeEdge("src/services/graph/analysis.ts", "src/types.ts"),
      ];
      const graph = makeGraph(nodes, edges);

      const deps = getFileDependencies(graph, "src\\services\\graph\\analysis.ts");
      expect(deps.imports).toContain("src/types.ts");
    });

    it("handles mixed separator paths", () => {
      const graph = createSampleGraph();
      const deps = getFileDependencies(graph, "src/utils.ts");
      const depsMixed = getFileDependencies(graph, "src\\utils.ts");

      expect(depsMixed.imports).toEqual(deps.imports);
      expect(depsMixed.importedBy).toEqual(deps.importedBy);
    });

    it("finds nodes in a legacy cached graph with backslash keys", () => {
      // Simulate a graph built on Windows before the fix: stored keys have backslashes
      const nodes: CodeGraphNode[] = [
        makeNode("src\\services\\api.ts", ["src\\types.ts"], []),
        makeNode("src\\types.ts", [], ["src\\services\\api.ts"]),
      ];
      // Fix relativePath (makeNode sets it from the argument)
      nodes[0].relativePath = "src\\services\\api.ts";
      nodes[1].relativePath = "src\\types.ts";

      const edges: CodeGraphEdge[] = [
        makeEdge("src\\services\\api.ts", "src\\types.ts"),
      ];
      const graph = makeGraph(nodes, edges);

      // Query with forward slashes should still find the node
      const deps = getFileDependencies(graph, "src/services/api.ts");
      expect(deps.imports).toContain("src\\types.ts");
    });
  });

  describe("findCircularDependencies", () => {
    it("returns empty array when no cycles exist", () => {
      const graph = createSampleGraph();
      const cycles = findCircularDependencies(graph);
      expect(cycles).toHaveLength(0);
    });

    it("detects circular dependencies", () => {
      const graph = createCircularGraph();
      const cycles = findCircularDependencies(graph);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("cycle path starts and ends with the same file", () => {
      const graph = createCircularGraph();
      const cycles = findCircularDependencies(graph);
      for (const cycle of cycles) {
        expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      }
    });

    it("handles empty graph", () => {
      const graph = makeGraph([], []);
      const cycles = findCircularDependencies(graph);
      expect(cycles).toHaveLength(0);
    });

    it("handles single-node graph", () => {
      const graph = makeGraph([makeNode("solo.ts")], []);
      const cycles = findCircularDependencies(graph);
      expect(cycles).toHaveLength(0);
    });

    it("detects self-import cycle", () => {
      const node = makeNode("self.ts", ["self.ts"], ["self.ts"]);
      const graph = makeGraph([node], [makeEdge("self.ts", "self.ts")]);
      const cycles = findCircularDependencies(graph);
      expect(cycles.length).toBeGreaterThan(0);
    });
  });

  describe("getGraphStats", () => {
    it("returns correct total files", () => {
      const graph = createSampleGraph();
      const stats = getGraphStats(graph);
      expect(stats.totalFiles).toBe(4);
    });

    it("returns correct total edges", () => {
      const graph = createSampleGraph();
      const stats = getGraphStats(graph);
      expect(stats.totalEdges).toBe(3);
    });

    it("calculates average dependencies", () => {
      const graph = createSampleGraph();
      const stats = getGraphStats(graph);
      expect(stats.avgDependencies).toBe(3 / 4);
    });

    it("identifies most connected files", () => {
      const graph = createSampleGraph();
      const stats = getGraphStats(graph);
      expect(stats.mostConnected.length).toBeGreaterThan(0);
      // index.ts has 2 deps + 0 dependents = 2 connections
      // utils.ts has 1 dep + 1 dependent = 2 connections
      const indexEntry = stats.mostConnected.find((f) => f.file === "src/index.ts");
      expect(indexEntry).toBeDefined();
      expect(indexEntry?.connections).toBe(2);
    });

    it("identifies orphan files (no deps and no dependents)", () => {
      // Add a true orphan to the graph
      const graph = createSampleGraph();
      graph.nodes.push(makeNode("orphan.ts"));
      const stats = getGraphStats(graph);
      expect(stats.orphans).toContain("orphan.ts");
    });

    it("counts circular dependencies", () => {
      const graph = createCircularGraph();
      const stats = getGraphStats(graph);
      expect(stats.circularDeps).toBeGreaterThan(0);
    });

    it("returns language breakdown", () => {
      const graph = createSampleGraph();
      const stats = getGraphStats(graph);
      expect(stats.languageBreakdown).toBeDefined();
      expect(stats.languageBreakdown.typescript).toBe(4);
    });

    it("handles empty graph", () => {
      const graph = makeGraph([], []);
      const stats = getGraphStats(graph);
      expect(stats.totalFiles).toBe(0);
      expect(stats.totalEdges).toBe(0);
      expect(stats.avgDependencies).toBe(0);
      expect(stats.mostConnected).toHaveLength(0);
      expect(stats.orphans).toHaveLength(0);
      expect(stats.circularDeps).toBe(0);
    });

    it("limits mostConnected to top 10", () => {
      // Create a graph with more than 10 nodes
      const nodes: CodeGraphNode[] = [];
      const edges: CodeGraphEdge[] = [];
      for (let i = 0; i < 15; i++) {
        nodes.push(makeNode(`file${i}.ts`));
      }
      const graph = makeGraph(nodes, edges);
      const stats = getGraphStats(graph);
      expect(stats.mostConnected.length).toBeLessThanOrEqual(10);
    });
  });

  describe("generateMermaidDiagram", () => {
    it("generates a valid Mermaid diagram", () => {
      const graph = createSampleGraph();
      const mermaid = generateMermaidDiagram(graph);

      expect(mermaid).toContain("graph LR");
    });

    it("includes node declarations with file basenames", () => {
      const graph = createSampleGraph();
      const mermaid = generateMermaidDiagram(graph);

      expect(mermaid).toContain('"index.ts"');
      expect(mermaid).toContain('"utils.ts"');
      expect(mermaid).toContain('"helpers.ts"');
      expect(mermaid).toContain('"types.ts"');
    });

    it("includes edge arrows", () => {
      const graph = createSampleGraph();
      const mermaid = generateMermaidDiagram(graph);

      // Should have arrow notation
      expect(mermaid).toContain("-->");
    });

    it("handles empty graph", () => {
      const graph = makeGraph([], []);
      const mermaid = generateMermaidDiagram(graph);
      expect(mermaid).toContain("No files found");
    });

    it("marks circular dependency edges specially", () => {
      const graph = createCircularGraph();
      const mermaid = generateMermaidDiagram(graph);

      // Circular edges should use dotted lines with |cycle| label
      expect(mermaid).toContain("-.->|cycle|");
    });

    it("includes style directives with colors", () => {
      const graph = createSampleGraph();
      const mermaid = generateMermaidDiagram(graph);

      // TypeScript nodes should have the TypeScript color fill
      expect(mermaid).toContain("style");
      expect(mermaid).toContain("fill:");
    });

    it("handles dynamic-import edges with dotted lines", () => {
      const graph = makeGraph(
        [makeNode("a.ts", ["b.ts"], []), makeNode("b.ts", [], ["a.ts"])],
        [makeEdge("a.ts", "b.ts", "dynamic-import")],
      );
      const mermaid = generateMermaidDiagram(graph);
      // Dynamic imports use dotted lines (-.->)
      expect(mermaid).toContain("-.->"); 
    });

    it("includes a legend for multi-language graphs", () => {
      const nodes: CodeGraphNode[] = [
        makeNode("app.ts", [], []),
        makeNode("lib.py", [], []),
      ];
      // Fix the filePath to have proper extension recognition
      nodes[1].filePath = "/project/lib.py";

      const graph = makeGraph(nodes, []);
      const mermaid = generateMermaidDiagram(graph);
      expect(mermaid).toContain("subgraph Legend");
    });
  });

  // ── Import-resolution yield (#107) ───────────────────────────────────

  describe("isImportResolutionLow", () => {
    // codebase_graph_status reports READY on graph existence alone, so a
    // resolver failure and a healthy graph are indistinguishable downstream.
    // These pin the measurement that tells them apart.

    it("flags a graph that resolved almost none of its captured imports", () => {
      // Measured on the issue #107 repo before the fix: 35 of 2,959 (1.2%).
      expect(isImportResolutionLow(35, 2959)).toBe(true);
    });

    it("stays quiet on the same repo once the resolver handles its layout", () => {
      // The same repo after the fix: 2,103 of 2,959 (71%).
      expect(isImportResolutionLow(2103, 2959)).toBe(false);
    });

    it("stays quiet on a project whose imports are mostly external", () => {
      // Measured on a doc-heavy repo: 23 of 304 (7.6%). Few in-tree imports
      // and many external ones is a healthy shape, not a resolver failure.
      expect(isImportResolutionLow(23, 304)).toBe(false);
    });

    it("stays quiet just above the ratio and fires just below it", () => {
      // Boundary either side of 2%, at an import count well over the floor.
      expect(isImportResolutionLow(21, 1000)).toBe(false);
      expect(isImportResolutionLow(19, 1000)).toBe(true);
    });

    it("treats a ratio exactly at the threshold as acceptable", () => {
      expect(isImportResolutionLow(20, 1000)).toBe(false);
    });

    it("says nothing about a project with too few imports to judge", () => {
      // A five-file utility repo importing only `os` and `json` resolves zero
      // and is correct; the ratio carries no signal at this size.
      expect(isImportResolutionLow(0, LOW_IMPORT_RESOLUTION_MIN_IMPORTS - 1)).toBe(false);
      expect(isImportResolutionLow(0, 0)).toBe(false);
    });

    it("judges a project once it reaches the import floor", () => {
      expect(isImportResolutionLow(0, LOW_IMPORT_RESOLUTION_MIN_IMPORTS)).toBe(true);
    });

    it("says nothing when the count is absent on an older persisted graph", () => {
      // importCount post-dates existing graphs; those print nothing until the
      // next rebuild rather than being guessed at.
      expect(isImportResolutionLow(0, undefined)).toBe(false);
    });
  });

  describe("isGraphBuilderStale", () => {
    it("flags a graph built by an earlier release", () => {
      // The issue #120 case: a graph cut by v1.10.0 and served by v1.12.0,
      // four days and one shipped resolver apart, with every visible signal
      // reporting the server rather than the artifact.
      expect(isGraphBuilderStale("1.10.0", "1.12.0")).toBe(true);
      expect(isGraphBuilderStale("1.12.0", "1.12.1")).toBe(true);
      expect(isGraphBuilderStale("0.9.9", "1.0.0")).toBe(true);
    });

    it("does not flag a matching or newer builder", () => {
      expect(isGraphBuilderStale("1.12.0", "1.12.0")).toBe(false);
      // A downgrade: unusual, but the graph is not missing anything the
      // running build has.
      expect(isGraphBuilderStale("1.13.0", "1.12.0")).toBe(false);
    });

    it("compares segments numerically, not as text", () => {
      expect(isGraphBuilderStale("1.9.0", "1.10.0")).toBe(true);
      expect(isGraphBuilderStale("1.10.0", "1.9.0")).toBe(false);
    });

    it("treats absent segments as zero", () => {
      expect(isGraphBuilderStale("1.12", "1.12.1")).toBe(true);
      expect(isGraphBuilderStale("1.12", "1.12.0")).toBe(false);
    });

    it("says nothing when the stamp is absent on an older persisted graph", () => {
      // Unknown is not stale. The caller says so in its own words and points
      // at a rebuild, rather than claiming a version it does not have.
      expect(isGraphBuilderStale(undefined, "1.12.0")).toBe(false);
      expect(isGraphBuilderStale("", "1.12.0")).toBe(false);
    });

    it("says nothing when either version does not read as a release", () => {
      expect(isGraphBuilderStale("dev", "1.12.0")).toBe(false);
      expect(isGraphBuilderStale("1.12.0", "unknown")).toBe(false);
      expect(isGraphBuilderStale("1.2.3.4.5", "1.12.0")).toBe(false);
    });

    it("ignores prerelease and build suffixes", () => {
      // A prerelease of a release carries that release's resolvers, so it is
      // not behind it.
      expect(isGraphBuilderStale("1.13.0-beta.1", "1.13.0")).toBe(false);
      expect(isGraphBuilderStale("v1.11.0", "1.12.0+build.7")).toBe(true);
    });
  });

  describe("describeGraphBuilder", () => {
    it("states the builder and nothing more when it matches the server", () => {
      expect(describeGraphBuilder("1.12.0", "1.12.0")).toEqual(["Built by: v1.12.0"]);
    });

    it("names both versions and points at a rebuild when the graph is behind", () => {
      const lines = describeGraphBuilder("1.10.0", "1.12.0");
      expect(lines[0]).toContain("Built by: v1.10.0");
      expect(lines[0]).toContain("STALE");
      expect(lines[0]).toContain("this server is v1.12.0");
      expect(lines[1]).toContain("codebase_graph_build");
    });

    it("says unknown, not stale, for a graph persisted before the stamp existed", () => {
      // The exact case the stamp was added for: claiming a version here would
      // be inventing one. Saying it is unrecorded, and that a rebuild settles
      // it, is the whole of what is known.
      const lines = describeGraphBuilder(undefined, "1.12.0");
      expect(lines[0]).toContain("unknown");
      expect(lines[0]).not.toContain("STALE");
      expect(lines[1]).toContain("codebase_graph_build");
    });
  });
});
