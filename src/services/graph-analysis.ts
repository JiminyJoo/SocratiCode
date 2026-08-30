// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import path from "node:path";
import { getLanguageFromExtension, toForwardSlash } from "../constants.js";
import type { CodeGraph, CodeGraphNode } from "../types.js";

/**
 * Resolve a graph node's language for display/stats. Prefers the language stored
 * on the node at build time (correct for extensionless files, whose path carries
 * no extension); falls back to deriving it from the path extension for nodes with
 * no stored language (older persisted graphs, grammar-less extra-extension nodes,
 * and import-target-only nodes that discovery never content-detected).
 */
export function nodeLanguage(node: Pick<CodeGraphNode, "language" | "relativePath">): string {
  return node.language ?? getLanguageFromExtension(path.extname(node.relativePath).toLowerCase());
}

/**
 * Fraction of captured imports that must resolve to project files before the
 * file graph is reported without a caveat.
 *
 * Measured across real repos, a resolver that cannot see a project's layout
 * lands an order of magnitude below one that can. The same 618-file Python
 * workspace resolved 35 of its 2,959 captured imports (1.2%) before the
 * issue #107 fix and 2,103 of them (71%) after; a second Python repo sits at
 * 42%, and a doc-heavy repo whose imports are largely external still reaches
 * 7.6%. 2% sits in the gap between the broken regime and the lowest healthy
 * reading, so the advisory fires on a resolver failure without nagging a
 * project that merely imports a lot of external code.
 *
 * It is a caveat on how to read the graph, not a verdict on the project: a
 * repo of scripts that import nothing but stdlib genuinely resolves near zero
 * and will trip this. That is why the advisory states what was measured and
 * names the benign explanation, and why there is no DEGRADED status token.
 */
export const LOW_IMPORT_RESOLUTION_RATIO = 0.02;

/**
 * Captured-import floor below which the ratio is not reported on at all.
 *
 * A handful of imports carries no signal — a five-file utility repo that
 * imports nothing but `os` and `json` would otherwise be told its graph is
 * degraded when it is complete and correct.
 */
export const LOW_IMPORT_RESOLUTION_MIN_IMPORTS = 20;

/**
 * Whether a built graph resolved so few of the imports it captured that its
 * dependency answers should be read as under-reporting rather than as
 * findings.
 *
 * `codebase_graph_status` reports READY on graph existence alone, so a graph
 * that resolved almost nothing is indistinguishable from a healthy one, and
 * every downstream tool answers "no dependency information" — which reads as
 * "nothing depends on this" rather than "the resolver failed" (issue #107).
 * Comparing resolved edges against the imports actually captured is what
 * separates the two: it is a per-project ratio that does not move with repo
 * size, unlike an absolute edge count, and it is not the symbol graph's
 * `unresolvedEdgePct`, which measures call-site resolution and reads high on
 * healthy repos.
 *
 * `importCount` is absent on graphs persisted before it was recorded; those
 * return false and print nothing until the next rebuild, rather than guessing.
 */
export function isImportResolutionLow(edgeCount: number, importCount?: number): boolean {
  if (importCount === undefined || importCount < LOW_IMPORT_RESOLUTION_MIN_IMPORTS) return false;
  return edgeCount / importCount < LOW_IMPORT_RESOLUTION_RATIO;
}

/**
 * Numeric release segments of a version string, or null when it does not read
 * as one. Any prerelease or build suffix is dropped, so `1.13.0-beta.1` and
 * `1.13.0` compare equal — deliberately: the question here is whether a graph
 * predates a shipped resolver, and a prerelease of the same release carries the
 * same ones.
 */
function releaseSegments(version: string): number[] | null {
  const core = version.trim().replace(/^v/, "").split(/[-+]/)[0];
  const parts = core.split(".");
  // No floor check: split always yields at least one element, and the digit
  // test below is what rejects the empty string it yields for empty input.
  if (parts.length > 4) return null;
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  return parts.map(Number);
}

