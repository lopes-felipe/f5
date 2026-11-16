import type {
  ChangeRequest,
  GitCheckoutConflict,
  ProjectId,
  ThreadId,
  WorkspaceTransitionSnapshot,
} from "@t3tools/contracts";
import { resolveChangeRequestWebUrl } from "@t3tools/shared/sourceControl";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CodeIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  GitForkIcon,
  GitPullRequestIcon,
  PlusIcon,
  TerminalIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import { useAppSettingsSelector } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { openInPreferredEditor } from "../editorPreferences";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import {
  gitBranchesQueryOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
  refreshCheckedOutGitBranch,
  worktreesListQueryOptions,
} from "../lib/gitReactQuery";
import { switchConversationWorkspace } from "../lib/workspaceTransitions";
import { cn } from "../lib/utils";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { parsePullRequestReference } from "../pullRequestReference";
import { useWorktreeRemovalDialogStore } from "../worktreeRemovalDialogStore";
import { WsRequestError } from "../wsTransport";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  type EnvMode,
  shouldScrollHighlightedBranchIntoView,
  shouldVirtualizeBranchListForCount,
} from "./BranchToolbar.logic";
import { GitCheckoutConflictDialog } from "./GitCheckoutConflictDialog";
import { MiddleTruncate } from "./MiddleTruncate";
import {
  buildWorkspaceRows,
  isSelectableRow,
  linkedThreadsByPath,
  switchCheckoutPath,
  type SelectableWorkspaceRow,
  type WorkspaceRow,
  type WorkspaceState,
  workspaceTriggerLabel,
} from "./WorkspacePicker.logic";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { discardMovedChanges, MoveToWorktreeDialog } from "./worktrees/MoveToWorktreeDialog";

/** Fields a draft pick writes; `worktreeBranchName` names a new worktree's branch. */
export interface WorkspaceDraftPatch {
  readonly envMode: EnvMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly sharedFilesystemConfirmed: boolean;
  readonly worktreeBranchName?: string | null;
}

export interface WorkspacePickerProps {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly hasSetupScript: boolean;
  /** No server thread yet: picks change the draft, and worktrees are created on send. */
  readonly isDraft: boolean;
  readonly disabled?: boolean;
  readonly creatingWorktree: boolean;
  readonly multiModel: boolean;
  readonly activeThreadBranch: string | null;
  readonly activeWorktreePath: string | null;
  readonly branchCwd: string | null;
  readonly effectiveEnvMode: EnvMode;
  readonly workspaceVersion: string;
  readonly canApplyWorkspace: () => boolean;
  readonly canMove: boolean;
  readonly moveDisabled: boolean;
  /** Points the thread at `worktreePath` (null: the project folder) on `branch`. */
  readonly onSetThreadBranch: (
    branch: string | null,
    worktreePath: string | null,
    sharedFilesystemConfirmed?: boolean,
  ) => void;
  readonly onDraftChange: (patch: WorkspaceDraftPatch) => void;
  readonly onOpenTerminal?: () => void;
  readonly onCheckoutPullRequestRequest?: (reference: string) => void;
  readonly onComposerFocusRequest?: () => void;
}

const CHANGE_REQUEST_STATE_PRESENTATION: Record<
  ChangeRequest["state"],
  { label: string; className: string }
