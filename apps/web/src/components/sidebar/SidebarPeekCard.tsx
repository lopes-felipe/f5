import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2Icon, GitBranchIcon, GitPullRequestIcon, SquarePenIcon } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type ReactElement,
  type ReactNode,
  use,
  useEffect,
  useState,
} from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useNowMinute } from "../../lib/nowTicker";
import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { selectThreadById, type ThreadSummary } from "../../threadSelectors";
import { ModelChip } from "../chat/ModelChip";
import { resolveSidebarComposerDraftPreview } from "../Sidebar.logic";
import { ThreadQueueCountBadge } from "../thread/ThreadQueueCountBadge";
import { ThreadStatusPillBadge } from "../thread/ThreadStatusPillBadge";
import { TooltipPopup, TooltipScrollDismissArea } from "../ui/tooltip";
import type { WorkflowCurrentStep, WorkflowPhaseSummary } from "../workflow/workflowTimelineTypes";
import {
  contextUsagePercent,
  firstPendingQuestion,
  localThreadPeek,
  resolveSidebarPeekStatus,
  SIDEBAR_PEEK_CLOSE_DELAY_MS,
  SIDEBAR_PEEK_DELAY_MS,
  stripMarkdownToPlainText,
  threadPeekQueryOptions,
} from "./sidebarPeek";
import type { SidebarThreadRowIndicators } from "./SidebarWorkflowItem";

export type SidebarPeekPayload =
  | {
      readonly kind: "thread";
      readonly threadId: ThreadId;
      /** A workflow child's role label, shown before the workflow title. */
      readonly roleLabel?: string | undefined;
      readonly workflowTitle?: string | undefined;
      readonly indicators: SidebarThreadRowIndicators;
    }
  | {
      readonly kind: "workflow";
      readonly title: string;
      readonly typeLabel: string;
      readonly projectId: ProjectId;
      readonly phases: readonly WorkflowPhaseSummary[];
      readonly currentStep: WorkflowCurrentStep | null;
      readonly threads: readonly ThreadSummary[];
    };

type SidebarPeekHandle = ReturnType<typeof TooltipPrimitive.createHandle<SidebarPeekPayload>>;

interface SidebarPeekContextValue {
  readonly handle: SidebarPeekHandle;
}

const SidebarPeekContext = createContext<SidebarPeekContextValue | null>(null);

/**
 * Whether a press or drag is under way: a held pointer covers the dnd-kit reorders, and
 * native drag events cover thread reference drags, whose pointer stream the browser cancels.
 */
function usePointerHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const press = () => setHeld(true);
    const release = () => setHeld(false);
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("dragstart", press, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("dragend", release, true);
    window.addEventListener("drop", release, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("dragstart", press, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("dragend", release, true);
      window.removeEventListener("drop", release, true);
      window.removeEventListener("blur", release);
    };
  }, []);
  return held;
}

/**
 * One read-only hover card for every sidebar row. Rows are detached triggers of a single
 * tooltip, so moving between rows while it is open swaps the card without a new delay.
 * `suppressed` closes it and keeps it closed (rename, open menu, multi-selection); so does
 * any press or drag.
 */
export function SidebarPeekProvider(props: { suppressed: boolean; children: ReactNode }) {
  const [handle] = useState(() => TooltipPrimitive.createHandle<SidebarPeekPayload>());
  const pointerHeld = usePointerHeld();
  return (
    <SidebarPeekContext value={{ handle }}>
      {props.children}
      <TooltipPrimitive.Root handle={handle} disabled={props.suppressed || pointerHeld}>
        {({ payload }) =>
          payload ? (
            <TooltipPopup
              side="right"
              align="start"
              sideOffset={8}
              className="w-80 max-w-80 whitespace-normal text-wrap"
              data-testid="sidebar-peek-card"
            >
              {payload.kind === "thread" ? (
                <ThreadPeekContent payload={payload} />
              ) : (
                <WorkflowPeekContent payload={payload} />
              )}
            </TooltipPopup>
          ) : null
        }
      </TooltipPrimitive.Root>
    </SidebarPeekContext>
  );
}

/**
 * The sidebar's scrolling region: closes hovered tooltips, and the peek card, when it scrolls
 * away under a still pointer. A card opened by keyboard focus stays, since moving focus
 * scrolls the row into view.
 */
export function SidebarPeekScrollDismissArea(props: ComponentProps<"div">) {
  const context = use(SidebarPeekContext);
  return (
    <TooltipScrollDismissArea
      {...props}
      onScrollCapture={(event) => {
        props.onScrollCapture?.(event);
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused.matches("[data-sidebar-row]:focus-visible")) {
          return;
        }
        context?.handle.close();
      }}
    />
  );
}

/**
 * Wraps a row's rendered element in a peek trigger. Without a provider, on touch screens,
 * or when `disabled` (a draft without a server thread), the element is returned unchanged.
 */
