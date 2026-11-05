import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ClaudeUsageAnalysis,
  ClaudeUsageAnalysisWindow,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { invalidateUsageAccounts } from "../../lib/usageReactQuery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { mergeUsageAnalysis, type UsageFactorRow } from "./claudeUsageAnalysis";

function formatShare(pct: number): string {
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

// One hue in two steps: `--info` is indistinguishable from `--primary` in both themes.
const SERIES = [
  { window: "day", label: "24 hours", color: "bg-primary/45" },
  { window: "week", label: "7 days", color: "bg-primary" },
] as const;

function WindowStat(props: { label: string; window: ClaudeUsageAnalysisWindow }) {
  return (
    <div>
      <p className="text-2xs text-muted-foreground">{props.label}</p>
      <p className="text-sm font-semibold tabular-nums">
        {props.window.requestCount.toLocaleString()} req ·{" "}
        {props.window.sessionCount.toLocaleString()} sessions
      </p>
    </div>
  );
}

function ShareBar(props: { pct: number | null; color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 text-2xs tabular-nums">
      {props.pct === null ? (
        <span className="text-muted-foreground">
          <span className="sr-only">{props.label}: </span>none
        </span>
      ) : (
        <>
          <div aria-hidden="true" className="h-1.5 w-full max-w-32 rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", props.color)}
              style={{ width: `${Math.min(100, props.pct)}%` }}
            />
          </div>
          <span className="shrink-0">
            <span className="sr-only">{props.label}: </span>
            {formatShare(props.pct)}
          </span>
        </>
      )}
    </div>
  );
}

function FactorTable(props: {
  rows: ReadonlyArray<UsageFactorRow>;
  series: ReadonlyArray<(typeof SERIES)[number]>;
}) {
  return (
    <table className="w-full text-left text-xs">
      <caption className="sr-only">What drives usage</caption>
      <thead className="text-2xs text-muted-foreground">
        <tr>
          <th scope="col" className="pb-1.5 pr-3 font-medium">
            Factor
          </th>
          <th scope="col" className="w-2/5 pb-1.5 pr-3 font-medium">
            Share
          </th>
          <th scope="col" className="pb-1.5 font-medium">
            What to do
          </th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr key={row.id} className="border-t border-border/60 align-top">
            <th scope="row" className="py-2 pr-3 font-normal">
              {row.label}
            </th>
            <td className="py-2 pr-3">
              <div className="space-y-1">
                {props.series.map((series) => (
                  <ShareBar
                    key={series.window}
                    label={series.label}
                    color={series.color}
                    pct={series.window === "day" ? row.dayPct : row.weekPct}
                  />
                ))}
              </div>
            </td>
            <td className="py-2">
              {row.action ? (
                <>
                  {row.action.title !== row.label && (
                    <p className="font-medium">{row.action.title}</p>
                  )}
                  {row.action.detail && (
                    <p className="text-muted-foreground">{row.action.detail}</p>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">No recommendation</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * On-demand Analyze usage for one Claude account: scans this machine's transcripts for
 * recommendations. The result is kept in server memory only. Claude's one-click `fix`
 * is not offered: there is no session here, and F5's picker owns effort.
 */
export function ClaudeUsageAnalysisPanel(props: {
  instanceId: ProviderInstanceId;
  analysis: ClaudeUsageAnalysis | undefined;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const analyze = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await ensureNativeApi().usage.analyzeClaudeUsage({ providerInstanceId: props.instanceId });
      await invalidateUsageAccounts(client);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Usage analysis failed.");
    } finally {
      setPending(false);
    }
  };
  const analysis = props.analysis;
  const series = analysis ? SERIES.filter((entry) => analysis[entry.window] !== null) : [];
  const rows = analysis ? mergeUsageAnalysis(analysis.day, analysis.week) : [];
  return (
    <section aria-label="What drives usage" className="space-y-3 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-medium">What drives usage</h4>
          <p className="text-2xs text-muted-foreground">
            {analysis
              ? `Analyzed ${new Date(analysis.analyzedAt).toLocaleString()} from this machine's transcripts.`
              : "Find what drives this account's usage from this machine's transcripts."}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={analyze} disabled={pending}>
          {pending ? "Analyzing…" : analysis ? "Analyze again" : "Analyze usage"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      {analysis && series.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Claude reported no usage analysis for this account.
        </p>
      )}
      {analysis && series.length > 0 && (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {analysis.day && <WindowStat label="Last 24 hours" window={analysis.day} />}
            {analysis.week && <WindowStat label="Last 7 days" window={analysis.week} />}
          </div>
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No usage factors for these periods.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
                {series.map((entry) => (
                  <span key={entry.window} className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className={cn("size-2.5 rounded-sm", entry.color)} />
                    {entry.label}
                  </span>
                ))}
                <span>Share of usage. Factors overlap, so shares don't add to 100%.</span>
              </div>
              <FactorTable rows={rows} series={series} />
            </>
          )}
        </>
      )}
    </section>
  );
}
