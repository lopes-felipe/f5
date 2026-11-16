import type { OrchestrationLatestTurnState } from "@t3tools/contracts";
import { useState } from "react";

export type ChatStatusOutcome =
  | "working"
  | "awaiting-approval"
  | "awaiting-input"
  | "completed"
  | "failed"
  | "interrupted"
  | "idle";

export function deriveChatStatusOutcome(input: {
  readonly isWorking: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasBlockingUserInput: boolean;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
}): ChatStatusOutcome {
  if (input.hasPendingApproval) return "awaiting-approval";
  if (input.hasBlockingUserInput) return "awaiting-input";
  if (input.isWorking || input.latestTurnState === "running") return "working";
  switch (input.latestTurnState) {
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    default:
      return "idle";
  }
}

const OUTCOME_MESSAGES: Record<Exclude<ChatStatusOutcome, "idle">, string> = {
  working: "Working",
  "awaiting-approval": "Waiting for your approval",
  "awaiting-input": "Waiting for your input",
  completed: "Response ready",
  failed: "Response failed",
  interrupted: "Response stopped",
};

const MAX_REMEMBERED_OUTCOMES = 32;

function isTerminalOutcome(outcome: ChatStatusOutcome): boolean {
  return outcome === "completed" || outcome === "failed" || outcome === "interrupted";
}

interface AnnouncerState {
  readonly threadId: string;
  readonly lastOutcome: ChatStatusOutcome;
  readonly lastAttentionRequestId: string | null;
  /** `turnId:outcome` terminal outcomes already announced in this thread. */
  readonly announcedTerminal: ReadonlyArray<string>;
  readonly message: string;
  /** Bumped per announcement so repeating the same text still changes the DOM. */
  readonly sequence: number;
}

function initialState(props: {
  threadId: string;
  turnId: string | null;
  outcome: ChatStatusOutcome;
  attentionRequestId?: string | null;
}): AnnouncerState {
  return {
    threadId: props.threadId,
    lastOutcome: props.outcome,
    lastAttentionRequestId: props.attentionRequestId ?? null,
    announcedTerminal: [`${props.turnId}:${props.outcome}`],
    message: "",
    sequence: 0,
  };
}

/**
 * One polite live region for coarse turn transitions. Opening a thread reads
 * nothing and streaming tokens never speak. Every entry into working or into
 * a wait for the user is announced, including each new approval or question
 * in the same turn. A turn's final outcome is announced once, so it is not
 * replayed when the same turn is reported again.
 */
export function ChatStatusAnnouncer(props: {
  threadId: string;
  turnId: string | null;
  outcome: ChatStatusOutcome;
  /** The pending approval or question the user is asked about, if any. */
  attentionRequestId?: string | null;
}) {
  const [state, setState] = useState<AnnouncerState>(() => initialState(props));
  const attentionRequestId = props.attentionRequestId ?? null;

  if (state.threadId !== props.threadId) {
    setState(initialState(props));
  } else if (
    state.lastOutcome !== props.outcome ||
    (state.lastAttentionRequestId !== attentionRequestId &&
      (props.outcome === "awaiting-approval" || props.outcome === "awaiting-input"))
  ) {
    const next = {
      ...state,
      lastOutcome: props.outcome,
      lastAttentionRequestId: attentionRequestId,
    };
    if (props.outcome === "idle") {
      setState(next);
    } else if (isTerminalOutcome(props.outcome)) {
      const key = `${props.turnId}:${props.outcome}`;
      setState(
        state.announcedTerminal.includes(key)
          ? // Already heard: clear quietly rather than leave a stale status.
            { ...next, message: "" }
          : {
              ...next,
              announcedTerminal: [...state.announcedTerminal, key].slice(-MAX_REMEMBERED_OUTCOMES),
              message: OUTCOME_MESSAGES[props.outcome],
              sequence: state.sequence + 1,
            },
      );
    } else {
      setState({ ...next, message: OUTCOME_MESSAGES[props.outcome], sequence: state.sequence + 1 });
    }
  }

  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {state.message}
      {state.message && state.sequence % 2 === 1 ? " " : ""}
    </div>
  );
}
