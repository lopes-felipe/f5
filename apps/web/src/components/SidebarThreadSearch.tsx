import type { GlobalSearchResult, ThreadId } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  FileIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  RocketIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";

import { useOpenGlobalSearchResult } from "../hooks/useOpenGlobalSearchResult";
import { buildGlobalSearchQueryInput, parseGlobalSearchQuery } from "../lib/globalSearchQuery";
import { formatRelativeTimeLabel } from "../lib/relativeTime";
import { ensureNativeApi } from "../nativeApi";
import type { Project, Thread } from "../types";
import { HighlightedText } from "./HighlightedText";
import { buildSidebarThreadSearchItems } from "./Sidebar.search.logic";
import { Kbd } from "./ui/kbd";

const SIDEBAR_SEARCH_DEBOUNCE_MS = 180;
const SIDEBAR_LOCAL_RESULT_LIMIT = 24;
const SIDEBAR_GLOBAL_RESULT_LIMIT = 24;
const SIDEBAR_SEARCH_INPUT_ID = "sidebar-thread-search-input";
const SIDEBAR_SEARCH_RESULTS_ID = "sidebar-thread-search-results";

function focusSearchResult(edge: "first" | "last"): void {
  const results = document.getElementById(SIDEBAR_SEARCH_RESULTS_ID);
  const options = results?.querySelectorAll<HTMLElement>("[role='option']");
  const target = edge === "first" ? options?.item(0) : options?.item((options?.length ?? 0) - 1);
  target?.focus();
}

function handleSearchResultKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  onEscape: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onEscape();
    document.getElementById(SIDEBAR_SEARCH_INPUT_ID)?.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const results = document.getElementById(SIDEBAR_SEARCH_RESULTS_ID);
  const options = [...(results?.querySelectorAll<HTMLElement>("[role='option']") ?? [])];
  const currentIndex = options.indexOf(event.currentTarget);
  const nextIndex =
    event.key === "ArrowDown"
      ? Math.min(options.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
  options[nextIndex]?.focus();
}

export function SidebarThreadSearchInput(props: {
  query: string;
  onQueryChange: (query: string) => void;
  onOpenCommandPalette: () => void;
  commandPaletteShortcutLabel: string | null;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && props.query.trim().length > 0) {
      event.preventDefault();
      focusSearchResult("first");
      return;
    }
    if (event.key === "ArrowUp" && props.query.trim().length > 0) {
      event.preventDefault();
      focusSearchResult("last");
      return;
    }
    if (event.key === "Escape" && props.query.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      props.onQueryChange("");
    }
  };

  return (
    <div className="flex h-8 items-center gap-1 rounded-md px-2 text-muted-foreground/70 transition-colors focus-within:bg-accent focus-within:text-foreground hover:bg-accent hover:text-foreground">
      <SearchIcon className="size-3.5 shrink-0" />
      <input
        ref={inputRef}
        id={SIDEBAR_SEARCH_INPUT_ID}
        type="search"
        value={props.query}
        data-testid="sidebar-thread-search-input"
        role="combobox"
        aria-label="Search threads and conversations"
        aria-autocomplete="list"
        aria-controls={SIDEBAR_SEARCH_RESULTS_ID}
        aria-expanded={props.query.trim().length > 0}
        placeholder="Search"
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {props.query.length > 0 ? (
        <button
          type="button"
          aria-label="Clear sidebar search"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-background/70"
          onClick={() => {
            props.onQueryChange("");
            inputRef.current?.focus();
          }}
        >
          <XIcon className="size-3" />
        </button>
      ) : (
        <button
          type="button"
          aria-label="Open full search"
          data-testid="command-palette-trigger"
          className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={props.onOpenCommandPalette}
        >
          {props.commandPaletteShortcutLabel ? (
            <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">
              {props.commandPaletteShortcutLabel}
            </Kbd>
          ) : (
            <span className="px-1 text-[10px]">More</span>
          )}
        </button>
      )}
    </div>
  );
}

function resultIcon(result: GlobalSearchResult) {
  if (result.kind === "fileChange") return <FileIcon className="size-3.5" />;
  if (result.kind === "activity") return <ActivityIcon className="size-3.5" />;
  if (result.kind.startsWith("workflow.")) return <RocketIcon className="size-3.5" />;
  return <MessageSquareIcon className="size-3.5" />;
}

function SearchResultButton(props: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  timestamp?: string;
  testId?: string;
  onClick: () => void;
  onEscape: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected="false"
      tabIndex={-1}
      data-testid={props.testId}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={props.onClick}
      onKeyDown={(event) => handleSearchResultKeyDown(event, props.onEscape)}
    >
      <span className="mt-0.5 shrink-0">{props.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">{props.title}</span>
        {props.description ? (
          <span className="block truncate text-[10px] text-muted-foreground/70">
            {props.description}
          </span>
        ) : null}
      </span>
      {props.timestamp ? (
        <span className="shrink-0 pt-0.5 text-[10px] text-muted-foreground/45">
          {props.timestamp}
        </span>
      ) : null}
    </button>
  );
}