export function useSidebarPeekTrigger(
  payload: SidebarPeekPayload,
  options: { disabled?: boolean | undefined; prefetchThreadId?: ThreadId | null | undefined },
): (element: ReactElement) => ReactElement {
  const context = use(SidebarPeekContext);
  const coarse = useMediaQuery("(hover: none), (pointer: coarse)");
  const queryClient = useQueryClient();
  if (!context || coarse || options.disabled) return (element) => element;
  const prefetchThreadId =
    options.prefetchThreadId === undefined
      ? payload.kind === "thread"
        ? payload.threadId
        : null
      : options.prefetchThreadId;
  // Starts the read during the hover delay, so the card usually opens complete.
  const prefetch = () => {
    if (!prefetchThreadId) return;
    const thread = selectThreadById(useStore.getState(), prefetchThreadId);
    if (!thread || localThreadPeek(thread)) return;
    void queryClient.prefetchQuery(threadPeekQueryOptions(thread.id, thread.latestTurn));
  };
  return (element) => (
    <TooltipPrimitive.Trigger
      handle={context.handle}
      payload={payload}
      delay={SIDEBAR_PEEK_DELAY_MS}
      closeDelay={SIDEBAR_PEEK_CLOSE_DELAY_MS}
      render={element}
      onPointerEnter={prefetch}
      onFocus={prefetch}
    />
  );
}

/** Last prompt, reply snippet and diff totals: local when the thread is loaded, else the RPC. */
function useThreadPeekDetails(threadId: ThreadId | null) {
  const thread = useStore((state) => (threadId ? selectThreadById(state, threadId) : undefined));
  const local = thread ? localThreadPeek(thread) : null;
  const query = useQuery({
    ...threadPeekQueryOptions(threadId ?? ("" as ThreadId), thread?.latestTurn ?? null),
    enabled: threadId !== null && thread !== undefined && local === null,
  });
  return {
    thread,
    details: local ?? query.data ?? null,
    pending: local === null && query.isPending && query.fetchStatus !== "idle",
  };
}

function PeekSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-1" data-testid="sidebar-peek-skeleton">
      <span className="h-2.5 w-3/4 animate-pulse rounded bg-muted" />
      <span className="h-2.5 w-full animate-pulse rounded bg-muted" />
      <span className="h-2.5 w-5/6 animate-pulse rounded bg-muted" />
    </div>
  );
}

function PeekReply(props: { threadId: ThreadId | null; question: string | null }) {
  const { details, pending } = useThreadPeekDetails(props.threadId);
  if (props.question) {
    return (
      <p className="line-clamp-3 rounded-sm bg-warning/10 px-1.5 py-1 text-warning-foreground">
        {props.question}
      </p>
    );
  }
  if (pending) return <PeekSkeleton />;
  if (!details) return null;
  const reply = details.lastAssistantText
    ? stripMarkdownToPlainText(details.lastAssistantText)
    : "";
  return (
    <div className="flex flex-col gap-1">
      {details.lastUserText ? (
        <p className="line-clamp-1 text-muted-foreground" data-testid="sidebar-peek-prompt">
          <span className="text-faint-foreground">You: </span>
          {details.lastUserText}
        </p>
      ) : null}
      {reply ? (
        <p className="line-clamp-3" data-testid="sidebar-peek-reply">
          {reply}
        </p>
      ) : null}
      {details.latestTurnDiff ? (
        <p className="text-2xs text-muted-foreground tabular-nums">
          {`${details.latestTurnDiff.files} ${details.latestTurnDiff.files === 1 ? "file" : "files"} `}
          <span className="text-success-foreground">{`+${details.latestTurnDiff.additions}`}</span>{" "}
          <span className="text-destructive-foreground">{`−${details.latestTurnDiff.deletions}`}</span>
        </p>
      ) : null}
    </div>
  );
}

function prNumberFromUrl(url: string): string | null {
  return /\/pull\/(\d+)/.exec(url)?.[1] ?? null;
}

