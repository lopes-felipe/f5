import type { OrchestrationLatestTurnState } from "@t3tools/contracts";
import { useState } from "react";

import { useLiveRegionMessage } from "../../hooks/useLiveRegionMessage";

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

interface OutcomeTracker {
  readonly threadId: string;
  readonly lastOutcome: ChatStatusOutcome;
  readonly lastAttentionRequestId: string | null;
  /** `turnId:outcome` terminal outcomes already announced in this thread. */
  readonly announcedTerminal: ReadonlyArray<string>;
}

function initialTracker(props: {
  threadId: string;
  turnId: string | null;
  outcome: ChatStatusOutcome;
  attentionRequestId?: string | null;
}): OutcomeTracker {
  return {
    threadId: props.threadId,
    lastOutcome: props.outcome,
    lastAttentionRequestId: props.attentionRequestId ?? null,
    announcedTerminal: [`${props.turnId}:${props.outcome}`],
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
  const [tracker, setTracker] = useState<OutcomeTracker>(() => initialTracker(props));
  const liveRegion = useLiveRegionMessage(props.threadId);
  const attentionRequestId = props.attentionRequestId ?? null;

  if (tracker.threadId !== props.threadId) {
    setTracker(initialTracker(props));
    liveRegion.reset(props.threadId);
  } else if (
    tracker.lastOutcome !== props.outcome ||
    (tracker.lastAttentionRequestId !== attentionRequestId &&
      (props.outcome === "awaiting-approval" || props.outcome === "awaiting-input"))
  ) {
    const next: OutcomeTracker = {
      ...tracker,
      lastOutcome: props.outcome,
      lastAttentionRequestId: attentionRequestId,
    };
    if (props.outcome === "idle") {
      setTracker(next);
      liveRegion.clear();
    } else if (isTerminalOutcome(props.outcome)) {
      const key = `${props.turnId}:${props.outcome}`;
      if (tracker.announcedTerminal.includes(key)) {
        // Already heard: clear quietly rather than leave a stale status.
        setTracker(next);
        liveRegion.clear();
      } else {
        setTracker({
          ...next,
          announcedTerminal: [...tracker.announcedTerminal, key].slice(-MAX_REMEMBERED_OUTCOMES),
        });
        liveRegion.announce(OUTCOME_MESSAGES[props.outcome]);
      }
    } else {
      setTracker(next);
      liveRegion.announce(OUTCOME_MESSAGES[props.outcome]);
    }
  }

  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {liveRegion.renderedMessage}
    </div>
  );
}
