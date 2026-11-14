import type { OrchestrationThreadPeek, ProjectId } from "@t3tools/contracts";

import { QUEUE_PAUSED_REASON_TAG, resolveAttentionReasonTag } from "../../lib/attentionReason";
import type { HomeQueueItem, HomeQueueWorkflow, HomeThreadItemKind } from "../../lib/homeQueue";
import { proposedPlanTitle } from "../../proposedPlan";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
  formatDuration,
  hasActionableProposedPlan,
  type LatestProposedPlanState,
  type PendingApproval,
  type PendingUserInput,
} from "../../session-logic";
import type { ThreadSummary } from "../../threadSelectors";
import type { Thread } from "../../types";
import { firstPendingQuestion, stripMarkdownToPlainText } from "../sidebar/sidebarPeek";
import type { SidebarWorkflowEntry, SidebarWorkflowMeta } from "../sidebar/sidebarLists";

/** An active workflow as a Home row: it opens the workflow page. */
export interface HomeWorkflowRow extends HomeQueueWorkflow {
  readonly entry: SidebarWorkflowEntry;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly typeLabel: string;
  readonly meta: SidebarWorkflowMeta;
}

export type HomeItem = HomeQueueItem<ThreadSummary, HomeWorkflowRow>;
export type HomeThreadItem = Extract<HomeItem, { type: "thread" }>;
export type HomeWorkflowItem = Extract<HomeItem, { type: "workflow" }>;

/** The row chip's label. */
export const HOME_KIND_LABELS: Record<HomeThreadItemKind, string> = {
  approval: "Approval",
  question: "Question",
  plan: "Plan",
  "queue-paused": "Paused",
  failed: "Failed",
  completed: "Done",
  running: "Running",
  pinned: "Pinned",
};

/** What a thread waits on, read from the store: the same inputs its status is derived from. */
export interface HomeThreadDecision {
  /** Open approval requests, oldest first. */
  readonly approvals: ReadonlyArray<PendingApproval>;
  /** Open questions, oldest first. */
  readonly userInputs: ReadonlyArray<PendingUserInput>;
  /** The plan waiting for a decision, if any. */
  readonly plan: LatestProposedPlanState | null;
}

/**
 * The thread's open questions: the server's projection when it lists any, else the
 * activities. A thread is in the queue as a question because its activities hold one
 * (`resolveThreadStatus`), so an empty projection must not leave that row without its
 * question.
 */
export function pendingUserInputsOf(
  thread: Pick<Thread, "activities" | "pendingUserInputs">,
): ReadonlyArray<PendingUserInput> {
  return thread.pendingUserInputs && thread.pendingUserInputs.length > 0
    ? thread.pendingUserInputs.map((input) => ({ ...input }))
    : derivePendingUserInputs(thread.activities);
}

/**
 * Why a thread cannot be settled now, or null when it can. The server refuses these
 * (`thread.settle` in the decider), so Home does not offer them.
 */
export function homeSettleBlocker(input: {
  readonly kind: HomeThreadItemKind;
  readonly pinned: boolean;
}): string | null {
  if (input.pinned) return "Unpin the thread to settle it";
  switch (input.kind) {
    case "running":
      return "A running thread cannot be settled";
    case "question":
      return "Answer the question to settle the thread";
    case "approval":
      return "Answer the approval to settle the thread";
    default:
      return null;
  }
}

export function deriveHomeThreadDecision(
  thread: Pick<Thread, "activities" | "pendingUserInputs" | "proposedPlans" | "latestTurn">,
): HomeThreadDecision {
  const plan = findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null);
  return {
    approvals: derivePendingApprovals(thread.activities),
    userInputs: pendingUserInputsOf(thread),
    plan: plan && hasActionableProposedPlan(plan) ? plan : null,
  };
}

const APPROVAL_HEADLINES: Record<PendingApproval["requestKind"], string> = {
  command: "Agent wants to run",
  "file-read": "Agent wants to read",
  "file-change": "Agent wants to change",
  permission: "Agent asks for permissions",
  "mcp-elicitation": "An MCP app asks for input",
  unknown: "Agent asks for approval",
};

/** The label above an approval's detail, e.g. "Agent wants to run". */
export function approvalHeadline(approval: Pick<PendingApproval, "requestKind">): string {
  return APPROVAL_HEADLINES[approval.requestKind];
}

/** The first non-empty line of a thread's error, or null. */
export function firstErrorLine(error: string | null | undefined): string | null {
  return (
    error
      ?.split("\n")
      .find((line) => line.trim())
      ?.trim() ?? null
  );
}

/** "3 files +12 −4", or null without a diff. */
export function formatPeekDiff(diff: OrchestrationThreadPeek["latestTurnDiff"]): string | null {
  if (!diff) return null;
  return `${diff.files} ${diff.files === 1 ? "file" : "files"} +${diff.additions} −${diff.deletions}`;
}

/** How long the latest turn has been running, e.g. "14m", or null when unknown. */
export function runningTurnElapsed(
  latestTurn: Pick<NonNullable<Thread["latestTurn"]>, "startedAt" | "requestedAt"> | null,
  now: number,
): string | null {
  const startedAt = Date.parse(latestTurn?.startedAt ?? latestTurn?.requestedAt ?? "");
  if (!Number.isFinite(startedAt)) return null;
  // Whole minutes past the first: a row is not a stopwatch.
  const elapsed = Math.max(0, now - startedAt);
  return formatDuration(elapsed >= 60_000 ? elapsed - (elapsed % 60_000) : elapsed);
}

/**
 * A queue row's second line: what the agent asks for a decision, what it produced for a
 * review, what it is working on while running. Null when there is nothing to add yet.
 */
export function homeRowSummary(input: {
  readonly kind: HomeThreadItemKind;
  readonly thread: Pick<
    Thread,
    | "activities"
    | "pendingUserInputs"
    | "proposedPlans"
    | "latestTurn"
    | "error"
    | "lastInteractionAt"
  >;
  readonly peek: OrchestrationThreadPeek | undefined;
  readonly now: number;
}): string | null {
  const { kind, thread, peek } = input;
  const reply = peek?.lastAssistantText ? stripMarkdownToPlainText(peek.lastAssistantText) : null;
  switch (kind) {
    case "approval": {
      const approvals = derivePendingApprovals(thread.activities);
      const first = approvals[0];
      if (!first) return "Waiting for approval";
      const summary = first.detail?.trim() || approvalHeadline(first);
      return approvals.length > 1 ? `${summary} (+${approvals.length - 1} more)` : summary;
    }
    case "question":
      return firstPendingQuestion(pendingUserInputsOf(thread)) ?? "Waiting for your answer";
    case "plan": {
      const { plan } = deriveHomeThreadDecision(thread);
      const title = plan ? proposedPlanTitle(plan.planMarkdown) : null;
      const stale = resolveAttentionReasonTag(
        "plan-ready",
        thread.lastInteractionAt,
        new Date(input.now),
      );
      return [title ?? "Plan ready", stale].filter(Boolean).join(" · ");
    }
    case "queue-paused":
      return QUEUE_PAUSED_REASON_TAG;
    case "failed":
      return firstErrorLine(thread.error) ?? reply ?? "The last turn failed";
    case "completed":
    case "pinned":
      return (
        [reply, formatPeekDiff(peek?.latestTurnDiff ?? null)].filter(Boolean).join(" · ") || null
      );
    case "running": {
      const elapsed = runningTurnElapsed(thread.latestTurn, input.now);
      return (
        [peek?.lastUserText, elapsed ? `for ${elapsed}` : null].filter(Boolean).join(" · ") || null
      );
    }
  }
}
