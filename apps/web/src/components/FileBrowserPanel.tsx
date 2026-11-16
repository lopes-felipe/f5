import { useRightPanelStore } from "../rightPanelStore";
import type {
  ProjectEntry,
  ProjectId,
  ProjectListEntriesResult,
  ThreadId,
} from "@t3tools/contracts";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";

import {
  projectListDirectoryQueryOptions,
  projectQueryKeys,
  projectSearchEntriesQueryOptions,
} from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { useWatchedWorkspacePaths } from "../lib/workspaceWatch";
import { readNativeApi } from "../nativeApi";
import { insertFileMentionIntoComposer } from "./composerFileMentionInsertion";
import { showFileEntryContextMenu } from "./fileEntryActions";
import { writeFileTreeDragMention } from "./fileTreeDragMention";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";

interface FileBrowserPanelProps {
  cwd: string | null;
  projectId: ProjectId | null;
  threadId: ThreadId;
  workspaceIdentity: string | null;
  projectName: string;
  entryLimit: number;
  onOpenFile: (relativePath: string) => void;
}

export interface TreeNode {
  entry: ProjectEntry;
  name: string;
  children: TreeNode[];
}

export interface VisibleTreeRow {
  node: TreeNode;
  depth: number;
}

const TREE_ROW_HEIGHT_PX = 28;
const SEARCH_ENTRIES_LIMIT = 100;
const SEARCH_INPUT_DEBOUNCE_MS = 180;

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? input : input.slice(separatorIndex + 1);
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function ancestorDirectoryPathsOf(entry: ProjectEntry): string[] {
  const paths: string[] = [];
  let currentPath =
    entry.kind === "directory" ? entry.path : (entry.parentPath ?? parentPathOf(entry.path));
  while (currentPath) {
    paths.push(currentPath);
    currentPath = parentPathOf(currentPath);
  }
  return paths.reverse();
}

// Same ordering as `localeCompare` without per-call locale resolution.
const entryNameCollator = new Intl.Collator();

function compareNodes(left: TreeNode, right: TreeNode): number {
  if (left.entry.kind !== right.entry.kind) {
    return left.entry.kind === "directory" ? -1 : 1;
  }
  return entryNameCollator.compare(left.name, right.name);
}

/** Directories first, then by name; iterative, so nesting depth is unbounded. */
export function buildFileTree(entries: readonly ProjectEntry[]): TreeNode[] {
  const nodeByPath = new Map<string, TreeNode>();
  for (const entry of entries) {
    nodeByPath.set(entry.path, { entry, name: basenameOf(entry.path), children: [] });
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

  roots.sort(compareNodes);
  for (const node of nodeByPath.values()) {
    if (node.children.length > 1) node.children.sort(compareNodes);
  }
  return roots;
}

/** Nodes whose path matches `normalizedQuery`, plus all of their ancestors. */
function collectMatchingNodes(
  nodes: readonly TreeNode[],
  normalizedQuery: string,
): ReadonlySet<TreeNode> {
  const included = new Set<TreeNode>();
  const parentOf = new Map<TreeNode, TreeNode | null>();
  const stack: TreeNode[] = [];
  for (const node of nodes) {
    parentOf.set(node, null);
    stack.push(node);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.entry.path.toLowerCase().includes(normalizedQuery)) {
      // Each node joins once, so marking ancestors is linear overall.
      let current: TreeNode | null | undefined = node;
      while (current && !included.has(current)) {
        included.add(current);
        current = parentOf.get(current);
      }
    }
    for (const child of node.children) {
      parentOf.set(child, node);
      stack.push(child);
    }
  }
  return included;
}

/**
 * Visible rows in preorder: children of expanded directories, or with a query,
 * matching nodes and their ancestors. Linear in the visited nodes.
 */
