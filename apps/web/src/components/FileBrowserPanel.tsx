import { useRightPanelStore } from "../rightPanelStore";
import type { ProjectEntry, ProjectId, ThreadId } from "@t3tools/contracts";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
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

interface TreeNode {
  entry: ProjectEntry;
  children: TreeNode[];
}

interface VisibleTreeRow {
  node: TreeNode;
  depth: number;
}

const MAX_RENDERED_TREE_ROWS = 1_500;
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
  const [visibleLimit, setVisibleLimit] = useState(MAX_RENDERED_TREE_ROWS);
  const [directoryLimit, setDirectoryLimit] = useState(entryLimit);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const treeRowsRef = useRef<HTMLDivElement>(null);
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
  const directoryQueries = useQueries({
    queries: directoryPaths.map((relativePath) =>
      projectListDirectoryQueryOptions({
        cwd,
        relativePath,
        includeIgnored,
        limit: directoryLimit,
      }),
    ),
  });
  const entriesQuery = {
    data: {
      entries: directoryQueries.flatMap((query) => query.data?.entries ?? []),
      totalEntries: directoryQueries.reduce(
        (sum, query) => sum + (query.data?.totalEntries ?? 0),
        0,
      ),
      truncated: directoryQueries.some((query) => query.data?.truncated),
    },
    isFetching: directoryQueries.some((query) => query.isFetching),
    isError: directoryQueries.some((query) => query.isError),
    error: directoryQueries.find((query) => query.isError)?.error,
  };
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
  const entries = entriesQuery.data?.entries ?? [];
  const tree = useMemo(() => buildTree(entries), [entries]);
  const visibleRows = useMemo(
    () => flattenVisibleRows({ nodes: tree, expandedPaths, normalizedQuery: "" }),
    [expandedPaths, tree],
  );
  const renderedRows = visibleRows.slice(0, visibleLimit);
  const hiddenVisibleRowCount = visibleRows.length - renderedRows.length;
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

    const frame = window.requestAnimationFrame(() => {
      const targetPath = pendingRevealPathRef.current;
      if (!targetPath) {
        return;
      }
      const target = Array.from(
        treeRowsRef.current?.querySelectorAll<HTMLElement>("[data-file-browser-path]") ?? [],
      ).find((element) => element.dataset.fileBrowserPath === targetPath);
      if (target) {
        target.scrollIntoView({ block: "nearest" });
        pendingRevealPathRef.current = null;
      }
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [renderedRows, searchMode]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{projectName}</p>
          <p className="truncate text-[10px] leading-none text-muted-foreground/80">
            {workspaceUnavailable
              ? "Unavailable"
              : entriesQuery.isFetching && entries.length === 0
                ? "Loading..."
                : `${fileCount.toLocaleString()} files loaded`}
            {entriesQuery.data && entriesQuery.data.totalEntries > entries.length
              ? ` · showing ${entries.length.toLocaleString()} of ${entriesQuery.data.totalEntries.toLocaleString()}`
              : ""}
            {entriesQuery.data?.truncated ? " · partial" : ""}
          </p>
        </div>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
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
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
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
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Workspace files are unavailable for this thread.
        </div>
      ) : !searchMode && entriesQuery.isError ? (
        <div className="p-3 text-xs leading-relaxed text-destructive">
          {entriesQuery.error instanceof Error
            ? entriesQuery.error.message
            : "Failed to load workspace files."}
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
              <div className="px-3 py-2 text-xs text-muted-foreground/70">Searching...</div>
            ) : null}
            {!searchErrorVisible && !searchLoading && searchEntries.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground/70">No matching files.</div>
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
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
                  ) : (
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{label}</span>
                    {showPath ? (
                      <span className="block truncate text-[10px] leading-3 text-muted-foreground/75">
                        {entry.path}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {searchResultsMatchInput && searchEntriesQuery.data?.truncated ? (
              <div className="px-3 py-2 text-xs text-muted-foreground/70">
                More matches available. Refine your search.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      ) : visibleRows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No workspace files found.
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1" scrollFade>
          <div className="py-1" ref={treeRowsRef}>
            {renderedRows.map(({ node, depth }) => {
              const isDirectory = node.entry.kind === "directory";
              const expanded = expandedPaths.has(node.entry.path);
              const label = basenameOf(node.entry.path);
              return (
                <button
                  key={node.entry.path}
                  type="button"
                  data-file-browser-path={node.entry.path}
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
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
                  ) : (
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
                  )}
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
            {entriesQuery.data.truncated && directoryLimit < 100_000 ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={entriesQuery.isFetching}
                onClick={() => setDirectoryLimit((limit) => Math.min(100_000, limit * 2))}
              >
                Load more directory entries
              </Button>
            ) : null}
            {hiddenVisibleRowCount > 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground/70">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setVisibleLimit((limit) => limit + MAX_RENDERED_TREE_ROWS)}
                >
                  Show more entries ({hiddenVisibleRowCount.toLocaleString()} remaining)
                </Button>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