> = {
  draft: { label: "Draft", className: "text-warning-foreground" },
  open: { label: "Open", className: "text-success-foreground" },
  closed: { label: "Closed", className: "text-muted-foreground" },
  merged: { label: "Merged", className: "text-attention-foreground" },
  unknown: { label: "Change request", className: "text-muted-foreground" },
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An error occurred.";

const threadsLabel = (count: number, where: "here" | "there") =>
  count === 0 ? null : `${count} ${count === 1 ? "thread" : "threads"} ${where}`;

function resolveWorkspaceState(input: {
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  effectiveEnvMode: EnvMode;
}): WorkspaceState {
  if (input.activeWorktreePath)
    return { kind: "worktree", path: input.activeWorktreePath, branch: input.activeThreadBranch };
  if (input.effectiveEnvMode === "worktree")
    return { kind: "newWorktree", base: input.activeThreadBranch };
  return { kind: "local" };
}

/**
 * One control for where a thread works: the project folder ("Local"), a new
 * worktree created from a branch when the first message is sent, or an open
 * worktree. Every row says what picking it does, so picks need no dialog.
 */
export function WorkspacePicker(props: WorkspacePickerProps) {
  const {
    threadId,
    projectId,
    projectCwd,
    isDraft,
    creatingWorktree,
    activeThreadBranch,
    activeWorktreePath,
    branchCwd,
    effectiveEnvMode,
    workspaceVersion,
    canApplyWorkspace,
    onSetThreadBranch,
    onDraftChange,
    onComposerFocusRequest,
    onCheckoutPullRequestRequest,
  } = props;
  const refreshSeconds = useAppSettingsSelector(
    (settings) => settings.gitStatusAutoRefreshIntervalSeconds,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"pick" | "switch">("pick");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [moveOpen, setMoveOpen] = useState(false);
  const [completedMove, setCompletedMove] = useState<WorkspaceTransitionSnapshot | null>(null);
  const context = JSON.stringify([
    threadId,
    projectCwd,
    activeThreadBranch,
    activeWorktreePath,
    effectiveEnvMode,
    workspaceVersion,
  ]);
  const [checkoutConflict, setCheckoutConflict] = useState<{
    conflict: GitCheckoutConflict;
    context: string;
  } | null>(null);
  useEffect(() => setCheckoutConflict(null), [context]);

  const branchesQuery = useQuery(
    gitBranchesQueryOptions({ cwd: branchCwd, autoRefresh: refreshSeconds > 0 }),
  );
  const statusQuery = useQuery(
    gitStatusQueryOptions({
      cwd: branchCwd,
      autoRefresh: refreshSeconds > 0,
      refetchIntervalMs: refreshSeconds * 1000,
    }),
  );
  const worktreesQuery = useQuery({ ...worktreesListQueryOptions(projectId), enabled: open });
  const branches = useMemo(
    () => dedupeRemoteBranchesWithLocalMatches(branchesQuery.data?.branches ?? []),
    [branchesQuery.data?.branches],
  );
  const currentGitBranch =
    statusQuery.data?.branch ?? branches.find((branch) => branch.current)?.name ?? null;
  const projectBranch =
    branchCwd === projectCwd
      ? currentGitBranch
      : (branches.find((branch) => branch.worktreePath === projectCwd)?.name ?? null);
  const checkoutMissing = branchesQuery.data?.worktreeMissing === true;
  const state = resolveWorkspaceState({ activeWorktreePath, activeThreadBranch, effectiveEnvMode });
  const switchPath = switchCheckoutPath(state, projectCwd);

  const availabilityQuery = useQuery({
    queryKey: ["worktrees", "switchAvailability", projectId, switchPath, isDraft ? null : threadId],
    queryFn: () =>
      ensureNativeApi().worktrees.switchAvailability({
        projectId,
        path: switchPath!,
        ...(isDraft ? {} : { threadId }),
      }),
    enabled: open && mode === "switch" && switchPath !== null,
    staleTime: 0,
  });
  const blockers = availabilityQuery.data?.blockers ?? [];
  const switchBlockedReason = availabilityQuery.error
    ? `Could not check who uses this checkout: ${errorMessage(availabilityQuery.error)}`
    : blockers.length
      ? blockedReason(blockers)
      : null;

  // A draft set to a new worktree always has a base; default to the current branch.
  const needsBase = isDraft && state.kind === "newWorktree" && !state.base;
  useEffect(() => {
    if (needsBase && currentGitBranch) onSetThreadBranch(currentGitBranch, null);
  }, [currentGitBranch, needsBase, onSetThreadBranch]);

  useEffect(() => {
    if (!open || isDraft || !activeWorktreePath) {
      setCompletedMove(null);
      return;
    }
    let cancelled = false;
    void ensureNativeApi()
      .worktrees?.getTransition({ threadId })
      .then((record) => {
        if (cancelled) return;
        setCompletedMove(
          record?.intent === "move_to_new_worktree" &&
            record.phase === "completed" &&
            record.target.path === activeWorktreePath &&
            !record.move?.discarded
            ? record
            : null,
        );
      })
      .catch(() => !cancelled && setCompletedMove(null));
    return () => {
      cancelled = true;
    };
  }, [activeWorktreePath, isDraft, open, threadId]);

  const rows = useMemo(
    () =>
      buildWorkspaceRows({
        mode,
        query: deferredQuery,
        isDraft,
        threadId,
        state,
        creatingWorktree,
        projectCwd,
        projectBranch,
        branches,
        linkedThreads: linkedThreadsByPath(
          worktreesQuery.data?.projects.find((entry) => entry.projectId === projectId)?.entries,
        ),
        checkoutMissing,
        prReference: parsePullRequestReference(deferredQuery.trim()),
        canCheckoutPullRequest: onCheckoutPullRequestRequest !== undefined,
        multiModel: props.multiModel,
        canMove: props.canMove,
        moveDisabled: props.moveDisabled,
        hasCompletedMove: completedMove !== null,
        switchBlockedReason,
      }),
    // `state` is derived from the listed props each render.
    [
      mode,
      deferredQuery,
      isDraft,
      threadId,
      activeWorktreePath,
      activeThreadBranch,
      effectiveEnvMode,
      creatingWorktree,
      projectCwd,
      projectBranch,
      branches,
      worktreesQuery.data,
      projectId,
      checkoutMissing,
      onCheckoutPullRequestRequest,
      props.multiModel,
      props.canMove,
      props.moveDisabled,
      completedMove,
      switchBlockedReason,
    ],
  );
  const selectable = useMemo(() => rows.filter(isSelectableRow), [rows]);
  const selectableKeys = useMemo(() => selectable.map((row) => row.key), [selectable]);
  const indexByKey = useMemo(
    () => new Map(selectableKeys.map((key, index) => [key, index] as const)),
    [selectableKeys],
  );
  const selectedKey = selectable.find((row) => "selected" in row && row.selected)?.key ?? null;
  const [isPending, startTransition] = useTransition();
  const virtualize = shouldVirtualizeBranchListForCount(rows.length);
  const listRef = useRef<LegendListRef | null>(null);

  const reset = () => {
    setQuery("");
    setMode("pick");
  };
  const close = () => {
    setOpen(false);
    reset();
    onComposerFocusRequest?.();
  };
  const runBranchAction = (cwd: string, action: () => Promise<void>) =>
    startTransition(async () => {
      await action().catch(() => undefined);
      await invalidateGitQueries(queryClient, { cwd }).catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ["worktrees"] }).catch(() => undefined);
    });
  const handleCheckoutError = (error: unknown) => {
    if (
      error instanceof WsRequestError &&
      error.code === "GitCheckoutConflict" &&
      error.checkoutConflict
    ) {
      setCheckoutConflict({ conflict: error.checkoutConflict, context });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not switch branch",
      description: errorMessage(error),
    });
  };

  const switchBranchHere = (branch: string, isRemote: boolean) => {
    const api = readNativeApi();
    if (!api || !switchPath || isPending) return;
    const cwd = switchPath;
    const worktreePath = state.kind === "worktree" ? state.path : null;
    close();
    runBranchAction(cwd, async () => {
      try {
        if (isDraft) await api.git.checkout({ cwd, branch });
        else await switchConversationWorkspace(threadId, { intent: "checkout_branch", branch });
      } catch (error) {
        handleCheckoutError(error);
        return;
      }
      if (!isDraft) return;
      let next = isRemote ? deriveLocalBranchNameFromRemoteRef(branch) : branch;
      if (isRemote) next = (await api.git.status({ cwd }).catch(() => null))?.branch ?? next;
      if (canApplyWorkspace()) onSetThreadBranch(next, worktreePath);
    });
  };

  const createBranchHere = (name: string) => {
    const api = readNativeApi();
    if (!api || !switchPath || isPending) return;
    const cwd = switchPath;
    const worktreePath = state.kind === "worktree" ? state.path : null;
    close();
    runBranchAction(cwd, async () => {
      try {
        if (isDraft) {
          await api.git.createBranch({ cwd, branch: name });
          await api.git.checkout({ cwd, branch: name });
        } else
          await switchConversationWorkspace(threadId, {
            intent: "create_branch_and_checkout",
            branch: name,
          });
      } catch (error) {
        handleCheckoutError(error);
        return;
      }
      if (isDraft && canApplyWorkspace()) onSetThreadBranch(name, worktreePath);
    });
  };

  const pick = (row: SelectableWorkspaceRow) => {
    switch (row.kind) {
      case "local":
        if (isDraft)
          onDraftChange({
            envMode: "local",
            branch: row.branch,
            worktreePath: null,
            sharedFilesystemConfirmed: false,
          });
        else if (state.kind !== "local") onSetThreadBranch(null, null, row.threadCount > 0);
        return close();
      case "newWorktree":
        onDraftChange({
          envMode: "worktree",
          branch: row.branch,
          worktreePath: null,
          sharedFilesystemConfirmed: false,
        });
        return close();
      case "openWorktree":
        // The row's thread count is the sharing disclosure.
        if (isDraft)
          onDraftChange({
            envMode: "worktree",
            branch: row.branch,
            worktreePath: row.path,
            sharedFilesystemConfirmed: row.threadCount > 0,
          });
        else if (!row.selected) onSetThreadBranch(row.branch, row.path, row.threadCount > 0);
        return close();
      case "newBranchWorktree":
        onDraftChange({
          envMode: "worktree",
          branch: row.base,
          worktreePath: null,
          sharedFilesystemConfirmed: false,
          worktreeBranchName: row.name,
        });
        return close();
      case "pullRequest":
        close();
        onCheckoutPullRequestRequest?.(row.reference);
        return;
      case "back":
        reset();
        return;
      case "switchTarget":
        if (!row.disabled) switchBranchHere(row.branch, row.isRemote);
        return;
      case "createBranchHere":
        if (!row.disabled) createBranchHere(row.name);
        return;
      case "action":
        return runAction(row.action);
    }
  };

  const runAction = (action: Extract<SelectableWorkspaceRow, { kind: "action" }>["action"]) => {
    switch (action) {
      case "switchBranch":
        setQuery("");
        setMode("switch");
        return;
      case "moveToWorktree":
        close();
        setMoveOpen(true);
        return;
      case "manageWorktrees":
        close();
        void navigate({ to: "/worktrees", search: { projectId, threadId } });
        return;
      case "removeWorktree":
        close();
        if (state.kind === "worktree")
          void useWorktreeRemovalDialogStore.getState().request([{ projectId, path: state.path }]);
        return;
      case "discardMove": {
        const move = completedMove;
        close();
        if (!move) return;
        void discardMovedChanges(
          threadId,
          move.operationId,
          move.source.path,
          move.target.branch ?? "worktree",
        )
          .then(async (discarded) => {
            if (!discarded) return;
            setCompletedMove(null);
            await queryClient.invalidateQueries({ queryKey: ["worktrees"] });
            await queryClient.invalidateQueries({ queryKey: ["git"] });
          })
          .catch((error) =>
            toastManager.add({
              type: "error",
              title: "Could not discard originals",
              description: String(error),
            }),
          );
      }
    }
  };

  const handleOpenChange = useCallback(
    (next: boolean, details?: { reason?: string }) => {
      // Rows close the picker themselves: "Switch branch here…" and "Back" keep it open.
      if (!next && details?.reason === "item-press") return;
      setOpen(next);
      if (!next) {
        setQuery("");
        setMode("pick");
        return;
      }
      void refreshCheckedOutGitBranch(queryClient, branchCwd);
    },
    [branchCwd, queryClient],
  );

  useEffect(() => {
    if (open) listRef.current?.scrollToOffset?.({ offset: 0, animated: false });
  }, [deferredQuery, mode, open]);

  const label = workspaceTriggerLabel({
    state,
    creatingWorktree,
    activeThreadBranch,
    projectBranch,
    checkoutMissing,
  });
  const displayPath = state.kind === "worktree" ? state.path : projectCwd;
  const TriggerIcon = state.kind === "local" && !creatingWorktree ? FolderIcon : GitForkIcon;
  const changeRequest =
    statusQuery.data?.branch && statusQuery.data.branch === currentGitBranch
      ? (statusQuery.data.changeRequest ?? null)
      : null;
  const changeRequestUrl = changeRequest ? resolveChangeRequestWebUrl(changeRequest) : null;

  const renderRow = (row: WorkspaceRow) => {
    if (row.kind === "header")
      return (
        <div
          key={row.key}
          role="presentation"
          className="px-2 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {row.label}
        </div>
      );
    if (row.kind === "notice")
      return (
        <p
          key={row.key}
          role={row.tone === "warning" ? "alert" : "status"}
          className={cn(
            "mx-1 my-1 rounded px-2 py-1.5 text-xs",
            row.tone === "warning"
              ? "bg-warning/10 text-warning-foreground"
              : "text-muted-foreground",
          )}
        >
          {row.text}
        </p>
      );
    const disabled =
      (row.kind === "action" || row.kind === "switchTarget" || row.kind === "createBranchHere") &&
      row.disabled;
    return (
      <ComboboxItem
        hideIndicator
        key={row.key}
        index={indexByKey.get(row.key) ?? 0}
        value={row.key}
        disabled={disabled}
        className={cn(
          "selected" in row && row.selected && "bg-accent text-foreground",
          row.kind === "action" && row.destructive && "text-destructive-foreground",
        )}
        onClick={() => pick(row)}
      >
        <WorkspaceRowContent row={row} />
      </ComboboxItem>
    );
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      {moveOpen && (
        <MoveToWorktreeDialog
          threadId={threadId}
          projectCwd={projectCwd}
          disabled={props.moveDisabled}
          onClose={() => setMoveOpen(false)}
        />
      )}
      <Combobox
        items={selectableKeys}
        filteredItems={selectableKeys}
        autoHighlight
        virtualized={virtualize}
        open={open}
        onOpenChange={handleOpenChange}
        value={selectedKey}
        onItemHighlighted={(_value, details) => {
          if (
            !shouldScrollHighlightedBranchIntoView({
              isMenuOpen: open,
              highlightedIndex: details.index,
              highlightReason: details.reason,
            })
          )
            return;
          const key = selectableKeys[details.index];
          const position = rows.findIndex((row) => row.key === key);
          if (position >= 0)
            listRef.current?.scrollIndexIntoView?.({ index: position, animated: false });
        }}
      >
        <ComboboxTrigger
          render={<Button data-composer-control="branch" variant="ghost" size="xs" />}
          className="h-6 min-w-0 text-2xs font-normal text-muted-foreground hover:text-foreground sm:h-6"
          title={displayPath}
          aria-label={`Workspace: ${label}`}
          disabled={
            props.disabled === true ||
            (branchesQuery.isLoading && branches.length === 0) ||
            isPending ||
            checkoutConflict !== null
          }
        >
          <TriggerIcon className="size-3 shrink-0" />
          <MiddleTruncate className="max-w-72" text={label} />
          <ChevronDownIcon />
        </ComboboxTrigger>
        <ComboboxPopup align="start" side="top" className="w-96 max-w-[calc(100vw-2rem)]">
          <WorkspaceHeaderStrip
            state={state}
            creatingWorktree={creatingWorktree}
            path={displayPath}
            onOpenTerminal={props.onOpenTerminal}
            onDone={close}
          />
          <div className="border-b p-1">
            <ComboboxInput
              className="rounded-md"
              inputClassName="ring-0"
              placeholder={
                mode === "switch" ? "Search branches…" : "Search branches and worktrees…"
              }
              showTrigger={false}
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ComboboxEmpty>No branches found.</ComboboxEmpty>
          {checkoutMissing && (
            <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
              {state.kind === "worktree"
                ? activeThreadBranch
                  ? `Worktree missing. Send a message to recreate it on ${activeThreadBranch}.`
                  : "Worktree missing."
                : "The project folder could not be found."}
            </p>
          )}
          {virtualize ? (
            <ComboboxListVirtualized>
              <LegendList<WorkspaceRow>
                ref={listRef}
                data={rows as WorkspaceRow[]}
                keyExtractor={(row) => row.key}
                renderItem={({ item }) => renderRow(item)}
                estimatedItemSize={28}
                drawDistance={336}
                style={{ maxHeight: "18rem" }}
              />
            </ComboboxListVirtualized>
          ) : (
            <ComboboxList className="max-h-72">{rows.map(renderRow)}</ComboboxList>
          )}
          {isDraft && state.kind === "newWorktree" && !creatingWorktree && (
            <NewWorktreeFooter
              threadId={threadId}
              multiModel={props.multiModel}
              hasSetupScript={props.hasSetupScript}
            />
          )}
        </ComboboxPopup>
      </Combobox>
      {changeRequest && changeRequestUrl ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className={CHANGE_REQUEST_STATE_PRESENTATION[changeRequest.state].className}
                aria-label={`Open change request ${changeRequest.displayNumber}`}
                onClick={(event) => {
                  event.preventDefault();
                  const api = readNativeApi();
                  if (!api) return;
                  void api.shell.openExternal(changeRequestUrl).catch((error) =>
                    toastManager.add({
                      type: "error",
                      title: "Unable to open change request",
                      description: errorMessage(error),
                    }),
                  );
                }}
              >
                <GitPullRequestIcon className="size-3" />
                <span>{changeRequest.displayNumber}</span>
              </Button>
            }
          />
          <TooltipPopup side="top">
            {CHANGE_REQUEST_STATE_PRESENTATION[changeRequest.state].label}: {changeRequest.title}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {checkoutConflict && checkoutConflict.context === context ? (
        <GitCheckoutConflictDialog
          key={context}
          conflict={checkoutConflict.conflict}
          threadId={threadId}
          projectCwd={projectCwd}
          canApply={canApplyWorkspace}
          onClose={() => setCheckoutConflict(null)}
          {...(isDraft
            ? {
                // A draft only records the choice; the worktree is created on send.
                onStartNewWorktree: () =>
                  onDraftChange({
                    envMode: "worktree",
                    branch: checkoutConflict.conflict.branch,
                    worktreePath: null,
                    sharedFilesystemConfirmed: false,
                  }),
              }
            : {})}
          onPrepared={(branch, worktreePath) => {
            onSetThreadBranch(branch, worktreePath);
            onComposerFocusRequest?.();
          }}
        />
      ) : null}
    </div>
  );
}

