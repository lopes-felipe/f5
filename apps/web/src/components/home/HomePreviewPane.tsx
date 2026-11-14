import type { OrchestrationThreadPeek, ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ClockIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
} from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

import { useQuery } from "@tanstack/react-query";

import type { ThreadActionMenuItem } from "../../hooks/useThreadActionController";
import type { HomeThreadItemKind } from "../../lib/homeQueue";
import { useNowMinute } from "../../lib/nowTicker";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { useNextTurnQueueBadge, useNextTurnQueueCount } from "../../nextTurnQueueStore";
import { useStore } from "../../store";
import { selectThreadById } from "../../threadSelectors";
import { pillForStatus } from "../../threadStatus";
import type { Project, Thread } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { AsyncUserInputPanel } from "../chat/AsyncUserInputPanel";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { ModelChip } from "../chat/ModelChip";
import { describeQueueBlockedState } from "../chat/NextTurnQueuePanel.logic";
import { ProposedPlanCard } from "../chat/ProposedPlanCard";
import { ProjectIcon } from "../ProjectIcon";
import { contextUsagePercent, stripMarkdownToPlainText } from "../sidebar/sidebarPeek";
import { useLiveThreadActivityAt } from "../thread/ThreadActivityTime";
import { ThreadStatusPillBadge } from "../thread/ThreadStatusPillBadge";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SectionLabel } from "../ui/section-label";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import {
  approvalDenyDecision,
  approvalEnterDecision,
  HomeApprovalActions,
  type HomeApprovalState,
  type HomePreviewKeys,
  homePreviewKeys,
  homeQueueSnapshotQueryKey,
  HomeReplyBox,
  useHomeInlineActions,
} from "./HomeInlineActions";
import {
  deriveHomeThreadDecision,
  HOME_REPLY_BOX_BY_KIND,
  type HomeItem,
  type HomeThreadDecision,
  type HomeThreadItem,
  type HomeWorkflowItem,
  type HomeWorkflowRow,
  homeSettleBlocker,
  runningTurnElapsed,
} from "./homeItems";
import { type HomeThreadTail, useHomeThreadTail } from "./useHomeThreadTail";

/** What the preview's buttons do; Home's keys call the same functions. */
export interface HomePreviewActions {
  readonly openThread: (threadId: ThreadId) => void;
  readonly openWorkflow: (workflow: HomeWorkflowRow) => void;
  readonly settle: (threadId: ThreadId) => void;
  readonly togglePin: (threadId: ThreadId) => void;
  readonly snooze: (threadId: ThreadId, actionId: ThreadActionMenuItem["id"]) => void;
  /** Gives the keyboard back to the queue (or to the preview while it stands alone). */
  readonly focusQueue: () => void;
}

/**
 * The actions Home's keys reach in the shown preview. It exists only once the preview has
 * rendered the selected item, so a key can never act on something not on screen. Each
 * method returns whether it did anything.
 */
export interface HomePreviewHandle {
  /** Enter: approve the request shown, or implement the plan shown. */
  readonly primary: () => boolean;
  /** D: decline the request shown. */
  readonly deny: () => boolean;
  /** R: put the cursor in the reply box. */
  readonly focusReply: () => boolean;
}

export interface HomePreviewPaneProps {
  readonly item: HomeItem;
  readonly project: Project | undefined;
  readonly peek: OrchestrationThreadPeek | undefined;
  readonly actions: HomePreviewActions;
  readonly handleRef?: Ref<HomePreviewHandle> | undefined;
  /** What Enter and D do on the item shown, so the key hints only name keys that act. */
  readonly onKeysChange?: ((itemId: string, keys: HomePreviewKeys) => void) | undefined;
  /** The preview stands alone (narrow layout), so it holds focus for Home's keys. */
  readonly holdsFocus?: boolean | undefined;
  /** The snooze menu is opened by its button or by Home's H key. */
  readonly snoozeMenu: {
    readonly open: boolean;
    readonly items: ReadonlyArray<ThreadActionMenuItem>;
    readonly onOpenChange: (open: boolean) => void;
  };
  /** Narrow layout: the pane replaces the list and offers the way back. */
  readonly onBack?: (() => void) | undefined;
}

const PANE_CLASS_NAME =
  "flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border bg-card shadow-xs/5";

