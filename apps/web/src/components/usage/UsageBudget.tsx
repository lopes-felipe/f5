import type { UsageMonthlyBudget } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, CircleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { usageSummaryQueryOptions } from "../../lib/usageReactQuery";
import { cn } from "../../lib/utils";
import { useWsConnectionState } from "../../wsConnectionState";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { compactNumber, formatUsd } from "./format";
import { UsageBar, UsageSection } from "./kit";
import {
  type BudgetMeter,
  budgetMeters,
  hasBudget,
  type MonthToDateUsage,
  monthToDateUsage,
} from "./monthlyBudget";

/**
 * Month-to-date usage for the budget: every provider and project, from the 90-day
 * daily summary (which always covers the current month). Runs only with a budget
 * and a live connection; when Activity already shows unfiltered 90d it shares
 * that query.
 */
export function useMonthToDateUsage(input: {
  readonly budget: UsageMonthlyBudget | null;
  readonly timeZone: string;
  readonly enabled: boolean;
}): MonthToDateUsage | null {
  const connected = useWsConnectionState().phase === "connected";
  const active = input.enabled && hasBudget(input.budget);
  const query = useQuery(
    usageSummaryQueryOptions({
      range: "90d",
      timeZone: input.timeZone,
      enabled: active && connected,
    }),
  );
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [active]);
  return useMemo(() => {
    if (!active || !query.data) return null;
    return monthToDateUsage({
      buckets: query.data.buckets,
      timeZone: query.data.timeZone,
      nowMs: Math.max(nowMs, Date.parse(query.data.generatedAt)),
    });
  }, [active, query.data, nowMs]);
}

function formatAmount(meter: Pick<BudgetMeter, "kind">, value: number): string {
  return meter.kind === "cost" ? formatUsd(value, 2) : compactNumber(value);
}

function formatDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone }).format(
    new Date(ms),
  );
}

/** Over-budget and on-pace-to-exceed notices for the top of Activity. */
export function BudgetAlerts(props: {
  readonly budget: UsageMonthlyBudget | null;
  readonly usage: MonthToDateUsage | null;
  readonly onEdit: () => void;
}) {
  if (!props.usage) return null;
  const meters = budgetMeters(props.budget, props.usage);
  const exceeded = meters.filter((meter) => meter.exceeded);
  const pacing = meters.filter((meter) => meter.forecastOver);
  if (exceeded.length === 0 && pacing.length === 0) return null;
  const action = (
    <AlertAction>
      <Button size="xs" variant="ghost" onClick={props.onEdit}>
        Edit budget
      </Button>
    </AlertAction>
  );
  if (exceeded.length > 0)
    return (
      <Alert variant="error">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle className="text-xs">Monthly budget exceeded</AlertTitle>
        <AlertDescription className="text-xs">
          {exceeded
            .map(
              (meter) =>
                `${formatAmount(meter, meter.used)} used of your ${formatAmount(meter, meter.limit)} ${
                  meter.kind === "cost" ? "cost" : "token"
                } budget.`,
            )
            .join(" ")}
        </AlertDescription>
        {action}
      </Alert>
    );
  const first = pacing[0]!;
  return (
    <Alert variant="warning" role="note" aria-label="Budget forecast">
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle className="text-xs">
        On pace to exceed your {formatAmount(first, first.limit)} monthly{" "}
        {first.kind === "cost" ? "" : "token "}budget
        {first.exceedsAtMs
          ? ` around ${formatDay(first.exceedsAtMs, props.usage.window.timeZone)}`
          : ""}
      </AlertTitle>
      <AlertDescription className="text-xs">
        {formatAmount(first, first.used)} used so far; forecast{" "}
        {formatAmount(first, first.forecast ?? first.used)} by month end.
      </AlertDescription>
      {action}
    </Alert>
  );
}

/** One meter per budget with a tick at the share of the month elapsed. */
export function BudgetSection(props: {
  readonly budget: UsageMonthlyBudget | null;
  readonly usage: MonthToDateUsage | null;
  readonly onEdit: () => void;
}) {
  if (!hasBudget(props.budget)) return null;
  const usage = props.usage;
  const monthName = new Intl.DateTimeFormat(undefined, {
    month: "long",
    ...(usage ? { timeZone: usage.window.timeZone } : {}),
  }).format(new Date(usage?.window.startMs ?? Date.now()));
  const meters = usage ? budgetMeters(props.budget, usage) : [];
  const monthEnd = usage ? formatDay(usage.window.endMs - 1, usage.window.timeZone) : null;
  return (
    <UsageSection
      title="Monthly budget"
      description={`${monthName} · all providers and projects`}
      actions={
        <Button size="xs" variant="ghost" onClick={props.onEdit}>
          Edit
        </Button>
      }
    >
      {!usage ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading month-to-date usage…
        </p>
      ) : (
        <div className="space-y-3">
          {meters.map((meter) => {
            const percent = meter.limit > 0 ? (meter.used / meter.limit) * 100 : 0;
            const tone = meter.exceeded ? "error" : meter.warn ? "warning" : "default";
            return (
              <div
                key={meter.kind}
                className="grid gap-x-4 gap-y-1.5 text-xs min-[560px]:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)_minmax(7rem,10rem)] min-[560px]:items-center"
              >
                <div>
                  <p className="font-medium">{meter.kind === "cost" ? "Cost" : "Tokens"}</p>
                  <p className="text-2xs text-muted-foreground tabular-nums">
                    {formatAmount(meter, meter.used)} of {formatAmount(meter, meter.limit)}
                  </p>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${meter.kind === "cost" ? "Cost" : "Token"} budget`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, Math.round(percent))}
                  aria-valuetext={`${Math.round(percent)}% used`}
                >
                  <UsageBar
                    percent={percent}
                    tickPercent={usage.elapsedFraction * 100}
                    tone={tone}
                  />
                </div>
                <div className="tabular-nums min-[560px]:text-right">
                  <p>{Math.round(percent)}% used</p>
                  {meter.forecast !== null ? (
                    <p
                      className={cn(
                        "text-2xs",
                        meter.warn ? "text-warning-foreground" : "text-muted-foreground",
                      )}
                    >
                      forecast {formatAmount(meter, meter.forecast)} by {monthEnd}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
          <p className="text-2xs text-muted-foreground">
            {usage.unpricedTurnCount > 0 && meters.some((meter) => meter.kind === "cost")
              ? `Cost excludes ${usage.unpricedTurnCount} unpriced turns. `
              : ""}
            The tick marks how much of the month has passed.
          </p>
        </div>
      )}
    </UsageSection>
  );
}
