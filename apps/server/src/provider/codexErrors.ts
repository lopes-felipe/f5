import type { RuntimeUsageLimit } from "@t3tools/contracts";
import { resetDate } from "../usage/accountUsageJson.ts";
import { usageLimitFromWindows, usageLimitMessage } from "./usageLimitMessages.ts";
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
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
    ...(update.primary ? { primary: { ...previous?.primary, ...update.primary } } : {}),
    ...(update.secondary ? { secondary: { ...previous?.secondary, ...update.secondary } } : {}),
  };
}

export function formatCodexUsageError(
  message: string,
  snapshot: CodexLimitSnapshot | undefined,
  at: string,
  errorInfo?: unknown,
): string {
  const exhausted = (snapshot ? exhaustedCodexWindows(snapshot) : [])
    .filter((window) => window.resetsAt !== null && Date.parse(window.resetsAt) > Date.parse(at))
    .sort((left, right) => Date.parse(right.resetsAt!) - Date.parse(left.resetsAt!))[0];
  if (errorInfo !== "usageLimitReached") return message;
  const label = exhausted?.label ?? undefined;
  const reset = exhausted?.resetsAt ? Date.parse(exhausted.resetsAt) / 1000 : undefined;
  let result = usageLimitMessage("Codex", label, reset);
  if (snapshot?.rateLimitReachedType?.includes("credits_depleted"))
    result += " Ask your workspace owner to add credits to continue sooner.";
  if (snapshot?.rateLimitReachedType?.includes("usage_limit_reached"))
    result += " Ask your workspace owner to review the workspace spend limit.";
  return `${message} ${result}`;
}

export function exhaustedCodexWindows(snapshot: CodexLimitSnapshot): RuntimeUsageLimit["windows"] {
  return (["primary", "secondary"] as const).flatMap((name) => {
    const window = snapshot[name];
    if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 100) return [];
    const minutes = window.windowDurationMins;
    const label =
      typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
        ? minutes === 10080
          ? "weekly"
          : minutes % 1440 === 0
            ? `${minutes / 1440}-day`
            : minutes >= 300 && minutes % 60 === 0
              ? `${minutes / 60}-hour`
              : `${minutes}-minute`
        : null;
    return [
      {
        id: `${snapshot.limitId ?? "codex"}:${name}`,
        label,
        resetsAt: resetDate(window.resetsAt, "s"),
      },
    ];
  });
}

/** Codex inherits the server timezone; per-instance TZ overrides cannot be inferred here. */
export function parseCodexTryAgainAt(message: string, at: string): string | null {
  const match = /try again at\s+([^\n]+?)(?:[.!](?:\s|$)|$)/i.exec(message);
  if (!match) return null;
  const text = match[1]!.replace(/(\d+)(?:st|nd|rd|th)\b/gi, "$1").trim();
  const reset = resetDate(text);
  const now = Date.parse(at);
  return reset && Date.parse(reset) > now && Date.parse(reset) <= now + 8 * 86400000 ? reset : null;
}

export function detectCodexUsageLimit(input: {
  message: string;
  errorInfo?: unknown;
  snapshots?: ReadonlyArray<
    CodexLimitSnapshot | { snapshot: CodexLimitSnapshot; observedAt: string }
  >;
  at: string;
  deferMessageReset?: boolean;
  /** Live account updates observed during this turn are provider evidence. */
  snapshotNotBefore?: string;
}): RuntimeUsageLimit | null {
  if (/\b(?:warning|retrying|will retry|authentication|unauthorized)\b/i.test(input.message))
    return null;
  const snapshots = (input.snapshots ?? []).map((entry) =>
    "snapshot" in entry ? entry.snapshot : entry,
  );
  if (
    snapshots.some((entry) =>
      /credits_depleted|usage_limit_reached/.test(entry.rateLimitReachedType ?? ""),
    )
  )
    return null;
  const typed =
    input.errorInfo === "usageLimitReached" ||
    (input.errorInfo !== null &&
      typeof input.errorInfo === "object" &&
      ("usageLimitReached" in input.errorInfo || "usageLimitExceeded" in input.errorInfo));
  if (
    !typed &&
    !/\b(?:hit|reached) your usage limit\b|\busage limit reached\b/i.test(input.message)
  )
    return null;
  const freshSnapshots = (input.snapshots ?? [])
    .filter(
      (entry) =>
        !("snapshot" in entry) ||
        Date.parse(entry.observedAt) >= Date.parse(input.snapshotNotBefore ?? input.at),
    )
    .map((entry) => ("snapshot" in entry ? entry.snapshot : entry));
  const windows = freshSnapshots.flatMap(exhaustedCodexWindows);
  const result = usageLimitFromWindows(windows, typed ? "typed" : "message");
  if (result.resetsAt) return result;
  const parsed = input.deferMessageReset ? null : parseCodexTryAgainAt(input.message, input.at);
  return parsed ? { ...result, resetsAt: parsed, resetSource: "message" } : result;
}
