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
  /** Rolling window length, when the provider reports or implies one. */
  readonly durationMinutes: number | null;
}

/** Claude window keys imply their length; other keys (spend, unknown) have none. */
export function claudeQuotaWindowDurationMinutes(key: string): number | null {
  if (key === "five_hour") return 300;
  if (key.startsWith("seven_day")) return 10_080;
  return null;
}

/** Usage within this many points of elapsed time reads as "on pace". */
export const QUOTA_ON_PACE_POINTS = 5;

export interface QuotaPace {
  /** Share of the window elapsed at `observedAt`, 0-100. */
  readonly elapsedPercent: number;
  /** `usedPercent - elapsedPercent`; positive means usage is ahead of the clock. */
  readonly deltaPoints: number;
}

/**
 * Compares usage with elapsed window time at the snapshot's observation time.
 * Null when the window length or reset is unknown, or the reset is not after `observedAt`.
 */
export function quotaPace(input: {
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly durationMinutes: number | null;
  readonly observedAt: string | null;
}): QuotaPace | null {
  if (input.usedPercent === null || !input.durationMinutes || input.durationMinutes <= 0)
    return null;
  if (!input.resetsAt || !input.observedAt) return null;
  const reset = Date.parse(input.resetsAt);
  const observed = Date.parse(input.observedAt);
  if (!Number.isFinite(reset) || !Number.isFinite(observed) || reset <= observed) return null;
  const durationMs = input.durationMinutes * 60_000;
  const elapsedPercent = Math.min(
    100,
    Math.max(0, ((durationMs - (reset - observed)) / durationMs) * 100),
  );
  const used = Math.min(100, Math.max(0, input.usedPercent));
  return { elapsedPercent, deltaPoints: used - elapsedPercent };
}

export function quotaPaceLabel(pace: QuotaPace): string {
  const points = Math.round(Math.abs(pace.deltaPoints));
  if (Math.abs(pace.deltaPoints) < QUOTA_ON_PACE_POINTS) return "on pace";
  return pace.deltaPoints > 0 ? `${points} pts ahead of pace` : `${points} pts under pace`;
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
        durationMinutes: null,
      }));
    case "claude-usage":
      if (!section.snapshot.data.limitsAvailable) return [];
      return section.snapshot.data.windows.map((window) => ({
        windowKey: window.key,
        label: window.label,
        usedPercent: window.utilization,
        resetsAt: window.resetsAt,
        durationMinutes: claudeQuotaWindowDurationMinutes(window.key),
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
                  durationMinutes: window.windowDurationMins || null,
                },
              ]
            : [],
        ),
      );
    case "codex-tokens":
      return [];
  }
}
