import { PendingUserInput, type OrchestrationEvent } from "@t3tools/contracts";
import { Schema } from "effect";

/** Apply persisted events, including legacy request activities, independently of activity retention. */
export function projectPendingUserInputs(
  current: ReadonlyArray<PendingUserInput>,
  event: OrchestrationEvent,
): ReadonlyArray<PendingUserInput> {
  if (
    event.type === "thread.session-set" &&
    event.payload.session.activeTurnId === null &&
    event.payload.session.status !== "starting"
  )
    return current.filter((input) => input.responseMode === "message");
  if (event.type === "thread.user-input-resolved")
    return current.filter((input) => input.requestId !== event.payload.requestId);
  if (event.type !== "thread.activity-appended") return current;
  const activity = event.payload.activity;
  const payload = activity.payload as Record<string, unknown> | null;
  if (!payload || typeof payload.requestId !== "string") return current;
  if (activity.kind === "user-input.resolved")
    return current.filter((input) => input.requestId !== payload.requestId);
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