export function flattenVisibleTreeRows(params: {
  nodes: readonly TreeNode[];
  expandedPaths: ReadonlySet<string>;
  normalizedQuery: string;
}): VisibleTreeRow[] {
  const included =
    params.normalizedQuery.length > 0
      ? collectMatchingNodes(params.nodes, params.normalizedQuery)
      : null;
  const rows: VisibleTreeRow[] = [];
  const stack: VisibleTreeRow[] = [];
  const pushChildren = (nodes: readonly TreeNode[], depth: number) => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index]!;
      if (!included || included.has(node)) stack.push({ node, depth });
    }
  };
  pushChildren(params.nodes, 0);
  while (stack.length > 0) {
    const row = stack.pop()!;
    rows.push(row);
    const { entry, children } = row.node;
    if (included || (entry.kind === "directory" && params.expandedPaths.has(entry.path))) {
      pushChildren(children, row.depth + 1);
    }
  }
  return rows;
}

/**
 * One listing across the loaded directories. Query results are structurally
 * shared, so `data.entries` keeps its identity (and the tree its memo) while
 * only fetch status changes.
 */
function combineDirectoryQueries(queries: ReadonlyArray<UseQueryResult<ProjectListEntriesResult>>) {
  return {
    queries,
    data: {
      entries: queries.flatMap((query) => query.data?.entries ?? []),
      totalEntries: queries.reduce((sum, query) => sum + (query.data?.totalEntries ?? 0), 0),
      truncated: queries.some((query) => query.data?.truncated),
    },
    isFetching: queries.some((query) => query.isFetching),
    isError: queries[0]?.isError ?? false,
    error: queries[0]?.error,
  };
}

const treeRowKey = (row: VisibleTreeRow) => row.node.entry.path;
const treeRowFixedSize = () => TREE_ROW_HEIGHT_PX;

export function resolveSearchEntryForEnter(
  entries: readonly ProjectEntry[],
  highlightedIndex: number,
): ProjectEntry | null {
  const highlightedEntry = highlightedIndex >= 0 ? entries[highlightedIndex] : undefined;
  return highlightedEntry ?? entries.find((entry) => entry.kind === "file") ?? null;
}