function blockedReason(blockers: ReadonlyArray<{ kind: string; title: string | null }>): string {
  const labels: Record<string, string> = {
    turn: "running turn",
    queued: "queued messages",
    setup: "workspace setup",
    terminal: "open terminal",
    thread: "uses this worktree",
    session: "agent session",
  };
  if (blockers.some((blocker) => blocker.kind === "unknown"))
    return "Who uses this checkout could not be verified. Start a new worktree instead.";
  const names = blockers.map((blocker) =>
    blocker.kind === "otherProfile"
      ? "another profile"
      : `${blocker.title ?? "another conversation"} (${labels[blocker.kind] ?? blocker.kind})`,
  );
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `In use by ${names.slice(0, 3).join(", ")}${more}. Start a new worktree instead.`;
}

function WorkspaceRowContent({ row }: { row: SelectableWorkspaceRow }) {
  const meta = (text: string | null, selected = false) => (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
      {text}
      {selected && <CheckIcon className="size-3" />}
    </span>
  );
  const line = (icon: React.ReactNode, body: React.ReactNode, trailing?: React.ReactNode) => (
    <div className="flex w-full min-w-0 items-center gap-2">
      {icon}
      <span className="min-w-0 flex-1 truncate">{body}</span>
      {trailing}
    </div>
  );
  const fork = <GitForkIcon className="size-3 shrink-0" />;
  switch (row.kind) {
    case "local":
      return line(
        <FolderIcon className="size-3 shrink-0" />,
        <>
          Local
          {row.branch && (
            <>
              {" · "}
              <span className="font-mono">{row.branch}</span>
            </>
          )}
        </>,
        meta(threadsLabel(row.threadCount, "here"), row.selected),
      );
    case "newWorktree":
      return line(
        fork,
        <MiddleTruncate className="font-mono" text={row.branch} />,
        meta(row.isDefault ? "default" : row.isRemote ? "remote" : null, row.selected),
      );
    case "openWorktree":
      return line(
        fork,
        <span title={row.path}>
          <MiddleTruncate className="font-mono" text={row.branch} />
        </span>,
        meta(threadsLabel(row.threadCount, "there"), row.selected),
      );
    case "newBranchWorktree":
      return line(
        <PlusIcon className="size-3 shrink-0" />,
        <>
          New worktree on new branch "<span className="font-mono">{row.name}</span>"
        </>,
        meta(`from ${row.base}`),
      );
    case "pullRequest":
      return (
        <div className="flex min-w-0 flex-col items-start py-1">
          <span className="truncate font-medium">Checkout Pull Request</span>
          <span className="truncate text-muted-foreground text-xs">{row.reference}</span>
        </div>
      );
    case "action":
      return <span className="truncate">{row.label}</span>;
    case "back":
      return line(<ChevronLeftIcon className="size-3 shrink-0" />, row.label);
    case "switchTarget":
      return line(
        null,
        <MiddleTruncate className="font-mono" text={row.branch} />,
        meta(row.current ? "current" : row.isRemote ? "remote" : null),
      );
    case "createBranchHere":
      return line(
        <PlusIcon className="size-3 shrink-0" />,
        <>
          Create branch "<span className="font-mono">{row.name}</span>" here
        </>,
      );
  }
}

