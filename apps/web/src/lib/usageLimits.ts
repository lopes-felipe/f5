import { PROVIDER_DISPLAY_NAMES, type UsageAccounts } from "@t3tools/contracts";
import { quotaWindowsFromSection } from "@t3tools/shared/usageLimit";

/** Local clock time; adds the date only when it is not today. */
export function formatUsageResumeTime(value: string, now = new Date()): string {
  const date = new Date(value);
  const today = date.toDateString() === now.toDateString();
  return date.toLocaleString(undefined, {
    ...(today ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Countdown ("in 5d 10h", "in 1h 39m", "in 12m", "in <1m"); null once due. */
export function formatTimeUntil(value: string, nowMs = Date.now()): string | null {
  const remainingMs = Date.parse(value) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return "in <1m";
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `in ${hours}h ${minutes % 60}m` : `in ${minutes}m`;
}

/** Display fields derived from the server's usage-limit activity payload. */
export interface UsageLimitActivityDisplay {
  readonly providerLabel: string;
  readonly windowLabel: string | null;
  readonly resetsAt: string | null;
}

export function readUsageLimitActivityDisplay(value: unknown): UsageLimitActivityDisplay | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string") return null;
  return {
    providerLabel:
      (PROVIDER_DISPLAY_NAMES as Partial<Record<string, string>>)[record.provider] ??
      record.provider,
    windowLabel: typeof record.windowLabel === "string" ? record.windowLabel : null,
    resetsAt: typeof record.resetsAt === "string" ? record.resetsAt : null,
  };
}

export function formatUsageLimitActivityLabel(display: UsageLimitActivityDisplay): string {
  const window = display.windowLabel ? `${display.windowLabel} ` : "usage ";
  const reset = display.resetsAt ? ` · resets ${formatUsageResumeTime(display.resetsAt)}` : "";
  return `${display.providerLabel} ${window}limit reached${reset}`;
}

const STALE_SNAPSHOT_MS = 15 * 60_000;

/** Formats the cached snapshot only; callers must use refresh: "none". */
export function formatUsageLimits(accounts: UsageAccounts, nowMs = Date.now()): string {
  const remaining = (label: string, used: number | null) =>
    `${label}: ${used === null ? "unknown" : `${Math.max(0, 100 - used).toFixed(0)}% remaining`}`;
  return (
    accounts
      .map((account) => {
        const windows = account.sections.flatMap((section) =>
          quotaWindowsFromSection(section)
            .filter(
              (window) => section.kind !== "codex-limits" || window.windowKey.startsWith("codex:"),
            )
            .map((window) => remaining(window.label, window.usedPercent)),
        );
        const newest = account.sections
          .flatMap((section) => (section.snapshot ? [section.snapshot.fetchedAt] : []))
          .sort()
          .at(-1);
        const stale =
          newest !== undefined && nowMs - Date.parse(newest) > STALE_SNAPSHOT_MS
            ? ` (as of ${formatUsageResumeTime(newest, new Date(nowMs))})`
            : "";
        return `${account.displayName}: ${windows.join(", ") || "Unavailable"}${stale}`;
      })
      .join("; ") || "No account snapshots available."
  );
}
