import type { ProjectEntry } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { projectListEntriesQueryOptions, projectQueryKeys } from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";

interface FileBrowserPanelProps {
  cwd: string | null;
  projectName: string;
  onOpenFile: (relativePath: string) => void;
}

interface TreeNode {
  entry: ProjectEntry;
  children: TreeNode[];
}

interface VisibleTreeRow {
  node: TreeNode;
  depth: number;
}

const MAX_RENDERED_TREE_ROWS = 1_500;

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? input : input.slice(separatorIndex + 1);
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function compareEntries(left: ProjectEntry, right: ProjectEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return basenameOf(left.path).localeCompare(basenameOf(right.path));
}

function buildTree(entries: readonly ProjectEntry[]): TreeNode[] {
  const nodeByPath = new Map<string, TreeNode>();
  for (const entry of entries) {
    nodeByPath.set(entry.path, { entry, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const node of nodeByPath.values()) {
    const parentPath = node.entry.parentPath ?? parentPathOf(node.entry.path);
    const parent = parentPath ? nodeByPath.get(parentPath) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNode = (node: TreeNode) => {
    node.children.sort((left, right) => compareEntries(left.entry, right.entry));
    for (const child of node.children) {
      sortNode(child);
    }
  };
  roots.sort((left, right) => compareEntries(left.entry, right.entry));
  for (const root of roots) {
    sortNode(root);
  }
  return roots;
}

function flattenVisibleRows(params: {
  nodes: readonly TreeNode[];
  expandedPaths: ReadonlySet<string>;
  normalizedQuery: string;
}): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];

  const visit = (node: TreeNode, depth: number): boolean => {
    const selfMatches =
      params.normalizedQuery.length === 0 ||
      node.entry.path.toLowerCase().includes(params.normalizedQuery);
    const childStartIndex = rows.length;
    let descendantMatches = false;

    if (
      params.normalizedQuery.length > 0 ||
      (node.entry.kind === "directory" && params.expandedPaths.has(node.entry.path))
    ) {
      for (const child of node.children) {
        descendantMatches = visit(child, depth + 1) || descendantMatches;
      }
    }

    if (selfMatches || descendantMatches) {
      rows.splice(childStartIndex, 0, { node, depth });
      return true;
    }

    rows.splice(childStartIndex);
    return false;
  };

  for (const node of params.nodes) {
    visit(node, 0);
  }

  return rows;
}

export default function FileBrowserPanel({ cwd, projectName, onOpenFile }: FileBrowserPanelProps) {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const entriesQuery = useQuery(projectListEntriesQueryOptions({ cwd }));
  const entries = entriesQuery.data?.entries ?? [];
  const tree = useMemo(() => buildTree(entries), [entries]);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleRows = useMemo(
    () => flattenVisibleRows({ nodes: tree, expandedPaths, normalizedQuery }),
    [expandedPaths, normalizedQuery, tree],
  );
  const renderedRows = visibleRows.slice(0, MAX_RENDERED_TREE_ROWS);
  const hiddenVisibleRowCount = visibleRows.length - renderedRows.length;
  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  useEffect(() => {
    if (entries.length === 0) {
      return;
    }
    setExpandedPaths((current) => {
      if (current.size > 0) {
        return current;
      }
      const next = new Set<string>();
      for (const entry of entries) {
        if (entry.kind === "directory" && !entry.path.includes("/")) {
          next.add(entry.path);
        }
      }
      return next;
    });
  }, [entries]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const refreshEntries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.listEntries(cwd) });
    void entriesQuery.refetch();
  }, [cwd, entriesQuery, queryClient]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{projectName}</p>
          <p className="truncate text-[10px] leading-none text-muted-foreground/80">
            {entriesQuery.isFetching && entries.length === 0
              ? "Indexing..."
              : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data && entriesQuery.data.totalEntries > entries.length
              ? ` · showing ${entries.length.toLocaleString()} of ${entriesQuery.data.totalEntries.toLocaleString()}`
              : ""}
            {entriesQuery.data?.truncated ? " · partial" : ""}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={refreshEntries}
          aria-label="Refresh workspace files"
        >
          <RefreshCwIcon className={cn("size-3.5", entriesQuery.isFetching && "animate-spin")} />
        </Button>
      </div>

      <div className="border-b border-border/50 p-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            size="sm"
            type="search"
            nativeInput
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search files"
            className="rounded-md [&_[data-slot=input]]:pl-8"
          />
        </div>
      </div>

      {entriesQuery.isError ? (
        <div className="p-3 text-xs leading-relaxed text-destructive">
          {entriesQuery.error instanceof Error
            ? entriesQuery.error.message
            : "Failed to load workspace files."}
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          {normalizedQuery ? "No matching files." : "No workspace files found."}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1" scrollFade>
          <div className="py-1">
            {renderedRows.map(({ node, depth }) => {
              const isDirectory = node.entry.kind === "directory";
              const expanded = expandedPaths.has(node.entry.path) || normalizedQuery.length > 0;
              const label = basenameOf(node.entry.path);
              return (
                <button
                  key={node.entry.path}
                  type="button"
                  className="flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  style={{ paddingLeft: 8 + depth * 14 }}
                  onClick={() => {
                    if (isDirectory) {
                      toggleDirectory(node.entry.path);
                    } else {
                      onOpenFile(node.entry.path);
                    }
                  }}
                >
                  {isDirectory ? (
                    expanded ? (
                      <ChevronDownIcon className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronRightIcon className="size-3.5 shrink-0" />
                    )
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}
                  {isDirectory ? (
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
                  ) : (
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
                  )}
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
            {hiddenVisibleRowCount > 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground/70">
                {hiddenVisibleRowCount.toLocaleString()} more entries hidden. Search to narrow
                results.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