/**
 * Whether a persisted graph was built by an older release than the one now
 * serving it.
 *
 * A graph is stored once and served unchanged until something rebuilds it, so
 * an upgrade leaves the old artifact in place: the new binary answers queries
 * from a graph whose edges were resolved by the old one. Every signal a user
 * can read says healthy — `codebase_about` reports the new version because that
 * is the running binary, status reports READY because a graph exists — so a
 * graph cut before a language's resolver shipped is indistinguishable from that
 * resolver being broken. That cost a real bug report (issue #120), where a
 * 27-day-old graph built four days before PSR-4 resolution existed was measured
 * as a live defect in the current release.
 *
 * Returns false when either version is absent or unparseable: a graph persisted
 * before the stamp existed is unknown rather than stale, which the caller says
 * in its own words instead of guessing.
 */
export function isGraphBuilderStale(
  builtByVersion: string | undefined,
  runningVersion: string,
): boolean {
  if (!builtByVersion) return false;
  const built = releaseSegments(builtByVersion);
  const running = releaseSegments(runningVersion);
  if (!built || !running) return false;
  for (let i = 0; i < Math.max(built.length, running.length); i++) {
    const a = built[i] ?? 0;
    const b = running[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/**
 * The `Built by:` lines for `codebase_graph_status`: which build produced the
 * graph being served, and whether that is the build now answering.
 *
 * Warns rather than rebuilding. A rebuild is minutes of work on a large repo
 * and is the user's call, not a status call's side effect — and the reason to
 * surface this at all is that the user had no way to tell a stale artifact from
 * a broken resolver, which a sentence fixes.
 */
export function describeGraphBuilder(
  builtByVersion: string | undefined,
  runningVersion: string,
): string[] {
  if (!builtByVersion) {
    return [
      "Built by: unknown (persisted before the builder version was recorded)",
      `  Run codebase_graph_build to rebuild with v${runningVersion} and confirm this graph reflects the current resolvers.`,
    ];
  }
  if (isGraphBuilderStale(builtByVersion, runningVersion)) {
    return [
      `Built by: v${builtByVersion} — STALE, this server is v${runningVersion}`,
      `  This graph's edges were resolved by the older build, so any resolver fix or language support added since v${builtByVersion} is absent from it. Run codebase_graph_build.`,
    ];
  }
  return [`Built by: v${builtByVersion}`];
}

/**
 * Get dependencies for a specific file.
 * The input path is normalized to forward slashes so lookups succeed
 * regardless of whether the caller passes `/` or `\` separators.
 */
export function getFileDependencies(graph: CodeGraph, relativePath: string): {
  imports: string[];
  importedBy: string[];
} {
  const normalized = toForwardSlash(relativePath);
  const node = graph.nodes.find((n) => toForwardSlash(n.relativePath) === normalized);
  if (!node) {
    return { imports: [], importedBy: [] };
  }
  return {
    imports: node.dependencies,
    importedBy: node.dependents,
  };
}

/**
 * Find circular dependencies in the graph.
 */
export function findCircularDependencies(graph: CodeGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const pathStack: string[] = [];

  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) {
    adjacency.set(node.relativePath, node.dependencies);
  }

  function dfs(node: string): void {
    visited.add(node);
    stack.add(node);
    pathStack.push(node);

    const deps = adjacency.get(node) || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        dfs(dep);
      } else if (stack.has(dep)) {
        // Found a cycle
        const cycleStart = pathStack.indexOf(dep);
        if (cycleStart >= 0) {
          cycles.push([...pathStack.slice(cycleStart), dep]);
        }
      }
    }

    stack.delete(node);
    pathStack.pop();
  }

  for (const node of graph.nodes) {
    if (!visited.has(node.relativePath)) {
      dfs(node.relativePath);
    }
  }

  return cycles;
}

/**
 * Get summary statistics about the code graph.
 */
export function getGraphStats(graph: CodeGraph): {
  totalFiles: number;
  totalEdges: number;
  avgDependencies: number;
  mostConnected: Array<{ file: string; connections: number }>;
  orphans: string[];
  circularDeps: number;
  languageBreakdown: Record<string, number>;
} {
  const totalFiles = graph.nodes.length;
  const totalEdges = graph.edges.length;
  const avgDependencies = totalFiles > 0 ? totalEdges / totalFiles : 0;

  const connections = graph.nodes.map((n) => ({
    file: n.relativePath,
    connections: n.dependencies.length + n.dependents.length,
  }));
  connections.sort((a, b) => b.connections - a.connections);

  const mostConnected = connections.slice(0, 10);
  const orphans = graph.nodes
    .filter((n) => n.dependencies.length === 0 && n.dependents.length === 0)
    .map((n) => n.relativePath);

  const circularDeps = findCircularDependencies(graph).length;

  // Language breakdown
  const languageBreakdown: Record<string, number> = {};
  for (const node of graph.nodes) {
    const lang = nodeLanguage(node);
    languageBreakdown[lang] = (languageBreakdown[lang] || 0) + 1;
  }

  return { totalFiles, totalEdges, avgDependencies, mostConnected, orphans, circularDeps, languageBreakdown };
}

