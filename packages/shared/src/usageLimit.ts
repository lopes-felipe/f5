import type { AccountUsageSection, CodexAccountRateLimitWindow } from "@t3tools/contracts";

/** A usage-limit continue waits this long past the reset. */
export const USAGE_RESUME_BUFFER_MS = 60_000;
/** Scheduled continues must start within this horizon. */
export const USAGE_RESUME_MAX_HORIZON_MS = 8 * 24 * 60 * 60_000;

/** Whether continuing at a known reset fits the schedulable horizon. */
export function canResumeAtUsageReset(resetsAt: string, nowMs: number): boolean {
  const reset = Date.parse(resetsAt);
  return (
    Number.isFinite(reset) &&
    Math.max(nowMs, reset) + USAGE_RESUME_BUFFER_MS <= nowMs + USAGE_RESUME_MAX_HORIZON_MS
  );
}

/**
 * Claude's monthly spend budget is a spend meter, not a rolling quota. It has
 * no reset, so it never settles when a usage-limited turn can continue.
 */
export const CLAUDE_MONTHLY_SPEND_WINDOW_KEY = "monthly_spend";

/** Stable identity shared by the server ledger and browser recovery controls. */
export function usageLimitFailureKey(
  limit:
    | {
        readonly providerInstanceId: string;
        readonly turnId?: string | null;
        readonly deliveryId?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!limit) return null;
  if (limit.turnId) return `instance:${limit.providerInstanceId}:turn:${limit.turnId}`;
  if (limit.deliveryId) return `instance:${limit.providerInstanceId}:delivery:${limit.deliveryId}`;
  return null;
}

export function codexRateLimitWindowLabel(
  window: Pick<CodexAccountRateLimitWindow, "windowDurationMins">,
  fallback: string,
): string {
  const minutes = window.windowDurationMins;
  if (minutes === null) return fallback;
  if (minutes === 300) return "5-hour limit";
  if (minutes === 10_080) return "Weekly limit";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

export interface QuotaWindow {
  readonly windowKey: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
}

function epochSecondsToIso(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Every quota window a section reports, keyed consistently for history.
 * Claude extra usage is not a quota window and is excluded.
 */
export function quotaWindowsFromSection(section: AccountUsageSection): Array<QuotaWindow> {
  if (!section.snapshot) return [];
  switch (section.kind) {
    case "provider-limits":
      return section.snapshot.data.windows.map((window) => ({
        windowKey: window.id,
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      }));
    case "claude-usage":
      if (!section.snapshot.data.limitsAvailable) return [];
      return section.snapshot.data.windows.map((window) => ({
        windowKey: window.key,
        label: window.label,
        usedPercent: window.utilization,
        resetsAt: window.resetsAt,
      }));
    case "codex-limits":
      return section.snapshot.data.rateLimits.flatMap((limit) =>
        (
          [
            ["primary", limit.primary, "Primary limit"],
            ["secondary", limit.secondary, "Secondary limit"],
            ["individual", limit.individual, "Monthly credit limit"],
          ] as const
        ).flatMap(([slot, window, fallback]) =>
          window
            ? [
                {
                  windowKey: `${limit.id}:${slot}`,
                  label: codexRateLimitWindowLabel(window, fallback),
                  usedPercent: window.usedPercent,
                  resetsAt: epochSecondsToIso(window.resetsAt),
                },
              ]
            : [],
        ),
      );
    case "codex-tokens":
      return [];
  }
}
