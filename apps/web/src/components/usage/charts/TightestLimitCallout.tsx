import { useEffect, useState, type ReactNode } from "react";

import { formatTimeUntil } from "../../../lib/usageLimits";
import { cn } from "../../../lib/utils";
import { formatQuotaResetTime } from "./QuotaMeter";

export interface CalloutWindow {
  readonly windowKey: string;
  /** Display name, already qualified when windows come from several groups. */
  readonly label: string;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
}

/** The window with the least left; null when fewer than two windows compete. */
export function tightestQuotaWindow<W extends CalloutWindow>(windows: ReadonlyArray<W>): W | null {
  if (windows.length < 2) return null;
  let tightest: W | null = null;
  for (const window of windows) {
    if (window.usedPercent === null) continue;
    if (!tightest || window.usedPercent > tightest.usedPercent!) tightest = window;
  }
  return tightest;
}

/** Names the limit that runs out first, with its reset; warning-colored at 90% used. */
export function TightestLimitCallout(props: {
  readonly windows: ReadonlyArray<CalloutWindow>;
  /** Rendered beside the text, e.g. a reset-credit button for an exhausted window. */
  readonly action?: (window: CalloutWindow) => ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const window = tightestQuotaWindow(props.windows);
  if (!window) return null;
  const used = Math.min(100, Math.max(0, window.usedPercent!));
  const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const countdown =
    window.resetsAt && Number.isFinite(resetMs) ? formatTimeUntil(window.resetsAt, now) : null;
  const warn = used >= 90;
  const action = props.action?.(window);
  return (
    <div
      data-testid="tightest-limit"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs",
        warn
          ? "border-warning/40 bg-warning/10 text-warning-foreground"
          : "border-border/60 text-muted-foreground",
      )}
    >
      <p>
        <span className={cn("text-base font-semibold tabular-nums", !warn && "text-foreground")}>
          {(100 - used).toFixed(0)}% left
        </span>{" "}
        · <span className={cn("font-medium", !warn && "text-foreground")}>{window.label}</span>
        {countdown ? ` resets ${formatQuotaResetTime(resetMs)} (${countdown})` : ""}
      </p>
      {action}
    </div>
  );
}
