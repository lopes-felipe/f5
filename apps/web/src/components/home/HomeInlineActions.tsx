import type { ProviderApprovalDecision, ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpIcon } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useSettings } from "../../hooks/useSettings";
import { fetchAndSyncThreadDetail } from "../../lib/orchestrationReactQuery";
import { respondToApproval } from "../../lib/respondToApproval";
import { sendThreadReply, type ThreadReplyInput } from "../../lib/sendThreadReply";
import { readNativeApi } from "../../nativeApi";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { loadPendingApprovalRequestIds } from "../../notificationCenter/inlineApproval";
import { buildPlanImplementationPrompt } from "../../proposedPlan";
import type { PendingApproval } from "../../session-logic";
import type { Project, Thread } from "../../types";
import { useServerMutationsAvailable } from "../../wsConnectionState";
import {
  approvalOptionVariant,
  canApproveRequest,
  resolveApprovalOptions,
} from "../chat/ComposerPendingApprovalActions";
import { useChatViewBranchDriftGuard } from "../ChatViewBranchDriftGuard";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import type { HomeThreadDecision } from "./homeItems";

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "An unexpected error occurred.";
}

function approvalOptionsOf(approval: PendingApproval) {
  return resolveApprovalOptions({
    requestKind: approval.requestKind,
    requestedPermissions: approval.requestedPermissions,
    approvalOptions: approval.approvalOptions,
    suppressAlwaysAllowRule: approval.presentation?.suppressAlwaysAllowRule,
  });
}

/**
 * What Enter sends for an approval: a plain "approve once", and only when the request
 * offers one, can be granted, and the provider did not ask for No to be the default.
 */
export function approvalEnterDecision(approval: PendingApproval): ProviderApprovalDecision | null {
  if (approval.presentation?.defaultToNo || !canApproveRequest(approval)) return null;
  return approvalOptionsOf(approval).some((option) => option.decision === "accept")
    ? "accept"
    : null;
}

/** What D sends: the request's own decline, when it has one. */
export function approvalDenyDecision(approval: PendingApproval): ProviderApprovalDecision | null {
  return approvalOptionsOf(approval).some((option) => option.decision === "decline")
    ? "decline"
    : null;
}

export type HomeApprovalState = "open" | "sent" | "answered";

export interface HomeInlineActions {
  /** False while an action is in flight or the server cannot take one. */
  readonly enabled: boolean;
  /** The oldest open approval, as the store has it. */
  readonly approval: PendingApproval | null;
  /**
   * `open` while the shown approval can be answered. After that its closing event is on
   * the way: `sent` when the decision left from here, `answered` when the server said
   * the request was already closed.
   */
  readonly approvalState: HomeApprovalState;
  readonly respondToApproval: (
    approval: PendingApproval,
    decision: ProviderApprovalDecision,
  ) => void;
  /** Starts a turn that implements the plan shown; false when there is none to act on. */
  readonly implementPlan: () => boolean;
  /** Resolves true once the server took the message. */
  readonly reply: (
    text: string,
    options?: Pick<ThreadReplyInput, "interactionMode" | "intent">,
  ) => Promise<boolean>;
  readonly resumeQueue: () => void;
  /** Mounted by the preview: the branch question a send may have to ask first. */
  readonly dialog: ReactNode;
}

/**
 * The actions Home can take on a thread without opening it. Each one is bound to what the
 * preview shows (the request id, the plan id), runs one at a time, and is refused while the
 * server is unreachable.
 */
