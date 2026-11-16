import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildFileTree,
  flattenVisibleTreeRows,
  resolveSearchEntryForEnter,
} from "./FileBrowserPanel";

const SEARCH_ENTRIES: ProjectEntry[] = [
  { path: "src/components", kind: "directory" },
  { path: "src/App.tsx", kind: "file" },
  { path: "README.md", kind: "file" },
];

describe("resolveSearchEntryForEnter", () => {
  it("uses the highlighted file when one is highlighted", () => {
    expect(resolveSearchEntryForEnter(SEARCH_ENTRIES, 1)?.path).toBe("src/App.tsx");
  });

  it("uses the highlighted directory when one is highlighted", () => {
    expect(resolveSearchEntryForEnter(SEARCH_ENTRIES, 0)?.path).toBe("src/components");
  });

  it("falls back to the first file when nothing is highlighted", () => {
    expect(resolveSearchEntryForEnter(SEARCH_ENTRIES, -1)?.path).toBe("src/App.tsx");
  });
});

const TREE_ENTRIES: ProjectEntry[] = [
  { path: "README.md", kind: "file" },
  { path: "src/b.ts", kind: "file", parentPath: "src" },
  { path: "src", kind: "directory" },
  { path: "src/lib", kind: "directory", parentPath: "src" },
  { path: "src/lib/util.ts", kind: "file", parentPath: "src/lib" },
  { path: "src/a.ts", kind: "file", parentPath: "src" },
  { path: "docs", kind: "directory" },
  { path: "docs/guide.md", kind: "file", parentPath: "docs" },
];

function rowPaths(rows: ReturnType<typeof flattenVisibleTreeRows>) {
  return rows.map((row) => `${"  ".repeat(row.depth)}${row.node.entry.path}`);
}

describe("flattenVisibleTreeRows", () => {
  it("emits expanded directories in preorder, directories first", () => {
    const rows = flattenVisibleTreeRows({
      nodes: buildFileTree(TREE_ENTRIES),
      expandedPaths: new Set(["src", "src/lib"]),
      normalizedQuery: "",
    });
    expect(rowPaths(rows)).toEqual([
      "docs",
      "src",
      "  src/lib",
      "    src/lib/util.ts",
      "  src/a.ts",
      "  src/b.ts",
      "README.md",
    ]);
  });

  it("hides children of collapsed directories, including expanded descendants", () => {
    const rows = flattenVisibleTreeRows({
      nodes: buildFileTree(TREE_ENTRIES),
      expandedPaths: new Set(["src/lib"]),
      normalizedQuery: "",
    });
    expect(rowPaths(rows)).toEqual(["docs", "src", "README.md"]);
  });

  it("with a query, shows matches and their ancestors regardless of expansion", () => {
    const rows = flattenVisibleTreeRows({
      nodes: buildFileTree(TREE_ENTRIES),
      expandedPaths: new Set(),
      normalizedQuery: "util",
    });
    expect(rowPaths(rows)).toEqual(["src", "  src/lib", "    src/lib/util.ts"]);
  });

  it("handles deep nesting without recursion limits", () => {
    const depth = 20_000;
    const entries: ProjectEntry[] = [];
    const expandedPaths = new Set<string>();
    let path = "";
    for (let level = 0; level < depth; level += 1) {
      const parentPath = path;
      path = path ? `${path}/d` : "d";
      entries.push(
        parentPath ? { path, kind: "directory", parentPath } : { path, kind: "directory" },
      );
      expandedPaths.add(path);
    }
    entries.push({ path: `${path}/leaf.ts`, kind: "file", parentPath: path });

    const nodes = buildFileTree(entries);
    const rows = flattenVisibleTreeRows({ nodes, expandedPaths, normalizedQuery: "" });
    expect(rows).toHaveLength(depth + 1);
    expect(rows.at(-1)).toMatchObject({ depth, node: { name: "leaf.ts" } });

    const matched = flattenVisibleTreeRows({
      nodes,
      expandedPaths: new Set(),
      normalizedQuery: "leaf",
    });
    expect(matched).toHaveLength(depth + 1);
  });

  it("flattens 100,000 entries in one linear pass", () => {
    const entries: ProjectEntry[] = [];
    const expandedPaths = new Set<string>();
    for (let directory = 0; directory < 1_000; directory += 1) {
      const directoryPath = `dir-${directory}`;
      entries.push({ path: directoryPath, kind: "directory" });
      expandedPaths.add(directoryPath);
      for (let file = 0; file < 99; file += 1) {
        entries.push({
          path: `${directoryPath}/file-${file}.ts`,
          kind: "file",
          parentPath: directoryPath,
        });
      }
    }
    expect(entries).toHaveLength(99_000 + 1_000);

    const startedAt = performance.now();
    const nodes = buildFileTree(entries);
    const rows = flattenVisibleTreeRows({ nodes, expandedPaths, normalizedQuery: "" });
    const queried = flattenVisibleTreeRows({
      nodes,
      expandedPaths: new Set(),
      normalizedQuery: "file-98",
    });
    const elapsedMs = performance.now() - startedAt;

    expect(rows).toHaveLength(100_000);
    expect(queried).toHaveLength(2_000);
    // Generous bound so slow CI machines do not flake.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