/**
 * Generate a Mermaid diagram from a code graph.
 * Produces a flowchart showing file dependencies with color-coded language groups.
 */
export function generateMermaidDiagram(graph: CodeGraph): string {
  if (graph.nodes.length === 0) return "graph LR\n  empty[No files found]";

  const lines: string[] = ["graph LR"];

  // Language → color mapping for styling
  const langColors: Record<string, string> = {
    typescript: "#3178C6", javascript: "#F7DF1E", python: "#3776AB",
    java: "#ED8B00", kotlin: "#7F52FF", go: "#00ADD8",
    rust: "#CE422B", ruby: "#CC342D", php: "#777BB4",
    swift: "#FA7343", c: "#A8B9CC", cpp: "#00599C",
    csharp: "#239120", scala: "#DC322F", dart: "#0175C2",
    elixir: "#4B275F", lua: "#2C2D72", shell: "#4EAA25",
  };

  // Create safe node IDs and labels
  const nodeIds = new Map<string, string>();
  let idCounter = 0;
  for (const node of graph.nodes) {
    const safeId = `n${idCounter++}`;
    nodeIds.set(node.relativePath, safeId);
  }

  // Find circular dependency edges for highlighting
  const cycles = findCircularDependencies(graph);
  const cyclicEdges = new Set<string>();
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.length - 1; i++) {
      cyclicEdges.add(`${cycle[i]}-->${cycle[i + 1]}`);
    }
  }

  // Emit node declarations with short labels
  for (const node of graph.nodes) {
    const id = nodeIds.get(node.relativePath) ?? "";
    const label = path.basename(node.relativePath);
    lines.push(`    ${id}["${label}"]`);
  }

  lines.push("");

  // Emit edges (deduplicated)
  const emittedEdges = new Set<string>();
  for (const edge of graph.edges) {
    const sourceId = nodeIds.get(edge.source);
    const targetId = nodeIds.get(edge.target);
    if (!sourceId || !targetId) continue;

    const dedupKey = `${sourceId}->${targetId}`;
    if (emittedEdges.has(dedupKey)) continue;
    emittedEdges.add(dedupKey);

    const edgeKey = `${edge.source}-->${edge.target}`;
    if (cyclicEdges.has(edgeKey)) {
      // Red dotted line for circular deps
      lines.push(`    ${sourceId} -.->|cycle| ${targetId}`);
    } else if (edge.type === "dynamic-import") {
      lines.push(`    ${sourceId} -.-> ${targetId}`);
    } else {
      lines.push(`    ${sourceId} --> ${targetId}`);
    }
  }

  lines.push("");

  // Style nodes by language
  const langNodes = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const lang = nodeLanguage(node);
    if (!langNodes.has(lang)) langNodes.set(lang, []);
    const nid = nodeIds.get(node.relativePath);
    if (nid) langNodes.get(lang)?.push(nid);
  }

  for (const [lang, ids] of langNodes) {
    const color = langColors[lang] || "#607D8B";
    for (const id of ids) {
      lines.push(`    style ${id} fill:${color},color:#fff,stroke:${color}`);
    }
  }

  // Add a legend as a subgraph
  const usedLangs = [...langNodes.keys()].filter(l => langColors[l]);
  if (usedLangs.length > 1) {
    lines.push("");
    lines.push("    subgraph Legend");
    lines.push("    direction LR");
    for (const lang of usedLangs) {
      const legendId = `legend_${lang}`;
      lines.push(`    ${legendId}["${lang}"]`);
      lines.push(`    style ${legendId} fill:${langColors[lang]},color:#fff,stroke:${langColors[lang]}`);
    }
    lines.push("    end");
  }

  return lines.join("\n");
}