export function useHomeInlineActions(input: {
  readonly thread: Thread;
  readonly project: Project | undefined;
  readonly decision: HomeThreadDecision;
  readonly cwd: string | undefined;
  /** Returns focus to the queue when the control that held it went away. */
  readonly focusQueue: () => void;
}): HomeInlineActions {
  const { thread, decision, focusQueue } = input;
  const queryClient = useQueryClient();
  const available = useServerMutationsAvailable();
  const streaming = useSettings((settings) => settings.enableAssistantStreaming, thread.projectId);
  const { guardBranchDrift, branchDriftDialog } = useChatViewBranchDriftGuard(thread.id);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Requests closed from here, in memory only: the store catches up through its events.
  const [closedRequests, setClosedRequests] = useState<
    ReadonlyMap<string, Exclude<HomeApprovalState, "open">>
  >(() => new Map());
  // A thread without a project has a folder but no repository to ask about its branch.
  const gitCwd = isScratchProject(input.project) ? undefined : input.cwd;

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    // The ref closes the gap between two key presses in one frame.
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    try {
      return await action();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  // A button that was clicked may be gone once its action is done.
  useEffect(() => {
    if (!busy && document.activeElement === document.body) focusQueue();
  }, [busy, closedRequests, focusQueue]);

  const markClosed = useCallback((requestId: string, state: Exclude<HomeApprovalState, "open">) => {
    setClosedRequests((current) => new Map(current).set(requestId, state));
  }, []);

  const respond = useCallback(
    (approval: PendingApproval, approvalDecision: ProviderApprovalDecision) => {
      if (!available) return;
      void run(async () => {
        // The store can lag behind the server; never answer a request that is already closed.
        const pending = await loadPendingApprovalRequestIds(thread.id);
        if (pending && !pending.has(approval.requestId)) {
          markClosed(approval.requestId, "answered");
          toastManager.add({ type: "info", title: "This request was already answered." });
          void fetchAndSyncThreadDetail(queryClient, thread.id, { force: true }).catch(() => {});
          return;
        }
        try {
          await respondToApproval({
            threadId: thread.id,
            requestId: approval.requestId,
            decision: approvalDecision,
          });
          markClosed(approval.requestId, "sent");
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not send the decision",
            description: errorDetail(error),
          });
        }
      });
    },
    [available, markClosed, queryClient, run, thread.id],
  );

  const send = useCallback(
    async (
      text: string,
      options: Pick<ThreadReplyInput, "interactionMode" | "intent" | "sourceProposedPlanId"> = {},
    ): Promise<boolean> => {
      if (!available) return false;
      const sent = await run(async () => {
        if (thread.branch && gitCwd) {
          const proceed = await guardBranchDrift({
            cwd: gitCwd,
            threadId: thread.id,
            recordedBranch: thread.branch,
            worktreePath: thread.worktreePath,
          });
          if (!proceed) return false;
        }
        try {
          const outcome = await sendThreadReply({
            thread,
            text,
            assistantDeliveryMode: streaming ? "streaming" : "buffered",
            ...options,
          });
          if (outcome === "queued") {
            toastManager.add({ type: "success", title: "Added to the thread's queue." });
          }
          return true;
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not send the message",
            description: errorDetail(error),
          });
          return false;
        }
      });
      return sent === true;
    },
    [available, gitCwd, guardBranchDrift, run, streaming, thread],
  );

  const plan = decision.plan;
  const implementPlan = useCallback(() => {
    if (!plan || !available || busyRef.current) return false;
    void send(buildPlanImplementationPrompt(plan.planMarkdown), {
      interactionMode: "default",
      sourceProposedPlanId: plan.id,
    });
    return true;
  }, [available, plan, send]);

  const resumeQueue = useCallback(() => {
    if (!available) return;
    void run(async () => {
      const api = readNativeApi();
      if (!api) return;
      try {
        const snapshot = await api.nextTurnQueue.list({ threadId: thread.id });
        if (snapshot.unresolvedDelivery) {
          toastManager.add({
            type: "info",
            title: "A queued message could not be delivered",
            description: "Open the thread to retry or discard it before resuming the queue.",
          });
          return;
        }
        const next = snapshot.paused
          ? await api.nextTurnQueue.setPaused({
              threadId: thread.id,
              paused: false,
              expectedRevision: snapshot.revision,
            })
          : snapshot;
        const store = useNextTurnQueueStore.getState();
        store.applySnapshot(next);
        // Home lists paused queues from the summary, which the server also pushes.
        store.applySummary(await api.nextTurnQueue.summary());
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not resume the queue",
          description: errorDetail(error),
        });
      }
    });
  }, [available, run, thread.id]);

  const approval = decision.approvals[0] ?? null;
  return {
    enabled: available && !busy,
    approval,
    approvalState: (approval && closedRequests.get(approval.requestId)) ?? "open",
    respondToApproval: respond,
    implementPlan,
    reply: send,
    resumeQueue,
    dialog: branchDriftDialog,
  };
}

