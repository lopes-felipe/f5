import type { UsageAccount, UsageAccounts } from "@t3tools/contracts";
import { quotaPace } from "@t3tools/shared/usageLimit";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { formatTimeUntil } from "../../lib/usageLimits";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import {
  type AccountGlanceWindow,
  accountNeedsAuthentication,
  accountPlanLabel,
  accountQuotaWindows,
  accountStatusText,
  accountUpdatedAt,
} from "./AccountUsageCards";
import { glanceQuotaWindow } from "./charts/TightestLimitCallout";
import { formatQuotaResetTime } from "./charts/QuotaMeter";
import { UsageBar, UsageSection } from "./kit";

type Tone = "default" | "warning" | "error";

function toneFor(usedPercent: number): Tone {
  if (usedPercent >= 100) return "error";
  return usedPercent >= 90 ? "warning" : "default";
}

function resetText(window: AccountGlanceWindow, nowMs: number): string {
  const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (!window.resetsAt || !Number.isFinite(resetMs)) return "Reset time unavailable";
  const countdown = formatTimeUntil(window.resetsAt, nowMs);
  return `resets ${countdown ? `${countdown} · ` : ""}${formatQuotaResetTime(resetMs)}`;
}

function isLive(window: AccountGlanceWindow, nowMs: number): boolean {
  if (window.usedPercent === null) return false;
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return !(Number.isFinite(reset) && reset <= nowMs);
}

function AccountTile(props: {
  readonly account: UsageAccount;
  readonly nowMs: number;
  readonly onOpen: (account: UsageAccount) => void;
}) {
  const { account, nowMs } = props;
  const plan = accountPlanLabel(account);
  const windows = account.enabled ? accountQuotaWindows(account) : [];
  const lead = glanceQuotaWindow(windows, nowMs);
  const others = lead
    ? windows.filter((window) => window.windowKey !== lead.windowKey && isLive(window, nowMs))
    : [];
  const used = lead ? Math.min(100, Math.max(0, lead.usedPercent!)) : 0;
  const tone = lead ? toneFor(lead.usedPercent!) : "default";
  const pace = lead
    ? quotaPace({
        usedPercent: lead.usedPercent,
        resetsAt: lead.resetsAt,
        durationMinutes: lead.durationMinutes,
        observedAt: lead.observedAt,
      })
    : null;
  const tinted =
    tone === "warning"
      ? "text-warning-foreground"
      : tone === "error"
        ? "text-destructive-foreground"
        : null;
  return (
    <div
      data-testid="limits-glance-tile"
      className={cn(
        "relative flex min-w-0 flex-col gap-2 rounded-lg border p-3 transition-colors",
        tone === "warning"
          ? "border-warning/40 bg-warning/4"
          : tone === "error"
            ? "border-destructive/40 bg-destructive/4"
            : "border-border/70 bg-muted/20 hover:bg-muted/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="min-w-0 truncate text-left text-xs font-semibold after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          aria-label={`Open ${account.displayName} limits`}
          onClick={() => props.onOpen(account)}
        >
          {account.displayName}
        </button>
        {plan ? (
          <Badge size="sm" variant="secondary">
            {plan}
          </Badge>
        ) : null}
      </div>
      {lead ? (
        <>
          <div>
            <p className="flex flex-wrap items-baseline gap-x-1.5">
              <span
                className={cn(
                  "text-2xl leading-none font-semibold tracking-tight tabular-nums",
                  tinted ?? "text-foreground",
                )}
              >
                {(100 - used).toFixed(0)}%
              </span>
              <span className={cn("text-xs", tinted ?? "text-muted-foreground")}>
                left · {lead.label}
              </span>
            </p>
            <p className={cn("mt-1 text-2xs", tinted ?? "text-muted-foreground")}>
              {resetText(lead, nowMs)}
            </p>
          </div>
          <div
            role="progressbar"
            aria-label={`${account.displayName} · ${lead.label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={100 - used}
            aria-valuetext={`${(100 - used).toFixed(0)}% remaining`}
          >
            <UsageBar percent={used} tickPercent={pace?.elapsedPercent ?? null} tone={tone} />
          </div>
          {others.length > 0 ? (
            <ul className="space-y-0.5 border-t border-border/50 pt-1.5 text-2xs text-muted-foreground">
              {others.map((window) => (
                <li key={window.windowKey} className="flex items-center justify-between gap-2">
                  <span className="truncate">{window.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {Math.round(Math.min(100, window.usedPercent!))}% used
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="flex-1 text-xs text-muted-foreground">
          {windows.length > 0
            ? "Reset time passed; awaiting updated usage."
            : accountStatusText(account)}
        </p>
      )}
      {accountNeedsAuthentication(account) ? (
        <Button
          size="xs"
          variant="outline"
          className="relative z-10 self-start"
          render={<Link to="/settings" search={{ category: "providers" }} />}
        >
          Open provider settings
        </Button>
      ) : null}
    </div>
  );
}

/** One tile per visible account, leading with its tightest live limit. */
export function LimitsGlance(props: {
  readonly accounts: UsageAccounts | undefined;
  readonly loading: boolean;
  readonly onOpenAccount: (account: UsageAccount) => void;
  /** Hides the "View details" action on the Limits tab itself. */
  readonly onViewDetails?: () => void;
  readonly title?: string;
}) {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const accounts = props.accounts ?? [];
  const updatedAt = accounts.reduce<string | null>((latest, account) => {
    const at = accountUpdatedAt(account);
    return at && (!latest || at > latest) ? at : latest;
  }, null);
  if (!props.loading && accounts.length === 0) return null;
  return (
    <UsageSection
      title={props.title ?? "Limits"}
      aria-label="Limits at a glance"
      meta={updatedAt ? `Updated ${formatRelativeTimeLabel(updatedAt, nowMs)}` : undefined}
      actions={
        props.onViewDetails ? (
          <Button size="xs" variant="ghost" onClick={props.onViewDetails}>
            View details
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {props.loading && accounts.length === 0
          ? Array.from({ length: 2 }, (_, index) => (
              <Skeleton key={index} className="h-32 w-full rounded-lg" />
            ))
          : accounts.map((account) => (
              <AccountTile
                key={account.key}
                account={account}
                nowMs={nowMs}
                onOpen={props.onOpenAccount}
              />
            ))}
      </div>
    </UsageSection>
  );
}
