import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ClaudeUsageAnalysis,
  ClaudeUsageAnalysisWindow,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { invalidateUsageAccounts } from "../../lib/usageReactQuery";
import { Button } from "../ui/button";

const BEHAVIOR_LABELS: Record<string, string> = {
  cache_miss: "Cache misses",
  long_context: "Long context",
  subagent_heavy: "Sub-agent heavy",
  high_parallel: "High parallelism",
  cron: "Scheduled runs",
  max_effort: "Max effort",
  workflow: "Workflows",
  always_on_context: "Always-on context",
  large_tool_results: "Large tool results",
};

export function claudeUsageBehaviorLabel(key: string): string {
  return BEHAVIOR_LABELS[key] ?? key.replaceAll("_", " ");
}

function formatShare(pct: number): string {
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

function AnalysisWindow(props: { label: string; window: ClaudeUsageAnalysisWindow }) {
  const { window } = props;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">
        {props.label}{" "}
        <span className="font-normal text-muted-foreground">
          · {window.requestCount.toLocaleString()} requests in{" "}
          {window.sessionCount.toLocaleString()} sessions
        </span>
      </p>
      {window.recommendations.length > 0 ? (
        <ul className="space-y-1.5">
          {window.recommendations.map((recommendation) => (
            <li key={`${recommendation.key}:${recommendation.title}`} className="text-xs">
              <span className="font-medium">{recommendation.title}</span>{" "}
              <span className="text-muted-foreground">
                ({formatShare(recommendation.pct)} of usage)
              </span>
              {recommendation.detail && (
                <span className="block text-muted-foreground">{recommendation.detail}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No recommendations for this period.</p>
      )}
      {window.behaviors.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {window.behaviors
            .map(
              (behavior) =>
                `${claudeUsageBehaviorLabel(behavior.key)} ${formatShare(behavior.pct)}`,
            )
            .join(" · ")}
        </p>
      )}
    </div>
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
  const windows = props.analysis
    ? ([
        ["Last 24 hours", props.analysis.day],
        ["Last 7 days", props.analysis.week],
      ] as const)
    : [];
  return (
    <div className="space-y-2 border-t border-border/60 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {props.analysis
            ? `Analyzed ${new Date(props.analysis.analyzedAt).toLocaleString()} from this machine's transcripts.`
            : "Find what drives this account's usage from this machine's transcripts."}
        </p>
        <Button size="sm" variant="outline" onClick={analyze} disabled={pending}>
          {pending ? "Analyzing…" : props.analysis ? "Analyze again" : "Analyze usage"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      {props.analysis && windows.every(([, window]) => window === null) && (
        <p className="text-xs text-muted-foreground">
          Claude reported no usage analysis for this account.
        </p>
      )}
      {windows.map(([label, window]) =>
        window ? <AnalysisWindow key={label} label={label} window={window} /> : null,
      )}
    </div>
  );
}
