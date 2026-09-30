import { usageLimitMessage } from "./usageLimitMessages.ts";
const UNSUPPORTED_MODEL_RECOVERY_HINT =
  "Choose another model, or upgrade Codex CLI and verify that your account has access.";

export function isUnsupportedCodexModelError(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    /\b(?:unknown|unsupported)\s+(?:requested\s+)?model\b/u.test(normalized) ||
    /\bmodel(?:\s+['"][^'"]+['"])?\s+(?:is\s+)?not supported\b/u.test(normalized) ||
    /\b(?:requested\s+)?model(?:\s+['"][^'"]+['"])?\s+not found\b/u.test(normalized)
  );
}

export function formatCodexUnsupportedModelError(message: string): string {
  return isUnsupportedCodexModelError(message)
    ? `${message} ${UNSUPPORTED_MODEL_RECOVERY_HINT}`
    : message;
}

export interface CodexLimitSnapshot {
  limitId?: string | null;
  rateLimitReachedType?: string | null;
  primary?: {
    usedPercent: number;
    resetsAt?: number | null;
    windowDurationMins?: number | null;
  } | null;
  secondary?: {
    usedPercent: number;
    resetsAt?: number | null;
    windowDurationMins?: number | null;
  } | null;
}

export function mergeCodexLimitSnapshot(
  previous: CodexLimitSnapshot | undefined,
  update: CodexLimitSnapshot,
): CodexLimitSnapshot | undefined {
  if (update.limitId && update.limitId !== "codex") return previous;
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
  };
}

export function formatCodexUsageError(
  message: string,
  snapshot: CodexLimitSnapshot | undefined,
  at: string,
  errorInfo?: unknown,
): string {
  const windows = [snapshot?.primary, snapshot?.secondary].filter(
    (window) =>
      window &&
      window.usedPercent >= 100 &&
      typeof window.resetsAt === "number" &&
      window.resetsAt * 1000 > Date.parse(at),
  );
  const exhausted = windows.sort(
    (left, right) => (right?.resetsAt ?? 0) - (left?.resetsAt ?? 0),
  )[0];
  if (errorInfo !== "usageLimitReached") return message;
  const minutes = exhausted?.windowDurationMins;
  const label =
    typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
      ? minutes === 10080
        ? "weekly"
        : minutes % 1440 === 0
          ? `${minutes / 1440}-day`
          : minutes >= 300 && minutes % 60 === 0
            ? `${minutes / 60}-hour`
            : `${minutes}-minute`
      : undefined;
  const reset = exhausted?.resetsAt;
  let result = usageLimitMessage("Codex", label, reset);
  if (snapshot?.rateLimitReachedType?.includes("credits_depleted"))
    result += " Ask your workspace owner to add credits to continue sooner.";
  if (snapshot?.rateLimitReachedType?.includes("usage_limit_reached"))
    result += " Ask your workspace owner to review the workspace spend limit.";
  return `${message} ${result}`;
}
