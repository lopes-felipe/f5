import {
  isComputerUserActiveDetail,
  type ComputerAutomationError,
  type ComputerAutomationOperation,
  type ComputerAutomationRequest,
} from "@t3tools/contracts";

/** Native admission and broker handoff waits use the same retryable self-wait reasons. */
export const CHROME_OWN_CALL_RUNNING_MESSAGE =
  "A Chrome call from this thread is still running; retry once it finishes.";
export const CHROME_OWN_STOPPING_MESSAGE =
  "Chrome control from this thread is stopping; retry once it has stopped.";
/**
 * Chrome validation refusals that clear once another thread's native control ends. The
 * backend's Chrome admission waits through them (bounded) before telling the agent.
 */
export const CHROME_WAITING_FOR_NATIVE_MESSAGE =
  "Another agent is controlling the computer; retry this Chrome call in a few seconds.";
export const CHROME_NATIVE_WORK_FINISHING_MESSAGE =
  "Native computer input is still finishing; retry the Chrome call shortly.";
/** Shared Claude in Chrome runs one call at a time across every session holding it. */
export const CHROME_WAITING_FOR_CHROME_CALL_MESSAGE =
  "Another agent's Chrome call is running; retry this Chrome call in a few seconds.";
/** Another profile's Claude session is starting Chrome; its setup lands within seconds. */
export const CHROME_WAITING_FOR_PEER_LAUNCH_MESSAGE =
  "Another agent is starting Chrome; retry this Chrome call in a few seconds.";
export function isChromeNativeWait(message: string): boolean {
  return (
    message === CHROME_WAITING_FOR_NATIVE_MESSAGE ||
    message === CHROME_NATIVE_WORK_FINISHING_MESSAGE ||
    message === CHROME_WAITING_FOR_CHROME_CALL_MESSAGE ||
    message === CHROME_WAITING_FOR_PEER_LAUNCH_MESSAGE
  );
}

const OBSERVATIONS: ReadonlySet<ComputerAutomationOperation> = new Set([
  "status",
  "listApps",
  "resolveApps",
  "screenshot",
  "zoom",
  "inspect",
]);
export function isComputerMutation(op: ComputerAutomationOperation | "batch"): boolean {
  return op === "batch" || !OBSERVATIONS.has(op);
}
type BusyError = Extract<ComputerAutomationError, { _tag: "Busy" }>;
/** Names the holder whenever main or the broker attributed it. */
export function describeComputerBusy(error: BusyError): string {
  if (error.reason === "observation-backlog")
    return "Observation backlog is full; wait before requesting another screenshot or inspection.";
  if (error.holder === "other-profile") {
    const who = error.holderProfileName
      ? `an agent in profile "${error.holderProfileName}"`
      : "an agent in another F5 profile";
    const doing =
      error.activity === "chrome-call"
        ? "is using Chrome"
        : error.activity === "chrome-session"
          ? "holds a Chrome session"
          : error.activity === "computer"
            ? "is controlling the computer"
            : error.resource === "chrome"
              ? "holds Chrome control"
              : error.resource === "computer"
                ? "holds computer control"
                : "holds computer or Chrome control";
    return `Busy: ${who} ${doing}. Wait for it with computer_wait_for_target; ask the user only if that times out.`;
  }
  const what =
    error.resource === "chrome"
      ? "Chrome"
      : error.resource === "computer"
        ? "Computer control"
        : "Computer or Chrome control";
  if (!error.holderThreadId && !error.threadTitle)
    return `Busy: ${what} is in use in this F5 profile; wait and retry.`;
  const who = error.threadTitle ? `thread "${error.threadTitle}"` : "another thread";
  const state =
    error.holderIdle === true ? " (idle)" : error.holderIdle === false ? " (working)" : "";
  return `Busy: ${what} is held by ${who}${state}. F5 releases idle holders automatically; if it's working, wait or ask the user to stop it.`;
}
type InterruptedError = Extract<ComputerAutomationError, { _tag: "Interrupted" }>;
/** Matches the agent contract: "On explicit Interrupted, stop and ask the user". */
export const COMPUTER_INTERRUPTED_STOP = "Stop and ask the user before continuing.";
const INTERRUPTED_REASON: Record<InterruptedError["cause"], string> = {
  paused:
    "computer control for this thread is paused; the user must press Resume in F5 (check the app first if it says Needs recovery).",
  "user-input": "the user took the mouse or keyboard.",
  "kill-switch": "the user stopped computer control.",
  "access-changed": "app access changed.",
  "policy-changed": "computer-use settings changed.",
  // Helper interruptions it cannot attribute, including some user stops, arrive as this.
  "permit-expired": "control was withdrawn before the action ran.",
  "turn-ended": "this turn ended; no further computer actions run in it.",
};
/** Names the cause: a bare "Interrupted" reads as a user stop even when F5 paused the thread. */
function describeComputerInterrupted(error: InterruptedError): string {
  const reason = INTERRUPTED_REASON[error.cause];
  return error.cause === "turn-ended"
    ? `Interrupted (${error.cause}): ${reason}`
    : `Interrupted (${error.cause}): ${reason} ${COMPUTER_INTERRUPTED_STOP}`;
}
/** A typed computer-control failure whose message is the guidance agents see as tool text. */
export class ComputerControlError extends Error {
  constructor(readonly error: ComputerAutomationError) {
    super(
      error._tag === "OutcomeUnknown"
        ? "The action may or may not have run; take a screenshot before retrying."
        : error._tag === "Busy"
          ? describeComputerBusy(error)
          : error._tag === "StaleElement"
            ? `StaleElement${error.reason ? ` (${error.reason})` : ""}: call computer_inspect again.`
            : error._tag === "Execution"
              ? error.message
              : error._tag === "ForegroundRequired"
                ? `ForegroundRequired (${error.reason}): call computer_request_foreground with a short reason.`
                : error._tag === "TargetBlocked" && error.kind === "user-active"
                  ? `TargetBlocked user-active${isComputerUserActiveDetail(error.detail) ? ` (${error.detail})` : ""}: call computer_wait_for_target, then observe again before acting; take a screenshot before coordinates.`
                  : error._tag === "TargetBlocked" && error.kind === "shared-focus"
                    ? "TargetBlocked shared-focus: another agent acted in that app; press the field with computer_element_action (or use setValue), then type."
                    : error._tag === "TargetBlocked" && error.kind === "foreground-busy"
                      ? "TargetBlocked foreground-busy: another chat has the foreground; wait."
                      : error._tag === "TargetBlocked" && error.kind === "other-app"
                        ? "TargetBlocked other-app: the foreground was approved for a different app."
                        : error._tag === "Interrupted"
                          ? describeComputerInterrupted(error)
                          : error._tag,
    );
  }
}
export function computerError(cause: unknown): ComputerAutomationError {
  return cause instanceof ComputerControlError
    ? cause.error
    : {
        _tag: "Execution",
        message: cause instanceof Error ? cause.message : "Computer action failed.",
      };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
/** Transport retries must retain the complete envelope, including authorization and deadline. */
export function computerRequestPayload(
  request: Omit<ComputerAutomationRequest, "payloadHash">,
): string {
  return JSON.stringify(canonical(request));
}