function ThreadPeekContent({
  payload,
}: {
  payload: Extract<SidebarPeekPayload, { kind: "thread" }>;
}) {
  "use memo";
  const now = useNowMinute();
  const thread = useStore((state) => selectThreadById(state, payload.threadId));
  const project = useStore((state) =>
    thread ? state.projects.find((entry) => entry.id === thread.projectId) : undefined,
  );
  const draft = useComposerDraftStore((store) => store.draftsByThreadId[payload.threadId]);
  if (!thread) return null;
  const { threadStatus, prStatus, isUnread } = payload.indicators;
  const status = resolveSidebarPeekStatus({
    pill: threadStatus,
    latestTurn: thread.latestTurn,
    error: thread.error,
    isUnread,
    now,
  });
  const question =
    threadStatus?.label === "Awaiting Input"
      ? firstPendingQuestion(thread.pendingUserInputs)
      : null;
  const context = contextUsagePercent(
    thread.estimatedContextTokens,
    thread.modelContextWindowTokens,
  );
  const draftPreview = resolveSidebarComposerDraftPreview(draft);
  const prNumber = prStatus ? prNumberFromUrl(prStatus.url) : null;
  const scratch = project ? isScratchProject(project) : false;

  return (
    <div className="flex flex-col gap-1.5 py-1 text-left leading-snug" data-peek-thread={thread.id}>
      <p className="font-medium text-foreground">
        {payload.roleLabel ? (
          <>
            {payload.roleLabel}
            <span className="font-normal text-muted-foreground">{` · ${payload.workflowTitle}`}</span>
          </>
        ) : (
          thread.title
        )}
      </p>
      <p className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
        <span className="truncate">{scratch ? "No project" : (project?.name ?? "Project")}</span>
        {thread.branch ? (
          <>
            <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{thread.branch}</span>
          </>
        ) : null}
        {thread.worktreePath ? (
          <FolderGit2Icon aria-label="Worktree" className="size-3 shrink-0" />
        ) : null}
      </p>
      {status ? (
        <p className="flex min-w-0 items-center gap-1.5 text-2xs" data-testid="sidebar-peek-status">
          {threadStatus ? (
            <ThreadStatusPillBadge pill={threadStatus} variant="icon" live={false} />
          ) : null}
          <span className="shrink-0 font-medium">{status.label}</span>
          {status.detail ? (
            <span className="min-w-0 truncate text-muted-foreground">{status.detail}</span>
          ) : null}
        </p>
      ) : null}
      <PeekReply threadId={thread.id} question={question} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
        <ModelChip
          model={thread.modelSelection?.model ?? thread.model}
          sessionProviderName={thread.session?.provider}
        />
        {prStatus ? (
          <span className={cn("inline-flex items-center gap-0.5", prStatus.colorClass)}>
            <GitPullRequestIcon aria-hidden="true" className="size-3" />
            {prNumber ? `${prStatus.label} #${prNumber}` : prStatus.label}
          </span>
        ) : null}
        {context !== null ? <span className="tabular-nums">{`${context}% context`}</span> : null}
        <ThreadQueueCountBadge threadId={thread.id} />
      </div>
      {draftPreview ? (
        <p className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
          <SquarePenIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{`Draft: ${draftPreview}`}</span>
        </p>
      ) : null}
    </div>
  );
}

const PHASE_STATE_CLASS: Record<WorkflowPhaseSummary["state"], string> = {
  completed: "bg-success",
  active: "bg-info",
  error: "bg-destructive",
  pending: "bg-border",
};

function WorkflowPeekContent({
  payload,
}: {
  payload: Extract<SidebarPeekPayload, { kind: "workflow" }>;
}) {
  "use memo";
  const project = useStore((state) =>
    state.projects.find((entry) => entry.id === payload.projectId),
  );
  const threadById = new Map(payload.threads.map((thread) => [thread.id, thread] as const));
  const currentThreadId = payload.currentStep?.threadId ?? null;
  return (
    <div
      className="flex flex-col gap-1.5 py-1 text-left leading-snug"
      data-testid="sidebar-peek-workflow"
    >
      <div>
        <p className="font-medium text-foreground">{payload.title}</p>
        <p className="text-2xs text-muted-foreground">
          {`${payload.typeLabel} · ${project && !isScratchProject(project) ? project.name : "No project"}`}
        </p>
      </div>
      <ol className="flex flex-col gap-1">
        {payload.phases.map((phase, index) => (
          <li key={`${index}:${phase.label}`} data-peek-phase={phase.state}>
            <p className="flex items-center gap-1.5 font-medium">
              <span
                aria-hidden="true"
                className={cn("size-1.5 shrink-0 rounded-full", PHASE_STATE_CLASS[phase.state])}
              />
              {phase.label}
            </p>
            {phase.steps.length > 0 ? (
              <ul className="mt-0.5 flex flex-col gap-0.5 pl-3">
                {phase.steps.map((step, stepIndex) => {
                  const thread = step.threadId ? threadById.get(step.threadId) : undefined;
                  const model = thread
                    ? (thread.modelSelection?.model ?? thread.model)
                    : step.modelSlot?.model;
                  return (
                    <li
                      key={`${stepIndex}:${step.label}`}
                      className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground"
                    >
                      <span className="min-w-0 truncate">{step.label}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {model ? (
                          <ModelChip
                            model={model}
                            provider={thread ? undefined : step.modelSlot?.provider}
                            sessionProviderName={thread?.sessionProvider}
                            iconOnly
                          />
                        ) : null}
                        {thread ? (
                          <span className="tabular-nums">
                            {formatRelativeTimeLabel(thread.lastInteractionAt)}
                          </span>
                        ) : (
                          <span className="text-faint-foreground">{step.state}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      {currentThreadId ? <PeekReply threadId={currentThreadId} question={null} /> : null}
    </div>
  );
}
