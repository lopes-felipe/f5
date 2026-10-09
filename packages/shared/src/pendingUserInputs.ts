import { PendingUserInput, type OrchestrationEvent } from "@t3tools/contracts";
import { Schema } from "effect";

/** Value-free activity recorded once the provider transport accepted a private answer. */
export const ELICITATION_SUBMITTED_ACTIVITY_KIND = "elicitation.submitted";

/**
 * Blocking semantics, independent of the answer transport: message-mode
 * questions and native requests marked non-blocking never hold a turn open.
 */
export function isBlockingUserInput(
  input: Pick<PendingUserInput, "responseMode" | "blocking"> &
    Partial<Pick<PendingUserInput, "receipt">>,
): boolean {
  // An indeterminate elicitation belongs to a session that is gone.
  if (input.receipt === "indeterminate") return false;
  return input.blocking !== false && input.responseMode !== "message";
}

/**
 * Whether a pending input should stop F5 from resuming a turn on its own
 * (restart continuation, usage-limit resume). Message-mode questions still
 * wait for the user; only explicitly non-blocking and orphaned inputs do not.
 */
export function holdsAutomaticResume(
  input: Pick<PendingUserInput, "blocking"> & Partial<Pick<PendingUserInput, "receipt">>,
): boolean {
  return input.receipt !== "indeterminate" && input.blocking !== false;
}

/** Apply persisted events, including legacy request activities, independently of activity retention. */
export function projectPendingUserInputs(
  current: ReadonlyArray<PendingUserInput>,
  event: OrchestrationEvent,
): ReadonlyArray<PendingUserInput> {
  if (event.type === "thread.reverted") {
    const retained = new Set(event.payload.retainedTurnIds ?? []);
    return current.filter((input) => input.turnId === null || retained.has(input.turnId));
  }
  if (
    event.type === "thread.session-set" &&
    event.payload.session.activeTurnId === null &&
    event.payload.session.status !== "starting"
  ) {
    // A non-blocking native request outlives its turn but not its process.
    const sessionEnded =
      event.payload.session.status === "stopped" || event.payload.session.status === "error";
    return current.flatMap((input) => {
      // An answer that left F5 without a native completion cannot be known
      // to have arrived: it stays visible as indeterminate until dismissed.
      if (input.elicitation && (input.receipt === "submitted" || input.receipt === "indeterminate"))
        return sessionEnded ? [{ ...input, receipt: "indeterminate" as const }] : [input];
      return input.responseMode === "message" || (!sessionEnded && !isBlockingUserInput(input))
        ? [input]
        : [];
    });
  }
  if (event.type === "thread.user-input-resolved")
    return current.filter((input) => input.requestId !== event.payload.requestId);
  if (event.type !== "thread.activity-appended") return current;
  const activity = event.payload.activity;
  const payload = activity.payload as Record<string, unknown> | null;
  if (!payload || typeof payload.requestId !== "string") return current;
  if (activity.kind === ELICITATION_SUBMITTED_ACTIVITY_KIND)
    return current.map((input) =>
      input.requestId === payload.requestId && input.elicitation && input.receipt === undefined
        ? { ...input, receipt: "submitted" as const }
        : input,
    );
  if (activity.kind === "user-input.resolved") {
    const receipt = payload.receipt;
    return current.flatMap((input) => {
      if (input.requestId !== payload.requestId) return [input];
      if (receipt === "indeterminate") return [{ ...input, receipt: "indeterminate" as const }];
      // Only an explicit receipt closes an indeterminate request; a turn-end
      // dismissal must not hide an answer whose delivery is unknown.
      if (input.receipt === "indeterminate" && receipt !== "resolved" && receipt !== "cancelled")
        return [input];
      return [];
    });
  }
  if (
    activity.kind !== "user-input.requested" ||
    current.some((input) => input.requestId === payload.requestId)
  )
    return current;
  const decoded = Schema.decodeUnknownOption(PendingUserInput)({
    ...payload,
    turnId: activity.turnId,
    createdAt: activity.createdAt,
  });
  return decoded._tag === "Some" ? [...current, decoded.value] : current;
}