function WorkspaceHeaderStrip(props: {
  state: WorkspaceState;
  creatingWorktree: boolean;
  path: string;
  onOpenTerminal: (() => void) | undefined;
  onDone: () => void;
}) {
  if (props.state.kind === "newWorktree" || props.creatingWorktree)
    return (
      <div className="border-b px-3 py-2 text-xs text-muted-foreground">
        {props.creatingWorktree
          ? "Creating the worktree…"
          : props.state.kind === "newWorktree" && props.state.base
            ? `A new worktree from ${props.state.base} is created when you send.`
            : "A new worktree is created when you send."}
      </div>
    );
  const run = (title: string, action: () => Promise<unknown>) => {
    props.onDone();
    void action().catch((error) =>
      toastManager.add({ type: "error", title, description: String(error) }),
    );
  };
  const iconButton = (label: string, icon: React.ReactNode, onClick: (() => void) | undefined) => (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      disabled={!onClick}
      onClick={onClick}
    >
      {icon}
    </Button>
  );
  return (
    <div className="flex items-center gap-1 border-b py-1 ps-3 pe-1">
      <span
        className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground"
        title={props.path}
      >
        {props.path}
      </span>
      {iconButton("Copy path", <CopyIcon />, () =>
        run("Could not copy the path", () => writeTextToClipboard(props.path)),
      )}
      {iconButton("Open in editor", <CodeIcon />, () =>
        run("Could not open the editor", () =>
          openInPreferredEditor(ensureNativeApi(), props.path),
        ),
      )}
      {iconButton("Reveal", <FolderOpenIcon />, () =>
        run("Could not reveal the folder", () =>
          ensureNativeApi().shell.openInEditor(props.path, "file-manager"),
        ),
      )}
      {iconButton(
        "Open terminal here",
        <TerminalIcon />,
        props.onOpenTerminal
          ? () => {
              props.onDone();
              props.onOpenTerminal?.();
            }
          : undefined,
      )}
    </div>
  );
}

