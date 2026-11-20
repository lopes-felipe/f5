import type { ThreadId } from "@t3tools/contracts";
import { quotaPace, quotaPaceLabel, type QuotaWindow } from "@t3tools/shared/usageLimit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import { useActiveComposerSelection } from "../../activeComposerSelection";
import {
  forceRefreshUsageAccounts,
  usageCachedAccountsQueryOptions,
} from "../../lib/usageReactQuery";
import { formatTimeUntil, formatUsageResumeTime } from "../../lib/usageLimits";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { providerLabel } from "./format";
import { UsageBar } from "./kit";
import { sidebarUsageWindows, sidebarWeeklyUsageWindow } from "./sidebarUsageWindows";
import { UsageGauge, describeWeeklyUsage } from "./UsageGauge";

function LimitAction(props: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const Icon = props.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        <Icon className={props.busy ? "size-3.5 animate-spin" : "size-3.5"} />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** One limit: used bar with the elapsed-time pace tick, reset time and pace label. */
export function ComposerLimitRow({
  window,
  now,
}: {
  window: QuotaWindow & { readonly observedAt: string | null };
  now: number;
}) {
  const percent = window.usedPercent;
  const resetPassed = window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
  const pace = resetPassed
    ? null
    : quotaPace({
        usedPercent: percent,
        resetsAt: window.resetsAt,
        durationMinutes: window.durationMinutes,
        observedAt: window.observedAt,
      });
  const paceLabel = pace ? quotaPaceLabel(pace) : null;
  const usedText = percent === null ? "Unknown" : `${Math.round(percent)}% used`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">{window.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{usedText}</span>
      </div>
      <div
        role="progressbar"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.min(100, Math.max(0, percent))}
        aria-valuetext={paceLabel ? `${usedText}, ${paceLabel}` : usedText}
      >
        <UsageBar
          percent={percent ?? 0}
          tickPercent={pace?.elapsedPercent ?? null}
          tone={
            percent !== null && percent >= 100
              ? "error"
              : percent !== null && percent >= 90
                ? "warning"
                : "default"
          }
        />
      </div>
      <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-2xs text-muted-foreground">
        <span>
          {window.resetsAt === null
            ? "Reset time unavailable"
            : resetPassed
              ? "Reset passed · Awaiting updated usage"
              : `Resets ${formatTimeUntil(window.resetsAt, now) ?? ""} · ${formatUsageResumeTime(window.resetsAt)}`}
        </span>
        {paceLabel ? <span className="ml-auto shrink-0 tabular-nums">{paceLabel}</span> : null}
      </p>
    </div>
  );
}

/** Reads cached snapshots for the weekly meter, without starting provider probes. */
export function ComposerUsageLimits({
  threadId,
  persistent = false,
}: {
  threadId: ThreadId;
  persistent?: boolean;
}) {
  const selection = useActiveComposerSelection(
    (state) =>
      [...state.registrations.values()].findLast((entry) => entry.threadId === threadId) ?? null,
  );
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const client = useQueryClient();
  const isUsage = useLocation({ select: (location) => location.pathname === "/usage" });
  const accountsQuery = useQuery(usageCachedAccountsQueryOptions(selection?.instanceId != null));
  const account = selection?.instanceId
    ? accountsQuery.data?.find((candidate) => candidate.providerInstanceId === selection.instanceId)
    : undefined;
  const windows = account ? sidebarUsageWindows(account) : [];
  const weekly = sidebarWeeklyUsageWindow(windows);
  const refresh = useMutation({
    mutationKey: ["usage", "sidebar-refresh", selection?.instanceId],
    mutationFn: async () => {
      const instanceId = selection?.instanceId;
      if (!instanceId) throw new Error("Select a provider in a conversation first.");
      await forceRefreshUsageAccounts(client, instanceId);
    },
  });
  const busy = refresh.isPending || (account != null && account.refreshState !== "idle");
  const label = selection ? providerLabel(selection.provider) : "Usage";
  const weeklyDescription = describeWeeklyUsage(weekly?.usedPercent ?? null);
  const resetRefresh = refresh.reset;

  useEffect(() => {
    resetRefresh();
  }, [selection?.instanceId, resetRefresh]);

  useEffect(() => {
    if (!open && !persistent) return;
    // The clock is idle while the panel is closed; catch up before showing reset times.
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open, persistent]);

  const panel = (
    <section aria-label="Conversation usage limits" className="min-w-0 w-full space-y-3">
      <div className="flex min-w-0 items-center gap-1">
        <UsageGauge percent={weekly?.usedPercent ?? null} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={account?.displayName}>
          {label} limits
        </span>
        <LimitAction
          label="Refresh account limits"
          icon={RefreshCwIcon}
          disabled={!selection?.instanceId || account?.enabled === false || busy}
          busy={busy}
          onClick={() => refresh.mutate()}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/usage"
                aria-label="Open Usage"
                aria-current={isUsage ? "page" : undefined}
                onClick={() => setOpen(false)}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              />
            }
          >
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Open Usage</TooltipPopup>
        </Tooltip>
      </div>
      {windows.length > 0 && account?.enabled === false ? (
        <p className="text-2xs text-muted-foreground">
          This provider is disabled. Showing collected limits.
        </p>
      ) : windows.length > 0 &&
        account?.sections.some(
          (section) => section.snapshot !== null && section.outcome === "unavailable",
        ) ? (
        <p role="status" className="text-2xs text-muted-foreground">
          Collected limits may be stale.
        </p>
      ) : null}
      <div className="max-h-64 space-y-3 overflow-y-auto">
        {!selection?.instanceId ? (
          <p className="text-xs text-muted-foreground">Select a conversation to see its limits.</p>
        ) : accountsQuery.isPending ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading limits…
          </p>
        ) : windows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {account?.enabled === false
              ? "This provider is disabled."
              : "No reported limits available. Refresh or open Usage for details."}
          </p>
        ) : (
          windows.map((window) => (
            <ComposerLimitRow key={window.windowKey} window={window} now={now} />
          ))
        )}
      </div>
      {accountsQuery.isError || refresh.isError ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          Unable to refresh limits. Previously collected data is retained.
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-2xs text-muted-foreground">
          Refreshing…
        </p>
      ) : null}
    </section>
  );

  if (persistent)
    return (
      <div aria-label="Persistent usage limits" className="grid gap-3 sm:grid-cols-2">
        {windows.map((window) => (
          <ComposerLimitRow key={window.windowKey} window={window} now={now} />
        ))}
        {windows.length === 0 ? (
          <span className="text-xs text-muted-foreground">No reported limits available.</span>
        ) : null}
      </div>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${label} usage limits, ${weeklyDescription}`}
            title={`${label} usage limits · ${weeklyDescription}`}
            className="shrink-0 text-muted-foreground"
          />
        }
      >
        <UsageGauge percent={weekly?.usedPercent ?? null} />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        aria-label="Usage limits"
        className="w-80 max-w-(--available-width)"
      >
        {panel}
      </PopoverPopup>
    </Popover>
  );
}
