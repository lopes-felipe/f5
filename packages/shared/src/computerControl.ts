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
export function isComputerMutation(op: ComputerAutomationOperation): boolean {
  return !OBSERVATIONS.has(op);
}
export class ComputerControlError extends Error {
  constructor(readonly error: ComputerAutomationError) {
    super(
      error._tag === "OutcomeUnknown"
        ? "The action may or may not have run; take a screenshot before retrying."
        : error._tag === "Busy" && error.reason === "observation-backlog"
          ? "Observation backlog is full; wait before requesting another screenshot or inspection."
          : error._tag === "Execution"
            ? error.message
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