export default function FileBrowserPanel({
  cwd,
  projectId,
  threadId,
  workspaceIdentity,
  projectName,
  entryLimit,
  onOpenFile,
}: FileBrowserPanelProps) {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedSearchIndex, setHighlightedSearchIndex] = useState(-1);
  const [directoryLimit, setDirectoryLimit] = useState(entryLimit);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const treeListRef = useRef<LegendListRef | null>(null);
  const pendingRevealPathRef = useRef<string | null>(null);
  const workspaceUnavailable = cwd === null;
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const directoryPaths = [
    "",
    ...[...expandedPaths].filter((directory) => {
      const parts = directory.split("/");
      return parts
        .slice(0, -1)
        .every((_, index) => expandedPaths.has(parts.slice(0, index + 1).join("/")));
    }),
  ];
  const entriesQuery = useQueries({
    queries: directoryPaths.map((relativePath) =>
      projectListDirectoryQueryOptions({
        cwd,
        relativePath,
        includeIgnored,
        limit: directoryLimit,
      }),
    ),
    combine: combineDirectoryQueries,
  });
  const directoryQueries = entriesQuery.queries;
  // Loaded directories refresh when entries are added, removed or renamed.
  useWatchedWorkspacePaths(cwd, [], directoryPaths);
  const trimmedSearchQuery = searchQuery.trim();
  const searchMode = !workspaceUnavailable && trimmedSearchQuery.length > 0;
  const [debouncedSearchQuery, searchDebouncer] = useDebouncedValue(
    trimmedSearchQuery,
    { wait: SEARCH_INPUT_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const activeSearchQuery = searchMode ? debouncedSearchQuery : "";
  const searchEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd,
      query: activeSearchQuery,
      enabled: searchMode && activeSearchQuery.length > 0,
      limit: SEARCH_ENTRIES_LIMIT,
    }),
  );
  const entries = entriesQuery.data.entries;
  const tree = useMemo(() => buildFileTree(entries), [entries]);
  const visibleRows = useMemo(
    () => flattenVisibleTreeRows({ nodes: tree, expandedPaths, normalizedQuery: "" }),
    [expandedPaths, tree],
  );
  const searchResultsMatchInput = searchMode && activeSearchQuery === trimmedSearchQuery;
  const searchEntries = searchResultsMatchInput ? (searchEntriesQuery.data?.entries ?? []) : [];
  const searchErrorVisible = searchResultsMatchInput && searchEntriesQuery.isError;
  const searchLoading =
    searchMode && (searchDebouncer.state.isPending || searchEntriesQuery.isFetching);
  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  const revealPath = useRightPanelStore((state) => {
    const surface = state.byThreadId[threadId]?.surfaces.find((entry) => entry.kind === "files");
    return surface?.kind === "files" ? surface.revealPath : undefined;
  });
  useEffect(() => {
    if (!revealPath) return;
    setSearchQuery("");
    const parts = revealPath.split("/").filter(Boolean);
    setExpandedPaths(
      (previous) =>
        new Set([...previous, ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))]),
    );
    pendingRevealPathRef.current = revealPath;
  }, [revealPath]);

  const initializedTreeCwdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!entries.length || initializedTreeCwdRef.current === cwd) return;
    initializedTreeCwdRef.current = cwd;
    setExpandedPaths(
      (previous) =>
        new Set([
          ...(revealPath ? previous : []),
          ...entries
            .filter((entry) => entry.kind === "directory" && !entry.path.includes("/"))
            .map((entry) => entry.path),
        ]),
    );
  }, [cwd, entries, revealPath]);

  useEffect(() => {
    if (!searchMode) {
      setHighlightedSearchIndex(-1);
    }
  }, [searchMode]);

  useEffect(() => {
    setHighlightedSearchIndex((current) => (current >= searchEntries.length ? -1 : current));
  }, [searchEntries.length]);

  useEffect(() => {
    if (searchMode || !pendingRevealPathRef.current) {
      return;
    }

    // The target row may not exist yet (its folder is still loading); retry
    // when the rows change. Rows are virtualized, so scroll by index.
    const targetPath = pendingRevealPathRef.current;
    const targetIndex = visibleRows.findIndex((row) => row.node.entry.path === targetPath);
    if (targetIndex === -1) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      pendingRevealPathRef.current = null;
      void treeListRef.current?.scrollIndexIntoView({ index: targetIndex, animated: false });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [searchMode, visibleRows]);

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

  const revealDirectory = useCallback((entry: ProjectEntry) => {
    const pathsToExpand = ancestorDirectoryPathsOf(entry);
    setExpandedPaths((current) => {
      const next = new Set(current);
      for (const path of pathsToExpand) {
        next.add(path);
      }
      return next;
    });
    pendingRevealPathRef.current = entry.path;
    setSearchQuery("");
    setHighlightedSearchIndex(-1);
  }, []);

  const handleSearchEntryAction = useCallback(
    (entry: ProjectEntry) => {
      if (entry.kind === "file") {
        onOpenFile(entry.path);
        return;
      }
      revealDirectory(entry);
    },
    [onOpenFile, revealDirectory],
  );

  const moveHighlightedSearchResult = useCallback(
    (direction: 1 | -1) => {
      if (searchEntries.length === 0) {
        setHighlightedSearchIndex(-1);
        return;
      }
      setHighlightedSearchIndex((current) => {
        if (current === -1) {
          return direction === 1 ? 0 : searchEntries.length - 1;
        }
        return (current + direction + searchEntries.length) % searchEntries.length;
      });
    },
    [searchEntries.length],
  );

  const handleSearchInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (!searchMode) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveHighlightedSearchResult(1);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveHighlightedSearchResult(-1);
        return;
      }

      if (event.key === "Enter") {
        const targetEntry = resolveSearchEntryForEnter(searchEntries, highlightedSearchIndex);
        if (targetEntry) {
          event.preventDefault();
          handleSearchEntryAction(targetEntry);
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setSearchQuery("");
        setHighlightedSearchIndex(-1);
      }
    },
    [
      handleSearchEntryAction,
      highlightedSearchIndex,
      moveHighlightedSearchResult,
      searchEntries,
      searchMode,
    ],
  );

  const refreshEntries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...providerQueryKeys.fileContentAll, cwd] });
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.listDirectories(cwd) });
    if (activeSearchQuery.length > 0) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.searchEntries(cwd, activeSearchQuery, SEARCH_ENTRIES_LIMIT),
      });
    }
  }, [activeSearchQuery, cwd, queryClient]);

  const handleEntryDragStart = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>, entry: ProjectEntry) => {
      if (
        entry.kind !== "file" ||
        projectId === null ||
        workspaceIdentity === null ||
        !writeFileTreeDragMention(event.dataTransfer, {
          projectId,
          workspaceIdentity,
          relativePath: entry.path,
        })
      ) {
        event.preventDefault();
      }
    },
    [projectId, workspaceIdentity],
  );

  const handleEntryContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, entry: ProjectEntry) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readNativeApi();
      if (!api || !cwd || !projectId) return;
      void showFileEntryContextMenu({
        api,
        cwd,
        projectId,
        threadId,
        entry,
        position: { x: event.clientX, y: event.clientY },
        onAddToChat: (relativePath) => insertFileMentionIntoComposer(threadId, relativePath),
      });
    },
    [cwd, projectId, threadId],
  );

  // Rows read these through `renderItem`'s closure; LegendList re-renders
  // cached rows only when `data` or `extraData` changes.
  const treeRowExtraData = useMemo(
    () => [expandedPaths, projectId, workspaceIdentity, onOpenFile, handleEntryContextMenu],
    [expandedPaths, handleEntryContextMenu, onOpenFile, projectId, workspaceIdentity],
  );
  const renderTreeRow = useCallback(
    ({ item: { node, depth } }: { item: VisibleTreeRow }) => {
      const isDirectory = node.entry.kind === "directory";
      const expanded = expandedPaths.has(node.entry.path);
      return (
        <button
          type="button"
          data-file-browser-path={node.entry.path}
          aria-expanded={isDirectory ? expanded : undefined}
          className="flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={!isDirectory && projectId !== null && workspaceIdentity !== null}
          onDragStart={(event) => handleEntryDragStart(event, node.entry)}
          onContextMenu={(event) => handleEntryContextMenu(event, node.entry)}
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
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
      );
    },
    [
      expandedPaths,
      handleEntryContextMenu,
      handleEntryDragStart,
      onOpenFile,
      projectId,
      toggleDirectory,
      workspaceIdentity,
    ],
  );
  const directoryErrors = directoryQueries.flatMap((query, index) =>
    query.isError
      ? [
          <div
            key={directoryPaths[index]}
            role="alert"
            className="px-3 py-2 text-xs text-destructive"
          >
            {query.error instanceof Error && /permission|EACCES|EPERM/i.test(query.error.message)
              ? "Permission denied reading "
              : "Could not read "}
            {directoryPaths[index] || "workspace root"}.{" "}
            {query.data ? "Showing the last successful listing. " : ""}Other folders remain
            available.
            {index > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => toggleDirectory(directoryPaths[index]!)}
              >
                Collapse folder
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => void query.refetch()}>
              Retry folder
            </Button>
          </div>,
        ]
      : [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{projectName}</p>
          <p className="truncate text-2xs leading-none text-muted-foreground">
            {workspaceUnavailable
              ? "Unavailable"
              : entriesQuery.isFetching && entries.length === 0
                ? "Loading..."
                : `${fileCount.toLocaleString()} files loaded`}
            {entriesQuery.data && entriesQuery.data.totalEntries > entries.length
              ? ` · showing ${entries.length.toLocaleString()} of ${entriesQuery.data.totalEntries.toLocaleString()}`
              : ""}
            {entriesQuery.data?.truncated ? " · truncated" : ""}
            {entriesQuery.isFetching && entries.length > 0 ? " · updating" : ""}
            {directoryQueries.some((query) => query.isError && query.data) ? " · stale" : ""}
          </p>
        </div>
        <label className="flex items-center gap-1 text-2xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeIgnored}
            onChange={(event) => setIncludeIgnored(event.target.checked)}
          />
          Ignored
        </label>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={refreshEntries}
          aria-label="Refresh workspace files"
          disabled={workspaceUnavailable}
        >
          <RefreshCwIcon className={cn("size-3.5", entriesQuery.isFetching && "animate-spin")} />
        </Button>
      </div>

      <div className="border-b border-border/50 p-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            size="sm"
            type="search"
            nativeInput
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            onKeyDown={handleSearchInputKeyDown}
            placeholder="Search files"
            disabled={workspaceUnavailable}
            className="rounded-md [&_[data-slot=input]]:pl-8"
          />
        </div>
      </div>

      {workspaceUnavailable ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground">
          Workspace files are unavailable for this thread.
        </div>
      ) : !searchMode && entriesQuery.isError && entries.length === 0 ? (
        <div className="p-3 text-xs leading-relaxed text-destructive">
          {entriesQuery.error instanceof Error
            ? entriesQuery.error.message
            : "Failed to load workspace files."}
          <Button size="xs" variant="ghost" onClick={() => void directoryQueries[0]?.refetch()}>
            Retry workspace
          </Button>
        </div>
      ) : searchMode ? (
        <ScrollArea className="min-h-0 flex-1" scrollFade>
          <div className="py-1">
            {searchErrorVisible ? (
              <div className="px-3 py-2 text-xs leading-relaxed text-destructive">
                {searchEntriesQuery.error instanceof Error
                  ? searchEntriesQuery.error.message
                  : "Failed to search workspace files."}
              </div>
            ) : null}
            {searchLoading ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>
            ) : null}
            {!searchErrorVisible && !searchLoading && searchEntries.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matching files.</div>
            ) : null}
            {searchEntries.map((entry, index) => {
              const isDirectory = entry.kind === "directory";
              const label = basenameOf(entry.path);
              const showPath = entry.path !== label;
              const highlighted = index === highlightedSearchIndex;
              return (
                <button
                  key={`${entry.kind}:${entry.path}`}
                  type="button"
                  className={cn(
                    "flex min-h-9 w-full min-w-0 items-center gap-2 px-2 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    highlighted && "bg-accent text-foreground",
                  )}
                  aria-selected={highlighted}
                  draggable={!isDirectory && projectId !== null && workspaceIdentity !== null}
                  onDragStart={(event) => handleEntryDragStart(event, entry)}
                  onContextMenu={(event) => handleEntryContextMenu(event, entry)}
                  onMouseEnter={() => setHighlightedSearchIndex(index)}
                  onClick={() => handleSearchEntryAction(entry)}
                >
                  {isDirectory ? (
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{label}</span>
                    {showPath ? (
                      <span className="block truncate text-2xs leading-3 text-muted-foreground">
                        {entry.path}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {searchResultsMatchInput && searchEntriesQuery.data?.truncated ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                More matches available. Refine your search.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      ) : visibleRows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground">
          No workspace files found.
        </div>
      ) : (
        <LegendList<VisibleTreeRow>
          ref={treeListRef}
          data={visibleRows}
          extraData={treeRowExtraData}
          keyExtractor={treeRowKey}
          renderItem={renderTreeRow}
          estimatedItemSize={TREE_ROW_HEIGHT_PX}
          getFixedItemSize={treeRowFixedSize}
          drawDistance={TREE_ROW_HEIGHT_PX * 20}
          recycleItems
          ListHeaderComponent={directoryErrors.length > 0 ? <>{directoryErrors}</> : null}
          ListFooterComponent={
            entriesQuery.data.truncated && directoryLimit < 100_000 ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={entriesQuery.isFetching}
                onClick={() => setDirectoryLimit((limit) => Math.min(100_000, limit * 2))}
              >
                Load more directory entries
              </Button>
            ) : null
          }
          className="min-h-0 flex-1 overflow-x-hidden py-1"
        />
      )}
    </div>
  );
}