function PaneHeader(props: {
  readonly title: string;
  readonly project: Project | undefined;
  readonly branch?: string | null | undefined;
  readonly trailing: React.ReactNode;
  readonly onBack?: (() => void) | undefined;
}) {
  const { project } = props;
  const scratch = project ? isScratchProject(project) : false;
  return (
    <header className="flex flex-col gap-1.5 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        {props.onBack ? (
          <Button size="xs" variant="ghost" onClick={props.onBack} aria-label="Back to queue">
            <ArrowLeftIcon />
            Queue
            <Kbd>Esc</Kbd>
          </Button>
        ) : null}
        {project ? (
          <ProjectIcon
            projectId={project.id}
            kind={project.kind}
            name={project.name}
            icon={project.icon}
            className="size-3.5 shrink-0"
          />
        ) : null}
        <span className="min-w-0 truncate font-mono">
          {scratch ? "No project" : (project?.name ?? "Unknown project")}
        </span>
        {props.branch ? (
          <>
            <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="min-w-0 truncate font-mono">{props.branch}</span>
          </>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-2">{props.trailing}</span>
      </div>
      <h2 className="font-heading text-base font-semibold tracking-tight text-foreground">
        {props.title}
      </h2>
    </header>
  );
}

/**
 * The pane's scrolling body. A click in its text focuses the body, not the pane: Home's
 * letter keys keep working, the arrow keys scroll what is being read, and Enter, which
 * the pane gets only while it stands in for the queue, does not act on it.
 */
function PaneBody(props: { readonly children: React.ReactNode }) {
  return (
    <div
      tabIndex={-1}
      data-slot="home-preview-body"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3 outline-none"
    >
      {props.children}
    </div>
  );
}

function Block(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5" aria-label={props.label}>
      <SectionLabel as="h3">{props.label}</SectionLabel>
      {props.children}
    </section>
  );
}

function MonoBlock(props: { readonly children: React.ReactNode; readonly tone?: "error" }) {
  return (
    <pre
      className={cn(
        "max-h-64 overflow-auto rounded-lg px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap",
        props.tone === "error"
          ? "bg-destructive/8 text-destructive-foreground"
          : "bg-muted text-foreground",
      )}
    >
      {props.children}
    </pre>
  );
}

/** The last prompt and reply: whole from the tail read, the peek's snippet until it lands. */
function LastExchange(props: {
  readonly tail: HomeThreadTail;
  readonly peek: OrchestrationThreadPeek | undefined;
  readonly cwd: string | undefined;
  readonly replyLabel: string;
}) {
  const { tail, peek } = props;
  const prompt = tail.lastPrompt ?? peek?.lastUserText ?? null;
  const snippet = peek?.lastAssistantText ? stripMarkdownToPlainText(peek.lastAssistantText) : null;
  return (
    <>
      {prompt ? (
        <Block label="Your last message">
          <p className="line-clamp-4 text-sm whitespace-pre-wrap text-muted-foreground">{prompt}</p>
        </Block>
      ) : null}
      {tail.lastReply ? (
        <Block label={props.replyLabel}>
          <div className="min-w-0 text-sm" data-testid="home-preview-reply">
            <ChatMarkdown text={tail.lastReply} cwd={props.cwd} isStreaming={false} />
          </div>
        </Block>
      ) : snippet ? (
        <Block label={props.replyLabel}>
          <p className="text-sm text-foreground" data-testid="home-preview-reply">
            {snippet}
          </p>
        </Block>
      ) : tail.pending ? (
        <div aria-hidden="true" className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-3/4 rounded-full" />
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="h-3 w-5/6 rounded-full" />
        </div>
      ) : null}
    </>
  );
}

function ApprovalBody(props: {
  readonly decision: HomeThreadDecision;
  readonly state: HomeApprovalState;
}) {
  const approval = props.decision.approvals[0];
  if (!approval) {
    return <p className="text-sm text-muted-foreground">This approval was already answered.</p>;
  }
  return (
    <>
      {/* The thread's own panel, so Home shows everything the request says before a decision. */}
      <div className="min-w-0 rounded-lg border border-border bg-muted/40">
        <ComposerPendingApprovalPanel
          approval={approval}
          pendingCount={props.decision.approvals.length}
        />
      </div>
      {props.state === "open" ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {props.state === "sent"
            ? "Decision sent. Waiting for the agent to continue."
            : "This request was already answered."}
        </p>
      )}
    </>
  );
}

