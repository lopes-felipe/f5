import {
  PROVIDER_DISPLAY_NAMES,
  type McpToolCallApproval,
  type McpToolCallOutcome,
  type ProjectId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { mcpActivityQueryOptions } from "../../../lib/mcpReactQuery";
import { Button } from "../../ui/button";
import { readErrorMessage } from "./mcpSettingsHelpers";

const OUTCOME_LABELS: Record<McpToolCallOutcome, string> = {
  ok: "OK",
  error: "Error",
  declined: "Declined",
  blocked: "Blocked",
  cancelled: "Cancelled",
  "turned-off": "Turned off in the conversation",
};

const APPROVAL_LABELS: Record<McpToolCallApproval, string> = {
  policy: "Allowed by policy",
  asked: "Asked",
  session: "Allowed earlier in the conversation",
};

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/**
 * One server's tool calls through F5's hub: the last day's error rate and latency,
 * recent calls (arguments and results are never stored), and the stderr tail.
 */
export function McpActivity(props: {
  readonly serverName: string;
  readonly projectId: ProjectId | null;
}) {
  const query = useQuery(
    mcpActivityQueryOptions({ serverName: props.serverName, projectId: props.projectId }),
  );
  const data = query.data;
  const summary = data?.last24h;
  const errorRate =
    summary && summary.calls > 0 ? Math.round((summary.errors / summary.calls) * 100) : undefined;
  return (
    <section aria-label="Activity" className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">
          Calls through F5 for the last 30 days. Arguments and results are never stored.
        </p>
        <Button
          size="xs"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-destructive">
          {readErrorMessage(query.error, "Could not read this server's activity.")}
        </p>
      ) : null}
      {summary ? (
        <dl aria-label="Last 24 hours" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-md border border-border p-2">
            <dt className="text-muted-foreground">Calls, 24 h</dt>
            <dd className="text-foreground">{summary.calls}</dd>
          </div>
          <div className="rounded-md border border-border p-2">
            <dt className="text-muted-foreground">Error rate</dt>
            <dd className="text-foreground">{errorRate === undefined ? "–" : `${errorRate}%`}</dd>
          </div>
          <div className="rounded-md border border-border p-2">
            <dt className="text-muted-foreground">Median</dt>
            <dd className="text-foreground">
              {summary.p50Ms === undefined ? "–" : formatDuration(summary.p50Ms)}
            </dd>
          </div>
          <div className="rounded-md border border-border p-2">
            <dt className="text-muted-foreground">95th percentile</dt>
            <dd className="text-foreground">
              {summary.p95Ms === undefined ? "–" : formatDuration(summary.p95Ms)}
            </dd>
          </div>
        </dl>
      ) : null}
      {data && data.calls.length === 0 ? (
        <p className="text-muted-foreground">No calls through F5 yet.</p>
      ) : null}
      {data && data.calls.length > 0 ? (
        <ul aria-label="Recent calls" className="divide-y divide-border rounded-md border">
          {data.calls.map((call) => (
            <li key={call.id} className="space-y-0.5 px-2 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-foreground">{call.toolName}</span>
                <span
                  className={
                    call.outcome === "ok"
                      ? "text-muted-foreground"
                      : call.outcome === "error"
                        ? "text-destructive"
                        : "text-warning-foreground"
                  }
                >
                  {OUTCOME_LABELS[call.outcome]} · {formatDuration(call.durationMs)}
                </span>
              </div>
              <p className="text-muted-foreground">
                {new Date(call.createdAt).toLocaleString()} ·{" "}
                {PROVIDER_DISPLAY_NAMES[call.provider] ?? call.provider} ·{" "}
                {APPROVAL_LABELS[call.approval]}
              </p>
              {call.errorSummary ? (
                <p className="break-words text-destructive">{call.errorSummary}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data?.stderrTail ? (
        <details>
          <summary className="cursor-pointer text-foreground">Server output (stderr)</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-1.5">
            {data.stderrTail}
          </pre>
        </details>
      ) : null}
    </section>
  );
}
