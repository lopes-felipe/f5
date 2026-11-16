import type { UsageQuotaSample } from "@t3tools/contracts";
import { quotaPace, quotaPaceLabel } from "@t3tools/shared/usageLimit";
import { useEffect, useState } from "react";

import { formatTimeUntil, formatUsageResumeTime } from "../../../lib/usageLimits";
import { projectQuota, type QuotaProjection } from "../../../lib/usageQuotaProjection";
import { cn } from "../../../lib/utils";

function durationLabel(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function forecastText(
  projection: QuotaProjection | null,
  resetsAt: string | null,
  now: number,
): string | null {
  if (!projection || !resetsAt) return null;
  // Includes the date when the hit is not today, so multi-day windows read clearly.
  if (projection.kind === "will-hit")
    return `At this pace: limit reached ~${formatUsageResumeTime(projection.at, new Date(now))} (${durationLabel(
      Date.parse(resetsAt) - Date.parse(projection.at),
    )} before reset)`;
  if (projection.kind === "under")
    return `At this pace: ~${Math.round(projection.percentAtReset)}% used at reset`;
  return null;
}

function Sparkline(props: {
  readonly samples: ReadonlyArray<UsageQuotaSample>;
  readonly resetsAt: string;
  readonly projection: QuotaProjection | null;
  readonly current: { readonly at: string; readonly usedPercent: number } | null;
}) {
  const start = Date.parse(props.samples[0]!.at);
  const end = Date.parse(props.resetsAt);
  if (!(end > start)) return null;
  const x = (at: number) => ((Math.min(end, Math.max(start, at)) - start) / (end - start)) * 100;
  const y = (percent: number) => 24 - (Math.min(100, Math.max(0, percent)) / 100) * 22 - 1;
  const points = props.samples.map(
    (sample) => `${x(Date.parse(sample.at))},${y(sample.usedPercent)}`,
  );
  const last = props.current ?? props.samples.at(-1)!;
  let projected: { at: number; percent: number } | null = null;
  if (props.projection?.kind === "will-hit")
    projected = { at: Date.parse(props.projection.at), percent: 100 };
  else if (props.projection?.kind === "under")
    projected = { at: end, percent: props.projection.percentAtReset };
  return (
    <svg
      aria-hidden="true"
      data-testid="quota-sparkline"
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      className="h-6 w-full overflow-visible text-primary"
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      {projected ? (
        <line
          x1={x(Date.parse(last.at))}
          y1={y(last.usedPercent)}
          x2={x(projected.at)}
          y2={y(projected.percent)}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
          className="opacity-60"
        />
      ) : null}
    </svg>
  );
}

/** Short reset time: "Nov 6, 6:00 AM". */
export function formatQuotaResetTime(resetMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetMs));
}

/** Explains the fill and the pace tick once above a stack of meters. */
export function QuotaMeterLegend() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-primary" />
        Used
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-0.5 rounded-full bg-foreground" />
        Time elapsed (pace)
      </span>
    </div>
  );
}

/**
 * One limit as a row: label and reset on the left, a used bar with a tick at the
 * elapsed share of the window in the middle, and used percent with pace on the right.
 * The accessible value stays "N% remaining".
 */
export function QuotaMeter(props: {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  accessibleName: string;
  /** Snapshot time of `utilization`; enables pace and forecasts. */
  observedAt?: string | null;
  /** Window length; enables the pace tick. */
  durationMinutes?: number | null;
  history?: ReadonlyArray<UsageQuotaSample>;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const percent =
    props.utilization === null ? undefined : Math.min(100, Math.max(0, props.utilization));
  const remainingPercent = percent === undefined ? undefined : 100 - percent;
  const resetMs = props.resetsAt ? Date.parse(props.resetsAt) : NaN;
  const resetValid = Number.isFinite(resetMs);
  const resetPassed = resetValid && resetMs <= now;
  const countdown = props.resetsAt && resetValid ? formatTimeUntil(props.resetsAt, now) : null;
  const reset = !resetValid
    ? "Reset time unavailable"
    : resetPassed
      ? "Reset time passed; awaiting updated usage"
      : `${countdown ? `${countdown} · ` : ""}${formatQuotaResetTime(resetMs)}`;
  const valueText =
    props.utilization === null ? "Unknown" : `${remainingPercent!.toFixed(0)}% remaining`;
  const usedText =
    props.utilization === null
      ? "Unknown"
      : props.utilization > 100
        ? `over limit (${Math.round(props.utilization)}% used)`
        : `${percent!.toFixed(0)}% used`;
  const pace = resetPassed
    ? null
    : quotaPace({
        usedPercent: props.utilization,
        resetsAt: props.resetsAt,
        durationMinutes: props.durationMinutes ?? null,
        observedAt: props.observedAt ?? null,
      });
  const history = props.history ?? [];
  const projection =
    props.observedAt && !resetPassed
      ? projectQuota({
          samples: history,
          current: { at: props.observedAt, usedPercent: props.utilization },
          resetsAt: props.resetsAt,
          now,
        })
      : null;
  const forecast = forecastText(projection, props.resetsAt, now);
  return (
    <div className="space-y-1.5">
      <div className="grid gap-x-4 gap-y-1.5 text-xs min-[560px]:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)_minmax(7rem,10rem)] min-[560px]:items-center">
        <div className="min-w-0">
          <p className="font-medium">{props.label}</p>
          <p className="text-2xs text-muted-foreground">{reset}</p>
        </div>
        <div
          role="progressbar"
          aria-label={props.accessibleName}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remainingPercent}
          aria-valuetext={valueText}
          className="relative h-2 rounded-full bg-muted"
        >
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full transition-[width]",
              (percent ?? 0) >= 90 ? "bg-warning" : "bg-primary",
            )}
            style={{ width: `${percent ?? 0}%` }}
          />
          {pace ? (
            <div
              aria-hidden="true"
              data-testid="quota-pace-tick"
              className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
              style={{ left: `${pace.elapsedPercent}%` }}
            />
          ) : null}
        </div>
        <div className="tabular-nums min-[560px]:text-right">
          <p>{usedText}</p>
          {pace ? <p className="text-2xs text-muted-foreground">{quotaPaceLabel(pace)}</p> : null}
        </div>
      </div>
      {history.length >= 2 && props.resetsAt && resetValid && !resetPassed ? (
        <Sparkline
          samples={history}
          resetsAt={props.resetsAt}
          projection={projection}
          current={
            props.observedAt && props.utilization !== null
              ? { at: props.observedAt, usedPercent: props.utilization }
              : null
          }
        />
      ) : null}
      {forecast ? (
        <p
          className={cn(
            "text-2xs",
            projection?.kind === "will-hit" ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {forecast}
        </p>
      ) : null}
    </div>
  );
}