function NewWorktreeFooter(props: {
  threadId: ThreadId;
  multiModel: boolean;
  hasSetupScript: boolean;
}) {
  const draft = useComposerDraftStore((store) => store.getDraftThread(props.threadId));
  const update = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [name, setName] = useState(draft?.worktreeBranchName ?? "");
  const invalid = /\s/.test(name.trim());
  if (!draft) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs"
      // The combobox owns arrow and Enter keys; keep them in these fields.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-muted-foreground">Branch name</span>
        <Input
          aria-label="Branch name"
          size="sm"
          className="min-w-0 flex-1 font-mono"
          placeholder="auto"
          disabled={props.multiModel}
          title={
            props.multiModel
              ? "Branch names are generated independently for each model."
              : undefined
          }
          value={props.multiModel ? "" : name}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            const next = event.target.value;
            setName(next);
            const trimmed = next.trim();
            if (/\s/.test(trimmed)) return;
            update(props.threadId, { worktreeBranchName: trimmed || null });
          }}
        />
      </label>
      {props.hasSetupScript && (
        <label className="inline-flex items-center gap-1 whitespace-nowrap">
          <input
            type="checkbox"
            checked={draft.runSetupScript ?? true}
            onChange={(event) => update(props.threadId, { runSetupScript: event.target.checked })}
          />
          Run setup script
        </label>
      )}
      {invalid && (
        <p role="alert" className="basis-full text-destructive-foreground">
          Branch names cannot contain spaces.
        </p>
      )}
    </div>
  );
}
