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
export class ComputerControlError extends Error {
  constructor(readonly error: ComputerAutomationError) {
    super(
      error._tag === "OutcomeUnknown"
        ? "The action may or may not have run; take a screenshot before retrying."
        : error._tag === "Busy" && error.reason === "observation-backlog"
          ? "Observation backlog is full; wait before requesting another screenshot or inspection."
          : error._tag === "Busy" && error.holder === "other-profile"
            ? "Busy: an agent in another F5 profile holds computer or Chrome control; wait or ask the user."
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
