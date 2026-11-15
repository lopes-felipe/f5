import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  GitPullRequestIcon,
  SearchXIcon,
  TriangleAlertIcon,
  UserPlusIcon,
} from "lucide-react";
import type {
  PrHubAdvisory,
  PrHubSection,
  PullRequestKey,
  ThreadId,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { PR_HUB_SECTIONS } from "@t3tools/shared/prHub";

import { readAppSettingsSnapshot, useAppSettings } from "../../appSettings";
import {
  getPrHubAccountGeneration,
  getPrHubSelectedAccountId,
  setPrHubSelectedAccountId,
} from "../../lib/prHubAccount";
import type { PrSavedViewSetting } from "../../lib/prSavedViews";
import { ensureNativeApi } from "../../nativeApi";
import { AppTitlebar } from "../AppTitlebar";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { isInteractiveTextTarget } from "./prHubKeyboard";
import {
  PrQueueActionHost,
  type PrQueueActionKind,
  type PrQueueActionRequest,
} from "./PrQueueActions";
import { PrQueueBulkBar } from "./PrQueueBulkBar";
import {
  PrAccountSwitcher,
  PrActivityPopover,
  PrQueueMenu,
  PrSyncPill,
  type PrQueueSettingsTarget,
} from "./PrQueueHeader";
import {
  PR_QUEUE_COLLAPSE_STORAGE_KEY,
  movePrQueueCursor,
  prQueueCollapsed,
  prQueueCommand,
  prSyncPillLabel,
} from "./prQueueModel";
import { PrPageContent } from "./PrPageContent";
import { PrQueuePeek } from "./PrQueuePeek";
import { PrQueueSavedViews } from "./PrQueueSavedViews";
import {
  parsePrQueueSearch,
  prActiveSavedView,
  prQueueFilters,
  prQueueIsFiltered,
  prSavedQueries,
  prSavedViewSearch,
  type PrQueueSearch,
  type PrQueueTab,
} from "./prQueueSearch";
import {
  prunePrSelection,
  selectPrRange,
  setPrSelection,
  togglePrSelection,
} from "./prQueueSelection";
import { PrQueueSkeletonRows, PrQueueTable, useRunningPrThread } from "./PrQueueTable";
import { PrQueueToolbar } from "./PrQueueToolbar";
import { usePrAdvisory, usePrQueue } from "./usePrQueue";

/** Below this width there is no room for the peek; a row opens the page instead. */
const PEEK_MIN_WIDTH = 1100;

const NO_SELECTION: ReadonlySet<PullRequestKey> = new Set();

type CollapseState = Partial<Record<PrHubSection, boolean>>;

function readCollapse(): CollapseState {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(PR_QUEUE_COLLAPSE_STORAGE_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object") return {};
    const stored = parsed as Record<string, unknown>;
    return Object.fromEntries(
      PR_HUB_SECTIONS.flatMap((section) =>
        typeof stored[section] === "boolean" ? [[section, stored[section]]] : [],
      ),
    );
  } catch {
    return {};
  }
}

function useWideEnough(minWidth: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWide(element.getBoundingClientRect().width >= minWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [minWidth]);
  return [ref, wide] as const;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function QueueEmpty({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}

const STATUS_EMPTY = {
  snoozed: ["Nothing snoozed", "Snoozed pull requests come back when their snooze ends."],
  ignored: [
    "Nothing ignored",
    "Ignored pull requests stay out of the queue until you restore them.",
  ],
  closed: [
    "Nothing closed recently",
    "Merged and closed pull requests are listed here for a while.",
  ],
} as const;

/** The pull request full-width, with its place in the queue and the way back. */
function PrQueuePage({
  pr,
  isLoading,
  position,
  total,
  tab,
  advisory,
  runningThreadId,
  editReviewers,
  isAnalyzing,
  onAnalyze,
  onTabChange,
  onBack,
  onStep,
  onOpenThread,
}: {
  pr: TrackedPullRequest | null;
  isLoading: boolean;
  position: number;
  total: number;
  tab: PrQueueTab;
  advisory: PrHubAdvisory | undefined;
  runningThreadId: ThreadId | null;
  /** The page was opened to request reviewers: start with that editor open. */
  editReviewers: boolean;
  isAnalyzing: boolean;
  onAnalyze: () => void;
  onTabChange: (tab: PrQueueTab) => void;
  onBack: () => void;
  onStep: (delta: number) => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5">
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon /> Queue <Kbd>Esc</Kbd>
        </Button>
        {position >= 0 ? (
          <div className="ms-auto flex items-center gap-1">
            <span className="text-xs text-muted-foreground tabular-nums">
              {position + 1} of {total}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Previous pull request"
              title="Previous ( [ )"
              disabled={position === 0}
              onClick={() => onStep(-1)}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Next pull request"
              title="Next ( ] )"
              disabled={position >= total - 1}
              onClick={() => onStep(1)}
            >
              <ChevronDownIcon />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-hidden px-6 py-4">
        {pr ? (
          <PrPageContent
            key={pr.key}
            pr={pr}
            advisory={advisory}
            isAnalyzingAdvisory={isAnalyzing}
            onAnalyzeAdvisory={onAnalyze}
            onThreadCreated={onOpenThread}
            onOpenThread={onOpenThread}
            runningThreadId={runningThreadId}
            tab={tab}
            onTabChange={onTabChange}
            defaultEditingReviewers={editReviewers}
          />
        ) : isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading pull request…
          </p>
        ) : (
          <QueueEmpty
            icon={<SearchXIcon />}
            title="Pull request not found"
            description="It is not tracked for this account. Paste its link in the search box to open it."
          >
            <Button size="sm" variant="outline" onClick={onBack}>
              Back to the queue
            </Button>
          </QueueEmpty>
        )}
      </div>
    </div>
  );
}

/**
 * The PR Hub: one queue table grouped by what needs you, a peek for the selected row and
 * the pull request page. Everything that should survive Back, Forward and a shared link
 * lives in `search`; the caller owns the URL.
 */
export function PrQueueView({
  search,
  onSearchChange,
  onOpenThread: openThreadRoute,
  onOpenSettings,
}: {
  search: PrQueueSearch;
  onSearchChange: (next: PrQueueSearch, options?: { replace?: boolean }) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenSettings: (target: PrQueueSettingsTarget) => void;
}) {
  const { settings, updateSettings } = useAppSettings();
  const queryClient = useQueryClient();
  // List pages carry each row's linked threads, and a row offers "Open thread" instead of
  // starting another agent only once it has them. A thread created from here is a new
  // link that no PR Hub event announces, so the lists are re-read on the way out.
  const onOpenThread = useCallback(
    (threadId: ThreadId) => {
      void queryClient.invalidateQueries({ queryKey: ["prHub", "list"] });
      openThreadRoute(threadId);
    },
    [openThreadRoute, queryClient],
  );
  const now = useNow(60_000);
  const [rootRef, canPeek] = useWideEnough(PEEK_MIN_WIDTH);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [collapse, setCollapse] = useState<CollapseState>(readCollapse);
  const [localCursor, setLocalCursor] = useState<PullRequestKey | null>(null);
  const [request, setRequest] = useState<PrQueueActionRequest | null>(null);
  const requestId = useRef(0);
  const clearRequest = useCallback(() => setRequest(null), []);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // "Request reviewers" in the peek opens the page with the reviewer editor showing.
  const [reviewerEditKey, setReviewerEditKey] = useState<PullRequestKey | null>(null);

  const savedViews = settings.prHubSavedViews;
  const savedQueries = useMemo(() => prSavedQueries(savedViews), [savedViews]);
  const queue = usePrQueue(search, collapse, savedQueries);
  const { overview, rows } = queue;
  const rowKeys = rows.map((pr) => pr.key);
  // Rows are ticked for bulk actions in the active queue only; a row that leaves the
  // screen leaves the selection.
  const selectable = (search.status ?? "active") === "active";
  const [selection, setSelection] = useState<ReadonlySet<PullRequestKey>>(NO_SELECTION);
  const selectionAnchor = useRef<PullRequestKey | null>(null);
  const selectedKeys = selectable ? prunePrSelection(selection, rowKeys) : NO_SELECTION;
  useEffect(() => {
    if (selectedKeys !== selection) setSelection(selectedKeys);
  }, [selectedKeys, selection]);
  const clearSelection = useCallback(() => setSelection(NO_SELECTION), []);
  const toggleSelected = (key: PullRequestKey, range: boolean) => {
    const anchor = selectionAnchor.current;
    selectionAnchor.current = key;
    setSelection((current) =>
      range ? selectPrRange(rowKeys, current, anchor, key) : togglePrSelection(current, key),
    );
  };
  const selectAll = (keys: readonly PullRequestKey[], on: boolean) =>
    setSelection((current) => setPrSelection(current, keys, on));
  const openKey = (search.pr as PullRequestKey | undefined) ?? null;
  const showPage = openKey !== null && (search.view === "page" || !canPeek);
  const peekOpen = openKey !== null && !showPage;
  // The open pull request may be spelled differently in a link; rows use the stored key.
  const cursorKey = openKey
    ? (queue.openPr?.key ?? openKey)
    : localCursor && rowKeys.includes(localCursor)
      ? localCursor
      : null;
  const activePr = openKey ? queue.openPr : (rows.find((pr) => pr.key === cursorKey) ?? null);
  // A confirmation or an operation in progress outlives its row. A refresh can move the pull
  // request to another section, or out of the loaded rows, while its dialog is open; the
  // dialogs then keep the copy they were opened with instead of closing.
  const [hostBusy, setHostBusy] = useState(false);
  const heldPr = useRef<TrackedPullRequest | null>(null);
  if (activePr) heldPr.current = activePr;
  const hostPr = activePr ?? (hostBusy ? heldPr.current : null);
  // A request is for the pull request on screen. One that found no host because that pull
  // request was still loading is dropped, not left to open a dialog when it arrives.
  useEffect(() => {
    if (request && request.key === cursorKey && !hostPr) setRequest(null);
  }, [request, cursorKey, hostPr]);
  const { advisory, isAnalyzing, analyze } = usePrAdvisory(
    openKey ? (queue.openPr?.key ?? null) : null,
  );
  const runningThreadId = useRunningPrThread(
    activePr ? queue.threadLinks.get(activePr.key) : undefined,
  );

  const patch = useCallback(
    (change: Partial<Record<keyof PrQueueSearch, string | undefined>>, replace = false) =>
      onSearchChange(parsePrQueueSearch({ ...search, ...change }), { replace }),
    [onSearchChange, search],
  );

  const select = (key: PullRequestKey) => {
    if (canPeek) patch({ pr: key, view: undefined, tab: undefined }, peekOpen);
    else patch({ pr: key, view: "page", tab: undefined });
  };
  const openPage = (key: PullRequestKey, tab?: PrQueueTab, editReviewers = false) => {
    setReviewerEditKey(editReviewers ? key : null);
    patch({ pr: key, view: "page", tab });
  };
  const closePeek = () => {
    setLocalCursor(cursorKey);
    patch({ pr: undefined, view: undefined, tab: undefined });
  };
  const leavePage = () => {
    if (canPeek) patch({ view: undefined, tab: undefined });
    else closePeek();
  };
  const moveCursor = (delta: number) => {
    const next = movePrQueueCursor(rowKeys, cursorKey, delta);
    if (!next || next === cursorKey) return;
    if (openKey) patch({ pr: next }, true);
    else setLocalCursor(next);
  };
  const requestAction = (pr: TrackedPullRequest, kind: PrQueueActionKind) => {
    if (pr.key !== cursorKey) {
      if (openKey) patch({ pr: pr.key }, true);
      else setLocalCursor(pr.key);
    }
    requestId.current += 1;
    setRequest({ id: requestId.current, key: pr.key, kind });
  };
  const toggleSection = (section: PrHubSection) => {
    const next = { ...collapse, [section]: !prQueueCollapsed(collapse, section) };
    setCollapse(next);
    try {
      window.localStorage.setItem(PR_QUEUE_COLLAPSE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private browsing: the choice lasts for this visit.
    }
  };
  const refresh = () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    void ensureNativeApi()
      .prHub.refresh({ mode: "force" })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not refresh pull requests",
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setIsRefreshing(false));
  };
  const showTracked = (pr: TrackedPullRequest) => {
    void queryClient.invalidateQueries({ queryKey: ["prHub", "overview"] });
    void queryClient.invalidateQueries({ queryKey: ["prHub", "list"] });
    patch({ pr: pr.key, view: "page", tab: undefined, q: undefined });
  };
  const openUrl = async (url: string) => {
    try {
      showTracked(
        await ensureNativeApi().prHub.track({
          url,
          accountGeneration: getPrHubAccountGeneration(),
        }),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open pull request",
        description: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || isInteractiveTextTarget()) return;
    const command = prQueueCommand(event, showPage ? "page" : "queue");
    if (!command) return;
    const target = event.target instanceof Element ? event.target : null;
    // Single keys act on the queue from the queue only. With focus in the sidebar, or in a
    // dialog, menu or popover (all rendered outside this view), they belong to that.
    if (target && target !== document.body && !rootRef.current?.contains(target)) return;
    // An open select or combobox list owns every key, Escape and type-ahead included.
    const list = target?.closest("[role=listbox]");
    if (list && list.getAttribute("aria-label") !== "Pull requests") return;
    // A focused control keeps the keys that operate it.
    const control = target?.closest(
      "button, a, summary, [role=tab], [role=menuitem], [role=checkbox]",
    );
    if (control && [" ", "Enter", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    switch (command) {
      case "next":
        moveCursor(1);
        break;
      case "previous":
        moveCursor(-1);
        break;
      case "pageNext":
      case "pagePrevious":
        // A pull request opened from a link may not be among the loaded rows. It has no
        // neighbours then, and the first row of the queue is not one.
        if (!cursorKey || !rowKeys.includes(cursorKey)) return;
        moveCursor(command === "pageNext" ? 1 : -1);
        break;
      case "peek":
        if (peekOpen) closePeek();
        else if (cursorKey) select(cursorKey);
        else return;
        break;
      case "open":
        if (!cursorKey) return;
        openPage(cursorKey);
        break;
      case "back":
        if (showPage) leavePage();
        else if (selectedKeys.size > 0) clearSelection();
        else if (peekOpen) closePeek();
        else return;
        break;
      case "select":
        if (!cursorKey || !selectable) return;
        toggleSelected(cursorKey, false);
        break;
      case "search":
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        break;
      case "refresh":
        refresh();
        break;
      default:
        if (!activePr) return;
        requestAction(activePr, command);
    }
    event.preventDefault();
  };
  const keyHandler = useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const status = search.status ?? "active";
  const filtered = prQueueIsFiltered(search);
  const counts = overview?.sectionCounts;
  const needsYou = (counts?.review ?? 0) + (counts?.action ?? 0) + (counts?.ready ?? 0);
  const disconnected = overview?.status === "auth_required" || overview?.status === "gh_missing";
  const synced = overview?.sync?.lastSyncedAt ? ` ${prSyncPillLabel(overview.sync, now)}.` : "";
  const clearFilters = () =>
    onSearchChange(parsePrQueueSearch({ pr: search.pr, status: search.status }));
  const activeView = prActiveSavedView(search, savedViews);
  const changeSavedViews = (
    update: (current: readonly PrSavedViewSetting[]) => readonly PrSavedViewSetting[],
    select?: PrSavedViewSetting,
  ) => {
    // An Undo can arrive after other changes, so the update starts from what is stored.
    updateSettings({ prHubSavedViews: update(readAppSettingsSnapshot().prHubSavedViews) });
    if (select) onSearchChange(prSavedViewSearch(search, select));
  };

  // Backlog is a healthy refresh, but while searches or detail reads are still queued the
  // queue is not known to be empty.
  const stillReading =
    overview?.sync?.state === "syncing" &&
    (!overview.sync.lastSyncedAt ||
      overview.sync.pending.searches + overview.sync.pending.hydrations > 0);

  let body: ReactNode;
  if (queue.groups.length > 0) {
    body = (
      <>
        {status === "active" && !filtered && needsYou === 0 && !stillReading ? (
          <p className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <CheckCircle2Icon aria-hidden="true" className="size-3.5 text-success-foreground" />
            All caught up. Nothing needs you right now.
          </p>
        ) : null}
        <PrQueueTable
          groups={queue.groups}
          threadLinks={queue.threadLinks}
          viewerLogin={overview?.viewerLogin ?? null}
          cursorKey={cursorKey}
          openKey={peekOpen ? cursorKey : null}
          selectedKeys={selectable ? selectedKeys : null}
          stalledHours={settings.prHubStalledAfterHours}
          now={now}
          isStale={queue.isStale}
          onSelect={select}
          onOpenPage={openPage}
          onToggleSelected={toggleSelected}
          onSelectAll={selectAll}
          onAction={requestAction}
          onOpenThread={onOpenThread}
          onToggleSection={toggleSection}
        />
      </>
    );
  } else if (queue.isLoading) {
    body = (
      <div role="status" aria-label="Loading pull requests">
        <PrQueueSkeletonRows count={8} />
      </div>
    );
  } else if (queue.isError) {
    body = (
      <QueueEmpty
        icon={<TriangleAlertIcon />}
        title="Could not load pull requests"
        description="The server did not answer. Your saved pull requests are not lost."
      >
        <Button size="sm" variant="outline" onClick={queue.refetch}>
          Retry
        </Button>
      </QueueEmpty>
    );
  } else if (disconnected) {
    body = (
      <QueueEmpty
        icon={<UserPlusIcon />}
        title={overview?.status === "gh_missing" ? "GitHub CLI is missing" : "Connect GitHub"}
        description={
          overview?.status === "gh_missing"
            ? "Install gh and restart F5 to load your pull requests."
            : "Connect a GitHub account for this profile to load your pull requests."
        }
      >
        {overview?.status === "auth_required" ? (
          <Button size="sm" onClick={() => onOpenSettings("github")}>
            Open account settings
          </Button>
        ) : null}
      </QueueEmpty>
    );
  } else if (filtered) {
    body = (
      <QueueEmpty
        icon={<SearchXIcon />}
        title="No pull requests match"
        description="Nothing in this list matches the search and filters."
      >
        <Button size="sm" variant="outline" onClick={clearFilters}>
          Clear search and filters
        </Button>
      </QueueEmpty>
    );
  } else if (status !== "active") {
    body = (
      <QueueEmpty
        icon={<GitPullRequestIcon />}
        title={STATUS_EMPTY[status][0]}
        description={STATUS_EMPTY[status][1]}
      />
    );
  } else if (stillReading) {
    // The sync has not finished: an empty queue would read as "nothing to do".
    const reading = overview?.sync?.lastSyncedAt
      ? "Still reading your pull requests"
      : "Reading your pull requests for the first time";
    body = (
      <div role="status" aria-label={reading}>
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">{reading}…</p>
        <PrQueueSkeletonRows count={8} />
      </div>
    );
  } else {
    body = (
      <QueueEmpty
        icon={<CheckCircle2Icon />}
        title="All caught up"
        description={`No open pull requests involve you.${synced}`}
      />
    );
  }

  const host = (children?: Parameters<typeof PrQueueActionHost>[0]["children"]) =>
    hostPr ? (
      <PrQueueActionHost
        key={hostPr.key}
        pr={hostPr}
        advisory={advisory}
        runningThreadId={runningThreadId}
        request={request}
        onRequestHandled={clearRequest}
        onBusyChange={setHostBusy}
        onReview={(key) => openPage(key, "files")}
        onOpenThread={onOpenThread}
      >
        {children}
      </PrQueueActionHost>
    ) : null;
  const position = cursorKey ? rowKeys.indexOf(cursorKey) : -1;
  const reference = queue.openPr
    ? `${queue.openPr.repository.nameWithOwner}#${queue.openPr.number}`
    : "Pull request";

  return (
    // Tooltip provider for base-ui tooltips in the detail; the app has no global one.
    <TooltipProvider delay={0}>
      <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <AppTitlebar
          className="border-b border-border"
          breadcrumb={[
            {
              label: "Pull requests",
              icon: <GitPullRequestIcon className="size-3.5 shrink-0 text-muted-foreground" />,
              ...(showPage ? { onSelect: leavePage } : {}),
            },
            ...(showPage ? [{ label: reference }] : []),
          ]}
          status={
            <PrSyncPill
              overview={overview}
              now={now}
              isRefreshing={isRefreshing}
              onRefresh={refresh}
            />
          }
          trailing={
            <>
              <PrActivityPopover
                overview={overview}
                now={now}
                onOpen={(key) => (showPage ? patch({ pr: key, tab: undefined }) : select(key))}
              />
              <PrAccountSwitcher
                selectedAccountId={getPrHubSelectedAccountId()}
                onSelect={(accountId) => {
                  setLocalCursor(null);
                  onSearchChange(parsePrQueueSearch({ ...search, pr: undefined }));
                  // The account changes now, before the setting is saved: the queries of the
                  // next render are keyed by it. Following the saved setting alone would
                  // leave one render, and the re-reads started in it, on the old account.
                  setPrHubSelectedAccountId(accountId);
                  updateSettings({ prHubAccountId: accountId ?? null });
                  void queryClient.invalidateQueries({ queryKey: ["prHub"] });
                }}
              />
              <PrQueueMenu onTracked={showTracked} onOpenSettings={onOpenSettings} />
            </>
          }
        />
        {showPage ? (
          <>
            <PrQueuePage
              pr={queue.openPr}
              isLoading={queue.isOpenPrLoading}
              position={position}
              total={rowKeys.length}
              tab={search.tab ?? "overview"}
              advisory={advisory}
              runningThreadId={runningThreadId}
              editReviewers={reviewerEditKey !== null && reviewerEditKey === queue.openPr?.key}
              isAnalyzing={isAnalyzing}
              onAnalyze={analyze}
              onTabChange={(tab) => patch({ tab }, true)}
              onBack={leavePage}
              onStep={moveCursor}
              onOpenThread={onOpenThread}
            />
            {host()}
          </>
        ) : (
          <>
            <PrQueueToolbar
              search={search}
              facets={overview?.facets}
              searchInputRef={searchInputRef}
              // Typing rewrites one history entry; a filter or status change adds one.
              onChange={(change) => patch(change, "q" in change)}
              onOpenUrl={openUrl}
            />
            {selectable ? (
              <PrQueueSavedViews
                views={savedViews}
                activeView={activeView}
                filters={prQueueFilters(search)}
                isFiltered={filtered}
                counts={overview?.savedCounts}
                onSelectQueue={clearFilters}
                onSelectView={(view) => onSearchChange(prSavedViewSearch(search, view))}
                onChange={changeSavedViews}
              />
            ) : null}
            <div className="flex min-h-0 flex-1">
              <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                {body}
                {selectedKeys.size > 0 ? (
                  <PrQueueBulkBar
                    selected={rows.filter((pr) => selectedKeys.has(pr.key))}
                    onClear={clearSelection}
                  />
                ) : null}
              </main>
              {host((actions) =>
                peekOpen && activePr ? (
                  <PrQueuePeek
                    pr={activePr}
                    links={queue.threadLinks.get(activePr.key)}
                    actions={actions}
                    now={now}
                    onClose={closePeek}
                    onOpenPage={(tab, editReviewers) => openPage(activePr.key, tab, editReviewers)}
                    onOpenThread={onOpenThread}
                  />
                ) : null,
              )}
              {peekOpen && !activePr ? (
                <aside
                  aria-label="Pull request"
                  className="flex w-100 shrink-0 flex-col gap-2 border-l border-border px-4 py-3 text-sm text-muted-foreground"
                >
                  {queue.isOpenPrLoading ? (
                    <p role="status">Loading pull request…</p>
                  ) : (
                    <>
                      <p>This pull request is not tracked for this account.</p>
                      <Button
                        size="xs"
                        variant="outline"
                        className="self-start"
                        onClick={closePeek}
                      >
                        Close
                      </Button>
                    </>
                  )}
                </aside>
              ) : null}
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