/** The oldest open question, answered in place unless it is a provider form. */
function QuestionBody(props: {
  readonly threadId: ThreadId;
  readonly decision: HomeThreadDecision;
  readonly cwd: string | undefined;
}) {
  const input = props.decision.userInputs[0];
  if (!input) {
    return <p className="text-sm text-muted-foreground">This question was already answered.</p>;
  }
  if (!input.elicitation) {
    return (
      // The panel has keys of its own (digits pick an option); Home's stay out of it.
      <div data-home-keys="ignore" data-slot="home-question">
        <AsyncUserInputPanel
          // A panel that sent its answer hides itself: the next question gets a new one.
          key={input.requestId}
          threadId={props.threadId}
          input={input}
          cwd={props.cwd}
        />
      </div>
    );
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">
        This request is a form from the provider. Open the thread to fill it in.
      </p>
      {input.questions.map((question) => (
        <Block key={question.id} label={question.header}>
          <p className="text-sm text-foreground">{question.question}</p>
          {question.options.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {question.options.map((option) => (
                <li key={option.label} className="flex gap-2">
                  <span aria-hidden="true">•</span>
                  <span>
                    <span className="text-foreground">{option.label}</span>
                    {option.description ? ` — ${option.description}` : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Block>
      ))}
    </>
  );
}

function RunningBody(props: {
  readonly thread: Thread;
  readonly tail: HomeThreadTail;
  readonly now: number;
}) {
  const { tasks } = props.tail;
  const done = tasks.filter((task) => task.status === "completed").length;
  const active = tasks.find((task) => task.status === "in_progress");
  const elapsed = runningTurnElapsed(props.thread.latestTurn, props.now);
  return (
    <Block label={elapsed ? `Working for ${elapsed}` : "Working"}>
      {tasks.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div
            role="progressbar"
            aria-label="Tasks done"
            aria-valuemin={0}
            aria-valuemax={tasks.length}
            aria-valuenow={done}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-info"
              style={{ width: `${(done / tasks.length) * 100}%` }}
            />
          </div>
          <p className="text-2xs text-muted-foreground tabular-nums">
            {done}/{tasks.length} tasks{active ? ` · ${active.activeForm}` : ""}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No task list for this turn.</p>
      )}
    </Block>
  );
}

function ThreadMeta(props: {
  readonly thread: Thread;
  readonly peek: OrchestrationThreadPeek | undefined;
}) {
  const { thread, peek } = props;
  const context = contextUsagePercent(
    thread.estimatedContextTokens,
    thread.modelContextWindowTokens,
  );
  const diff = peek?.latestTurnDiff ?? null;
  const openLink = (url: string) => {
    const api = readNativeApi();
    if (!api) return;
    void api.shell.openExternal(url).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to open the pull request",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
      <ModelChip
        model={thread.modelSelection?.model ?? thread.model}
        sessionProviderName={thread.session?.provider}
      />
      {diff ? (
        <span className="tabular-nums">
          {`${diff.files} ${diff.files === 1 ? "file" : "files"} `}
          <span className="text-success-foreground">{`+${diff.additions}`}</span>{" "}
          <span className="text-destructive-foreground">{`−${diff.deletions}`}</span>
        </span>
      ) : null}
      {(thread.pullRequests ?? []).slice(0, 3).map((link) => (
        <button
          key={link.url}
          type="button"
          title={link.title}
          className="inline-flex items-center gap-0.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openLink(link.url)}
        >
          <GitPullRequestIcon aria-hidden="true" className="size-3" />#{link.number}
        </button>
      ))}
      {context !== null ? <span className="tabular-nums">{`${context}% context`}</span> : null}
    </div>
  );
}

/** Why the queue stopped and how much waits in it. */
function QueuePausedBody(props: { readonly threadId: ThreadId }) {
  const queuedCount = useNextTurnQueueCount(props.threadId);
  const snapshot = useQuery({
    queryKey: homeQueueSnapshotQueryKey(props.threadId),
    queryFn: () => ensureNativeApi().nextTurnQueue.list({ threadId: props.threadId }),
    staleTime: 10_000,
  });
  const reason = snapshot.data ? describeQueueBlockedState(snapshot.data) : null;
  return (
    <Block label="Queue paused">
      <p className="text-sm text-muted-foreground">
        {queuedCount > 0
          ? `${queuedCount} queued ${queuedCount === 1 ? "turn waits" : "turns wait"} until the queue is resumed.`
          : "Nothing is queued. Resume the queue to let new turns start."}
      </p>
      {reason ? <p className="text-sm text-foreground">{reason}</p> : null}
    </Block>
  );
}

function ThreadActions(props: {
  readonly item: HomeThreadItem;
  readonly actions: HomePreviewActions;
  readonly snoozeMenu: HomePreviewPaneProps["snoozeMenu"];
  /** False when the item has an action of its own above: opening is then the second choice. */
  readonly openIsPrimary: boolean;
}) {
  const { item, actions, snoozeMenu } = props;
  const threadId = item.thread.id;
  const pinned = item.thread.pinnedAt != null;
  const settleBlocker = homeSettleBlocker({ kind: item.kind, pinned });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        size="sm"
        variant={props.openIsPrimary ? "default" : "outline"}
        onClick={() => actions.openThread(threadId)}
      >
        Open thread
        <Kbd
          className={
            props.openIsPrimary ? "bg-primary-foreground/15 text-primary-foreground" : undefined
          }
        >
          O
        </Kbd>
        <ArrowRightIcon />
      </Button>
      <span className="flex-1" />
      <Button
        size="sm"
        variant="outline"
        // The server refuses these; the title says what to do first.
        disabled={settleBlocker !== null}
        title={settleBlocker ?? undefined}
        onClick={() => actions.settle(threadId)}
      >
        <CheckCircle2Icon />
        Settle
        <Kbd>E</Kbd>
      </Button>
      <Menu open={snoozeMenu.open} onOpenChange={snoozeMenu.onOpenChange}>
        <MenuTrigger
          render={
            <Button size="sm" variant="outline">
              <ClockIcon />
              Snooze
              <Kbd>H</Kbd>
            </Button>
          }
        />
        <MenuPopup align="end">
          {snoozeMenu.items.map((entry) => (
            <MenuItem key={entry.id} onClick={() => actions.snooze(threadId, entry.id)}>
              {entry.label.replace(/^Snooze: /, "")}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <Button
        size="sm"
        variant="outline"
        aria-pressed={pinned}
        onClick={() => actions.togglePin(threadId)}
      >
        {pinned ? <PinOffIcon /> : <PinIcon />}
        {pinned ? "Unpin" : "Pin"}
        <Kbd>P</Kbd>
      </Button>
    </div>
  );
}

const REPLY_LABEL_BY_KIND: Record<HomeThreadItemKind, string> = {
  approval: "Latest reply",
  question: "Latest reply",
  plan: "Latest reply",
  "queue-paused": "Latest reply",
  failed: "Latest reply",
  completed: "Reply",
  running: "Previous reply",
  pinned: "Latest reply",
};

interface ThreadPreviewProps {
  readonly item: HomeThreadItem;
  readonly project: Project | undefined;
  readonly peek: OrchestrationThreadPeek | undefined;
  readonly actions: HomePreviewActions;
  readonly handleRef?: Ref<HomePreviewHandle> | undefined;
  readonly onKeysChange?: HomePreviewPaneProps["onKeysChange"];
  readonly holdsFocus?: boolean | undefined;
  readonly snoozeMenu: HomePreviewPaneProps["snoozeMenu"];
  readonly onBack?: (() => void) | undefined;
}

/**
 * Focuses the preview when it stands alone and nothing else holds focus: as it opens over
 * the queue, and again when it remounts for the next item (the last one was settled or
 * snoozed and took the focused button with it).
 */
function useHoldFocus(holdsFocus: boolean | undefined) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (holdsFocus && document.activeElement === document.body) {
      ref.current?.focus({ preventScroll: true });
    }
  }, [holdsFocus]);
  return ref;
}

function ThreadPreview(props: ThreadPreviewProps) {
  const thread = useStore((state) => selectThreadById(state, props.item.thread.id));
  // The thread was deleted while its row was still on screen.
  return thread ? <LoadedThreadPreview {...props} thread={thread} /> : null;
}

function LoadedThreadPreview(props: ThreadPreviewProps & { readonly thread: Thread }) {
  "use memo";
  const { item, thread } = props;
  const projects = useStore((state) => state.projects);
  const queuePaused = useNextTurnQueueBadge(thread.id) === "paused";
  const now = useNowMinute();
  const activityAt = useLiveThreadActivityAt(item.thread.id, item.thread.lastInteractionAt);
  const tail = useHomeThreadTail(thread);
  const title = item.thread.title.trim() || "Untitled thread";
  const pill = pillForStatus(item.thread.status);
  const decision = deriveHomeThreadDecision(thread);
  const cwd = resolveThreadWorkspaceCwd({ thread, projects });
  const inline = useHomeInlineActions({
    thread,
    project: props.project,
    decision,
    cwd,
    focusQueue: props.actions.focusQueue,
    openThread: props.actions.openThread,
  });
  const articleRef = useHoldFocus(props.holdsFocus);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const replyBox = HOME_REPLY_BOX_BY_KIND[item.kind];
  // The request the buttons and keys act on: the one on screen, until its answer left.
  const openApproval =
    item.kind === "approval" && inline.approvalState === "open" ? inline.approval : null;
  const hasOwnAction =
    openApproval !== null ||
    (item.kind === "plan" && decision.plan !== null) ||
    (item.kind === "queue-paused" && queuePaused);

  // The hints below the queue name Enter and D only for what they would do here.
  const keys = homePreviewKeys({
    kind: item.kind,
    openApproval,
    hasPlan: decision.plan !== null,
  });
  const { onKeysChange } = props;
  useEffect(() => {
    onKeysChange?.(item.id, { primary: keys.primary, deny: keys.deny });
  }, [item.id, keys.deny, keys.primary, onKeysChange]);

  useImperativeHandle(props.handleRef, () => ({
    primary: () => {
      if (!inline.enabled) return false;
      if (item.kind === "plan") return inline.implementPlan();
      const approveDecision = openApproval ? approvalEnterDecision(openApproval) : null;
      if (!openApproval || !approveDecision) return false;
      inline.respondToApproval(openApproval, approveDecision);
      return true;
    },
    deny: () => {
      const denyDecision = openApproval ? approvalDenyDecision(openApproval) : null;
      if (!inline.enabled || !openApproval || !denyDecision) return false;
      inline.respondToApproval(openApproval, denyDecision);
      return true;
    },
    focusReply: () => {
      if (!replyRef.current) return false;
      replyRef.current.focus();
      return true;
    },
  }));

  return (
    <article
      ref={articleRef}
      // Focusable by script only: it takes Home's keys while the queue is not on screen.
      tabIndex={-1}
      aria-label={title}
      data-slot="home-preview"
      data-kind={item.kind}
      className={cn(PANE_CLASS_NAME, "outline-none")}
    >
      <PaneHeader
        title={title}
        project={props.project}
        branch={thread.branch}
        onBack={props.onBack}
        trailing={
          <>
            {pill ? (
              <ThreadStatusPillBadge pill={pill} variant="chip" live={false} />
            ) : item.kind === "queue-paused" ? (
              <Badge variant="warning" size="sm">
                Queue paused
              </Badge>
            ) : null}
            <span className="tabular-nums" title={formatAbsoluteTimeLabel(activityAt) || undefined}>
              {formatRelativeTimeLabel(activityAt, now)}
            </span>
          </>
        }
      />
      <PaneBody>
        {item.kind === "approval" ? (
          <ApprovalBody decision={decision} state={inline.approvalState} />
        ) : null}
        {item.kind === "question" ? (
          <QuestionBody threadId={thread.id} decision={decision} cwd={cwd} />
        ) : null}
        {item.kind === "plan" && decision.plan ? (
          <ProposedPlanCard
            planMarkdown={decision.plan.planMarkdown}
            cwd={cwd}
            workspaceRoot={cwd}
          />
        ) : null}
        {item.kind === "queue-paused" ? <QueuePausedBody threadId={thread.id} /> : null}
        {item.kind === "failed" && thread.error ? (
          <Block label="Error">
            <MonoBlock tone="error">{thread.error}</MonoBlock>
          </Block>
        ) : null}
        {item.kind === "running" ? <RunningBody thread={thread} tail={tail} now={now} /> : null}
        {item.kind === "plan" ? null : (
          <LastExchange
            tail={tail}
            peek={props.peek}
            cwd={cwd}
            replyLabel={REPLY_LABEL_BY_KIND[item.kind]}
          />
        )}
      </PaneBody>
      <footer className="flex flex-col gap-2.5 border-t border-border px-4 py-3">
        {openApproval ? (
          <HomeApprovalActions
            approval={openApproval}
            enabled={inline.enabled}
            onRespond={inline.respondToApproval}
          />
        ) : null}
        {item.kind === "plan" && decision.plan ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" disabled={!inline.enabled} onClick={() => inline.implementPlan()}>
              Implement
              <Kbd className="bg-primary-foreground/15 text-primary-foreground">↵</Kbd>
            </Button>
          </div>
        ) : null}
        {item.kind === "queue-paused" && queuePaused ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" disabled={!inline.enabled} onClick={inline.resumeQueue}>
              <PlayIcon />
              Resume queue
            </Button>
          </div>
        ) : null}
        {replyBox ? (
          <HomeReplyBox
            threadId={thread.id}
            label={replyBox.label}
            placeholder={replyBox.placeholder}
            enabled={inline.enabled}
            busy={inline.busy}
            inputRef={replyRef}
            onSubmit={(text) =>
              inline.reply(text, {
                interactionMode: replyBox.interactionMode,
                intent: replyBox.intent,
              })
            }
          />
        ) : null}
        <ThreadActions
          item={item}
          actions={props.actions}
          snoozeMenu={props.snoozeMenu}
          openIsPrimary={!hasOwnAction}
        />
        <ThreadMeta thread={thread} peek={props.peek} />
      </footer>
      {inline.dialog}
    </article>
  );
}

const PHASE_STATE_CLASS: Record<HomeWorkflowRow["meta"]["phases"][number]["state"], string> = {
  completed: "bg-success",
  active: "bg-info",
  error: "bg-destructive",
  pending: "bg-border",
};

function WorkflowPreview(props: {
  readonly item: HomeWorkflowItem;
  readonly project: Project | undefined;
  readonly actions: HomePreviewActions;
  readonly holdsFocus?: boolean | undefined;
  readonly onBack?: (() => void) | undefined;
}) {
  const workflow = props.item.workflow;
  const now = useNowMinute();
  const articleRef = useHoldFocus(props.holdsFocus);
  return (
    <article
      ref={articleRef}
      tabIndex={-1}
      aria-label={workflow.title}
      data-slot="home-preview"
      data-kind="workflow"
      className={cn(PANE_CLASS_NAME, "outline-none")}
    >
      <PaneHeader
        title={workflow.title}
        project={props.project}
        onBack={props.onBack}
        trailing={
          <>
            <Badge variant="info" size="sm">
              {workflow.typeLabel} workflow
            </Badge>
            <span className="tabular-nums">
              {formatRelativeTimeLabel(workflow.activityAt, now)}
            </span>
          </>
        }
      />
      <PaneBody>
        <Block label="Phases">
          <ol className="flex flex-col gap-2">
            {workflow.meta.phases.map((phase) => (
              <li key={phase.id} data-phase-state={phase.state}>
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <span
                    aria-hidden="true"
                    className={cn("size-1.5 shrink-0 rounded-full", PHASE_STATE_CLASS[phase.state])}
                  />
                  {phase.label}
                  <span className="text-2xs font-normal text-muted-foreground">{phase.state}</span>
                </p>
                {phase.steps.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-0.5 pl-3.5">
                    {phase.steps.map((step, index) => (
                      <li
                        key={`${index}:${step.label}`}
                        className="flex items-center gap-2 text-2xs text-muted-foreground"
                      >
                        <span className="min-w-0 truncate">{step.label}</span>
                        <span className="ms-auto shrink-0 text-faint-foreground">{step.state}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </Block>
      </PaneBody>
      <footer className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3">
        <Button size="sm" onClick={() => props.actions.openWorkflow(workflow)}>
          Open workflow
          <Kbd className="bg-primary-foreground/15 text-primary-foreground">O</Kbd>
          <ArrowRightIcon />
        </Button>
      </footer>
    </article>
  );
}

/**
 * The selected queue item's context and actions. Loaded after the first paint: it brings
 * the markdown renderer, which Home's startup does not need.
 */
export default function HomePreviewPane(props: HomePreviewPaneProps) {
  return props.item.type === "thread" ? (
    <ThreadPreview
      // Per-thread state (menus, fetched tails) must not carry over to the next item.
      key={props.item.id}
      item={props.item}
      project={props.project}
      peek={props.peek}
      actions={props.actions}
      handleRef={props.handleRef}
      onKeysChange={props.onKeysChange}
      holdsFocus={props.holdsFocus}
      snoozeMenu={props.snoozeMenu}
      onBack={props.onBack}
    />
  ) : (
    <WorkflowPreview
      key={props.item.id}
      item={props.item}
      project={props.project}
      actions={props.actions}
      holdsFocus={props.holdsFocus}
      onBack={props.onBack}
    />
  );
}
