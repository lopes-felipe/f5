import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  PilcrowIcon,
  Rows3Icon,
  WrapTextIcon,
} from "lucide-react";
import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { gitBranchesQueryOptions } from "~/lib/gitReactQuery";
import { threadFileChangeQueryOptions } from "~/lib/orchestrationReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { reviewPreviewDiffQueryOptions } from "~/lib/reviewReactQuery";
import { cn } from "~/lib/utils";
import { useAppSettings } from "../appSettings";
import { readNativeApi } from "../nativeApi";
import { resolvePathLinkTarget } from "../terminal-links";
import { clearTurnDiffSearchParams, parseDiffRouteSearch } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import {
  buildFileDiffLogicalIdentity,
  DIFF_PANEL_UNSAFE_CSS,
  getRenderablePatch,
  resolveFileDiffPath,
  summarizeFileDiffMetadataStats,
} from "../lib/diffPatch";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Button } from "./ui/button";
import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";
import {
  isChangedFileExpandedByDefault,
  resolveChangedFilesPresentation,
} from "./chat/changedFilesPresentation";
import { changedLineCount } from "../lib/turnDiffTree";

type DiffThemeType = "light" | "dark";

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
export {
  buildFileDiffRenderKey,
  DIFF_PANEL_UNSAFE_CSS,
  getRenderablePatch,
  resolveFileDiffPath,
} from "../lib/diffPatch";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const { settings, updateSettings } = useAppSettings();
  const diffRenderMode = settings.diffRenderMode;
  const [collapsedFileOverrides, setCollapsedFileOverrides] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const activeThreadId = routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const gitAutoRefreshIntervalMs = settings.gitStatusAutoRefreshIntervalSeconds * 1000;
  const gitAutoRefreshEnabled = settings.gitStatusAutoRefreshIntervalSeconds > 0;
  const gitBranchesQuery = useQuery(
    gitBranchesQueryOptions({
      cwd: activeCwd ?? null,
      autoRefresh: gitAutoRefreshEnabled,
      refetchIntervalMs: gitAutoRefreshIntervalMs,
    }),
  );
  const isGitRepo = gitBranchesQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedTurnId = diffSearch.diffTurnId ?? null;
  const selectedFileChangeId = diffSearch.diffFileChangeId ?? null;
  const selectedFilePath = diffSearch.diffFilePath ?? null;
  const isExactFileChangeMode = selectedFileChangeId !== null;
  const selectedReviewScope = diffSearch.diffScope ?? null;
  const isReviewScope = selectedReviewScope !== null && !isExactFileChangeMode;
  const selectedTurn =
    isExactFileChangeMode || selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !selectedTurn && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries, selectedTurn]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      ignoreWhitespace: settings.diffIgnoreWhitespace,
      enabled: !isExactFileChangeMode && !isReviewScope && isGitRepo,
    }),
  );
  const reviewDiffQuery = useQuery(
    reviewPreviewDiffQueryOptions({
      threadId: activeThreadId,
      scope: selectedReviewScope,
      baseRef: diffSearch.diffBaseRef ?? null,
      ignoreWhitespace: settings.diffIgnoreWhitespace,
      autoRefresh: gitAutoRefreshEnabled,
      refetchIntervalMs: gitAutoRefreshIntervalMs,
    }),
  );
  const exactFileChangeQuery = useQuery(
    threadFileChangeQueryOptions({
      threadId: activeThreadId,
      fileChangeId: selectedFileChangeId,
      enabled: isExactFileChangeMode,
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff = activeCheckpointDiffQuery.isLoading;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;
  const exactFileChangeError =
    exactFileChangeQuery.error instanceof Error
      ? exactFileChangeQuery.error.message
      : exactFileChangeQuery.error
        ? "Failed to load file-change diff."
        : null;

  const reviewDiffResult = isReviewScope ? reviewDiffQuery.data : undefined;
  const selectedPatch = isExactFileChangeMode
    ? exactFileChangeQuery.data?.fileChange?.patch
    : reviewDiffResult?.kind === "success"
      ? reviewDiffResult.patch
      : isReviewScope
        ? undefined
        : selectedTurn
          ? selectedTurnCheckpointDiff
          : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(
        selectedPatch,
        isExactFileChangeMode && selectedFileChangeId
          ? `file-change:${selectedFileChangeId}`
          : "diff-panel",
      ),
    [isExactFileChangeMode, selectedFileChangeId, selectedPatch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const diffLogicalScope = useMemo(() => {
    if (isExactFileChangeMode) {
      return `file-change:${selectedFileChangeId ?? ""}`;
    }
    if (isReviewScope) {
      return `review:${selectedReviewScope ?? ""}:${diffSearch.diffBaseRef ?? ""}`;
    }
    return selectedTurn
      ? `turn:${selectedTurn.turnId}`
      : `conversation:${activeCheckpointRange?.fromTurnCount ?? ""}:${
          activeCheckpointRange?.toTurnCount ?? ""
        }`;
  }, [
    activeCheckpointRange?.fromTurnCount,
    activeCheckpointRange?.toTurnCount,
    diffSearch.diffBaseRef,
    isExactFileChangeMode,
    isReviewScope,
    selectedFileChangeId,
    selectedReviewScope,
    selectedTurn,
  ]);
  const aggregateDiffStat = useMemo(
    () => summarizeFileDiffMetadataStats(renderableFiles),
    [renderableFiles],
  );
  const defaultPresentation = resolveChangedFilesPresentation({
    fileCount: renderableFiles.length,
    changedLineCount: changedLineCount(aggregateDiffStat),
    isNewest: !selectedTurn || selectedTurn.turnId === orderedTurnDiffSummaries[0]?.turnId,
  });
  const logicalFileKey = useCallback(
    (fileIdentity: string) => `${activeThreadId ?? "unknown"}:${diffLogicalScope}:${fileIdentity}`,
    [activeThreadId, diffLogicalScope],
  );

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );

  const toggleCollapsedFileKey = useCallback((fileKey: string, isCollapsed: boolean) => {
    setCollapsedFileOverrides((previous) => ({ ...previous, [fileKey]: !isCollapsed }));
  }, []);
  const setAllFilesCollapsed = useCallback(
    (collapsed: boolean) => {
      setCollapsedFileOverrides((previous) => ({
        ...previous,
        ...Object.fromEntries(
          renderableFiles.map((file) => [
            logicalFileKey(buildFileDiffLogicalIdentity(file)),
            collapsed,
          ]),
        ),
      }));
    },
    [logicalFileKey, renderableFiles],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = clearTurnDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = clearTurnDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  };
  const selectDiffScope = (scope: "checkpoint" | "working-tree" | "branch-range") => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = clearTurnDiffSearchParams(previous);
        return {
          ...rest,
          diff: "1",
          ...(scope === "checkpoint" ? {} : { diffScope: scope }),
        };
      },
    });
  };
  const selectBaseRef = (baseRef: string | null) => {
    if (!activeThread || selectedReviewScope !== "branch-range") return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => ({
        ...previous,
        diff: "1",
        diffScope: "branch-range",
        diffBaseRef: baseRef === null || baseRef === "__auto__" ? undefined : baseRef,
      }),
    });
  };
  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);
  const scrollTurnStripBy = useCallback((offset: number) => {
    const element = turnStripRef.current;
    if (!element) return;
    element.scrollBy({ left: offset, behavior: "smooth" });
  }, []);
  const onTurnStripWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = turnStripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    element.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedTurnDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedTurn?.turnId, selectedTurnId]);
  const patchLoadError = isExactFileChangeMode
    ? exactFileChangeError
    : isReviewScope
      ? reviewDiffResult?.kind === "error"
        ? reviewDiffResult.message
        : reviewDiffQuery.error instanceof Error
          ? reviewDiffQuery.error.message
          : null
      : checkpointDiffError;
  const isLoadingPatch = isExactFileChangeMode
    ? exactFileChangeQuery.isLoading
    : isReviewScope
      ? reviewDiffQuery.isLoading
      : isLoadingCheckpointDiff;

  const scopeControls = !isExactFileChangeMode ? (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <ToggleGroup
        variant="outline"
        size="xs"
        value={[selectedReviewScope ?? "checkpoint"]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "checkpoint" || next === "working-tree" || next === "branch-range") {
            selectDiffScope(next);
          }
        }}
      >
        <Toggle value="checkpoint" aria-label="Checkpoint diff scope">
          Turns
        </Toggle>
        <Toggle value="working-tree" aria-label="Working tree diff scope">
          Working
        </Toggle>
        <Toggle value="branch-range" aria-label="Branch range diff scope">
          Branch
        </Toggle>
      </ToggleGroup>
      {selectedReviewScope === "branch-range" ? (
        <Select value={diffSearch.diffBaseRef ?? "__auto__"} onValueChange={selectBaseRef}>
          <SelectTrigger size="xs" className="max-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="end">
            <SelectItem value="__auto__">Auto base</SelectItem>
            {(gitBranchesQuery.data?.branches ?? []).map((branch) => (
              <SelectItem key={branch.name} value={branch.name}>
                {branch.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  ) : null;

  const diffPresentationControls = (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      {renderableFiles.length > 0 ? (
        <span className="whitespace-nowrap px-1 text-[10px] text-muted-foreground/70">
          {renderableFiles.length} {renderableFiles.length === 1 ? "file" : "files"}
          {hasNonZeroStat(aggregateDiffStat) ? (
            <>
              <span className="mx-1">·</span>
              <DiffStatLabel
                additions={aggregateDiffStat.additions}
                deletions={aggregateDiffStat.deletions}
              />
            </>
          ) : null}
        </span>
      ) : null}
      {renderableFiles.length > 0 ? (
        <>
          <Button size="xs" variant="outline" onClick={() => setAllFilesCollapsed(false)}>
            Expand all
          </Button>
          <Button size="xs" variant="outline" onClick={() => setAllFilesCollapsed(true)}>
            Collapse all
          </Button>
        </>
      ) : null}
      {!isExactFileChangeMode ? (
        <Toggle
          aria-label="Ignore whitespace"
          variant="outline"
          size="xs"
          pressed={settings.diffIgnoreWhitespace}
          onPressedChange={(pressed) => updateSettings({ diffIgnoreWhitespace: Boolean(pressed) })}
        >
          <PilcrowIcon className="size-3" />
        </Toggle>
      ) : null}
      <Toggle
        aria-label="Wrap long lines"
        variant="outline"
        size="xs"
        pressed={settings.diffWordWrap}
        onPressedChange={(pressed) => updateSettings({ diffWordWrap: Boolean(pressed) })}
      >
        <WrapTextIcon className="size-3" />
      </Toggle>
      <ToggleGroup
        variant="outline"
        size="xs"
        value={[diffRenderMode]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "stacked" || next === "split") {
            updateSettings({ diffRenderMode: next });
          }
        }}
      >
        <Toggle aria-label="Stacked diff view" value="stacked">
          <Rows3Icon className="size-3" />
        </Toggle>
        <Toggle aria-label="Split diff view" value="split">
          <Columns2Icon className="size-3" />
        </Toggle>
      </ToggleGroup>
    </div>
  );

  const headerRow = isExactFileChangeMode ? (
    <>
      <div className="min-w-0 flex-1 px-1 text-[11px] text-muted-foreground/80 [-webkit-app-region:no-drag]">
        <span className="truncate">
          {exactFileChangeQuery.data?.fileChange?.title ?? "File change diff"}
        </span>
      </div>
      {diffPresentationControls}
    </>
  ) : isReviewScope ? (
    <>
      <div className="min-w-0 flex-1 px-1 text-[11px] text-muted-foreground/80 [-webkit-app-region:no-drag]">
        {selectedReviewScope === "working-tree" ? "Working tree changes" : "Branch changes"}
      </div>
      {scopeControls}
      {diffPresentationControls}
    </>
  ) : (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        {canScrollTurnStripLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-linear-to-r from-card to-transparent" />
        )}
        {canScrollTurnStripRight && (
          <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-linear-to-l from-card to-transparent" />
        )}
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripLeft
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!canScrollTurnStripLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripRight
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!canScrollTurnStripRight}
          aria-label="Scroll turn list right"
        >
          <ChevronRightIcon className="size-3.5" />
        </button>
        <div
          ref={turnStripRef}
          className="turn-chip-strip flex gap-1 overflow-x-auto px-8 py-0.5"
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={selectWholeConversation}
            data-turn-chip-selected={selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">All turns</div>
            </div>
          </button>
          {orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => selectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurn?.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurn?.turnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[10px] leading-tight font-medium">
                    Turn{" "}
                    {summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                      "?"}
                  </span>
                  <span className="text-[9px] leading-tight opacity-70">
                    {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      {scopeControls}
      {diffPresentationControls}
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          {isExactFileChangeMode
            ? "Select a thread to inspect file-change diffs."
            : "Select a thread to inspect turn diffs."}
        </div>
      ) : !isExactFileChangeMode && !isReviewScope && !activeThread.detailsLoaded ? (
        <DiffPanelLoadingState label="Loading thread diff context..." />
      ) : !isExactFileChangeMode && !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : !isExactFileChangeMode && !isReviewScope && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {patchLoadError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{patchLoadError}</p>
              </div>
            )}
            {reviewDiffResult?.kind === "success" && reviewDiffResult.truncated ? (
              <div className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                {reviewDiffResult.truncationReason ?? "Diff preview was truncated."}
              </div>
            ) : null}
            {!renderablePatch ? (
              isLoadingPatch ? (
                <DiffPanelLoadingState
                  label={
                    isExactFileChangeMode
                      ? "Loading file-change diff..."
                      : "Loading checkpoint diff..."
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {isExactFileChangeMode && exactFileChangeQuery.data?.fileChange === null
                      ? "No file-change transcript found."
                      : hasNoNetChanges
                        ? "No net changes in this selection."
                        : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {renderableFiles.map((fileDiff, fileIndex) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = logicalFileKey(buildFileDiffLogicalIdentity(fileDiff));
                  const isCollapsed =
                    collapsedFileOverrides[fileKey] ??
                    !isChangedFileExpandedByDefault({
                      presentation: defaultPresentation,
                      fileIndex,
                    });
                  return (
                    <div
                      key={fileKey}
                      data-diff-file-path={filePath}
                      className="diff-render-file relative mb-2 rounded-md first:mt-2 last:mb-0"
                      onClickCapture={(event) => {
                        const nativeEvent = event.nativeEvent as MouseEvent;
                        const composedPath = nativeEvent.composedPath?.() ?? [];
                        const clickedHeader = composedPath.some((node) => {
                          if (!(node instanceof Element)) return false;
                          return node.hasAttribute("data-title");
                        });
                        if (clickedHeader) {
                          openDiffFileInEditor(filePath);
                          return;
                        }
                        const clickedFileHeader = composedPath.some((node) => {
                          if (!(node instanceof Element)) return false;
                          return node.hasAttribute("data-diffs-header");
                        });
                        if (!clickedFileHeader) return;
                        toggleCollapsedFileKey(fileKey, isCollapsed);
                      }}
                    >
                      <button
                        type="button"
                        className="absolute top-2 left-2 z-10 inline-flex size-5 items-center justify-center rounded-sm border border-border/60 bg-background/90 text-muted-foreground shadow-xs transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-expanded={!isCollapsed}
                        aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${filePath}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleCollapsedFileKey(fileKey, isCollapsed);
                        }}
                      >
                        {isCollapsed ? (
                          <ChevronRightIcon className="size-3" />
                        ) : (
                          <ChevronDownIcon className="size-3" />
                        )}
                      </button>
                      <FileDiff
                        fileDiff={fileDiff}
                        options={{
                          diffStyle: diffRenderMode === "split" ? "split" : "unified",
                          lineDiffType: "none",
                          collapsed: isCollapsed,
                          overflow: settings.diffWordWrap ? "wrap" : "scroll",
                          theme: resolveDiffThemeName(resolvedTheme),
                          themeType: resolvedTheme as DiffThemeType,
                          unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                        }}
                      />
                    </div>
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre className="max-h-[72vh] overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