export function SidebarThreadSearchResults(props: {
  query: string;
  projects: ReadonlyArray<Project>;
  threads: ReadonlyArray<Thread>;
  activeThreadId?: ThreadId;
  onResultOpened: () => void;
}) {
  const navigate = useNavigate();
  const openGlobalSearchResult = useOpenGlobalSearchResult();
  const trimmedQuery = props.query.trim();
  const parsedImmediateQuery = useMemo(() => parseGlobalSearchQuery(trimmedQuery), [trimmedQuery]);
  const localItems = useMemo(
    () =>
      buildSidebarThreadSearchItems({
        query: trimmedQuery,
        projects: props.projects,
        threads: props.threads,
        ...(props.activeThreadId ? { activeThreadId: props.activeThreadId } : {}),
        icon: <MessageSquareIcon className="size-3.5" />,
        runThread: async (thread) => {
          await navigate({ to: "/$threadId", params: { threadId: thread.id } });
          props.onResultOpened();
        },
        limit: SIDEBAR_LOCAL_RESULT_LIMIT,
      }),
    [
      navigate,
      props.activeThreadId,
      props.onResultOpened,
      props.projects,
      props.threads,
      trimmedQuery,
    ],
  );
  const [debouncedQuery] = useDebouncedValue(trimmedQuery, {
    wait: SIDEBAR_SEARCH_DEBOUNCE_MS,
  });
  const parsedDebouncedQuery = useMemo(
    () => parseGlobalSearchQuery(debouncedQuery),
    [debouncedQuery],
  );
  const globalSearchInput = useMemo(
    () =>
      buildGlobalSearchQueryInput({
        parsed: parsedDebouncedQuery,
        projects: props.projects,
        limit: SIDEBAR_GLOBAL_RESULT_LIMIT,
      }),
    [parsedDebouncedQuery, props.projects],
  );
  const globalSearchQuery = useQuery({
    queryKey: ["globalSearch", globalSearchInput],
    enabled: globalSearchInput !== null,
    staleTime: 5_000,
    queryFn: async () => {
      if (!globalSearchInput) return { results: [] };
      return ensureNativeApi().globalSearch.query(globalSearchInput);
    },
  });
  const localThreadIds = useMemo(
    () => new Set(localItems.map((item) => item.value.slice("thread:".length))),
    [localItems],
  );
  const globalResults =
    debouncedQuery === trimmedQuery
      ? (globalSearchQuery.data?.results ?? []).filter(
          (result) =>
            result.kind !== "thread" ||
            result.threadId === null ||
            !localThreadIds.has(result.threadId),
        )
      : [];
  const isSearchingConversations =
    parsedImmediateQuery.text.length >= 2 &&
    (debouncedQuery !== trimmedQuery || globalSearchQuery.isFetching);
  const hasResults = localItems.length > 0 || globalResults.length > 0;

  return (
    <div
      id={SIDEBAR_SEARCH_RESULTS_ID}
      role="listbox"
      aria-label="Thread search results"
      className="px-2 py-2"
      data-testid="sidebar-thread-search-results"
    >
      <p className="sr-only" aria-live="polite">
        {isSearchingConversations
          ? "Searching conversation content."
          : `${localItems.length + globalResults.length} results.`}
      </p>
      {localItems.length > 0 ? (
        <section aria-label="Matching threads">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Threads
            </span>
            <span className="text-[10px] text-muted-foreground/45">{localItems.length}</span>
          </div>
          <div className="space-y-0.5">
            {localItems.map((item) => (
              <SearchResultButton
                key={item.value}
                icon={item.icon}
                title={item.title}
                {...(item.description ? { description: item.description } : {})}
                {...(item.timestamp ? { timestamp: item.timestamp } : {})}
                testId={`sidebar-thread-search-result-${item.value.slice("thread:".length)}`}
                onClick={() => void item.run()}
                onEscape={props.onResultOpened}
              />
            ))}
          </div>
        </section>
      ) : null}

      {globalResults.length > 0 || isSearchingConversations ? (
        <section aria-label="Matching conversation content" className="mt-3">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Conversations
            </span>
            {isSearchingConversations ? (
              <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground/50" />
            ) : (
              <span className="text-[10px] text-muted-foreground/45">{globalResults.length}</span>
            )}
          </div>
          <div className="space-y-0.5">
            {globalResults.map((result) => (
              <SearchResultButton
                key={result.documentKey}
                icon={resultIcon(result)}
                title={<HighlightedText text={result.title} query={parsedImmediateQuery.text} />}
                description={
                  <>
                    {result.projectTitle} ·{" "}
                    <HighlightedText text={result.snippet} query={parsedImmediateQuery.text} />
                  </>
                }
                timestamp={formatRelativeTimeLabel(result.createdAt)}
                testId={`sidebar-global-search-result-${result.documentKey}`}
                onClick={() => {
                  props.onResultOpened();
                  void openGlobalSearchResult(result);
                }}
                onEscape={props.onResultOpened}
              />
            ))}
          </div>
        </section>
      ) : null}

      {!hasResults && !isSearchingConversations ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground/60">
          {parsedImmediateQuery.text.length === 1
            ? "Type one more character to search conversation content."
            : "No matching threads or conversations."}
        </div>
      ) : null}
    </div>
  );
}