/** One button per choice the request offers, as the thread's composer shows them. */
export function HomeApprovalActions(props: {
  readonly approval: PendingApproval;
  readonly enabled: boolean;
  readonly onRespond: (approval: PendingApproval, decision: ProviderApprovalDecision) => void;
}) {
  const { approval } = props;
  const options = approvalOptionsOf(approval);
  const enterDecision = approvalEnterDecision(approval);
  const denyDecision = approvalDenyDecision(approval);
  const canApprove = canApproveRequest(approval);
  return (
    <div
      role="group"
      aria-label="Approval"
      data-request-id={approval.requestId}
      className="flex flex-wrap items-center gap-1.5"
    >
      {options.map((option) => {
        const variant = approvalOptionVariant({
          decision: option.decision,
          providerOptions: Boolean(approval.approvalOptions?.length),
          defaultToNo: approval.presentation?.defaultToNo ?? false,
        });
        return (
          <Button
            key={option.decision}
            size="sm"
            variant={variant}
            disabled={!props.enabled || (option.decision.startsWith("accept") && !canApprove)}
            onClick={() => props.onRespond(approval, option.decision)}
          >
            {option.label}
            {option.decision === enterDecision ? (
              <Kbd
                className={
                  variant === "default"
                    ? "bg-primary-foreground/15 text-primary-foreground"
                    : undefined
                }
              >
                ↵
              </Kbd>
            ) : option.decision === denyDecision ? (
              <Kbd>D</Kbd>
            ) : null}
          </Button>
        );
      })}
      {options
        .filter((option) => option.warning)
        .map((option) => (
          <p
            key={`warning:${option.decision}`}
            role="note"
            className="w-full text-xs text-muted-foreground"
          >
            {option.label}: {option.warning}
          </p>
        ))}
    </div>
  );
}

/** Unsent replies, per thread, for as long as the page lives: selecting another row keeps them. */
const replyDrafts = new Map<ThreadId, string>();

/** A one-line box that sends a message to the thread; the full composer stays in the thread. */
export function HomeReplyBox(props: {
  readonly threadId: ThreadId;
  /** Names the box and its button, e.g. "Reply" or "Queue message". */
  readonly label: string;
  readonly placeholder: string;
  readonly enabled: boolean;
  readonly inputRef: Ref<HTMLTextAreaElement>;
  readonly onSubmit: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(() => replyDrafts.get(props.threadId) ?? "");
  const update = (next: string) => {
    setText(next);
    if (next) replyDrafts.set(props.threadId, next);
    else replyDrafts.delete(props.threadId);
  };
  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || !props.enabled) return;
    // A failed send keeps the text.
    if (await props.onSubmit(trimmed)) update("");
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };
  return (
    <form
      onSubmit={onSubmit}
      aria-label={props.label}
      data-slot="home-reply"
      className="flex items-end gap-1 rounded-lg border border-border bg-background p-1 transition-colors duration-(--duration-fast) focus-within:border-ring/60"
    >
      <textarea
        ref={props.inputRef}
        aria-label={props.label}
        placeholder={props.placeholder}
        value={text}
        rows={1}
        onChange={(event) => update(event.target.value)}
        onKeyDown={onKeyDown}
        className="field-sizing-content block max-h-32 min-h-7 min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={!props.enabled || text.trim().length === 0}
      >
        {props.label}
        <ArrowUpIcon />
      </Button>
    </form>
  );
}
