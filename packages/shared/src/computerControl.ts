import type {
  ComputerAutomationError,
  ComputerAutomationOperation,
  ComputerAutomationRequest,
} from "@t3tools/contracts";

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
  if (error.holder === "other-profile")
    return "Busy: an agent in another F5 profile holds computer or Chrome control; wait or ask the user.";
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
const INTERRUPTED_GUIDANCE: Record<InterruptedError["cause"], string> = {
  paused:
    "computer control for this thread is paused; the user must press Resume in F5 (check the app first if it says Needs recovery). Do not retry until then.",
  "user-input": "the user used the mouse or keyboard; observe again before acting.",
  "kill-switch": "the user stopped computer control; stop and ask before continuing.",
  "access-changed": "app access changed; check computer_status before continuing.",
  "policy-changed": "computer-use settings changed; check computer_status before continuing.",
  "turn-ended": "this turn ended; no further computer actions run in it.",
  "permit-expired": "the action's permit expired before it ran; observe again before acting.",
};
/** Names the cause: a bare "Interrupted" reads as a user stop even when F5 paused the thread. */
function describeComputerInterrupted(error: InterruptedError): string {
  return `Interrupted (${error.cause}): ${INTERRUPTED_GUIDANCE[error.cause]}`;
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
                  ? "TargetBlocked user-active: call computer_wait_for_target, then observe again before acting; take a screenshot before coordinates."
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
