import type { ServerHealth, ServerHealthSlowOperation } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { serverHealthQueryOptions } from "../../lib/serverReactQuery";
import { formatDuration } from "../../session-logic";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SettingsCard } from "./SettingsCard";

const formatMegabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
/** `formatDuration` rounds anything under a millisecond up to 1ms; a delay of zero is a real answer. */
const formatDelay = (ms: number) => (ms === 0 ? "0ms" : formatDuration(ms));
/** Thresholds are round numbers: "1s", not "1.0s". */
const formatThreshold = (ms: number) => (ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`);

function SlowOperations(props: {
  readonly title: string;
  readonly nameHeading: string;
  readonly empty: string;
  readonly operations: ReadonlyArray<ServerHealthSlowOperation>;
  readonly monospace?: boolean;
}) {
  return (
    <div className="border-t border-border pt-3">
      <h3 className="text-sm font-medium text-foreground">{props.title}</h3>
      {props.operations.length === 0 ? (
        <p className="mt-1 text-ui text-muted-foreground">{props.empty}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-ui">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-normal">{props.nameHeading}</th>
                <th className="py-1 pr-3 text-right font-normal">Times</th>
                <th className="py-1 pr-3 text-right font-normal">Total</th>
                <th className="py-1 pr-3 text-right font-normal">Slowest</th>
                <th className="py-1 text-right font-normal">Last</th>
              </tr>
            </thead>
            <tbody>
              {props.operations.map((operation) => (
                <tr key={operation.name} className="border-t border-border align-top">
                  {/* `max-w-0 w-full` gives the name what the number columns leave, in both tables. */}
                  <td
                    className={cn(
                      "w-full max-w-0 py-1 pr-3 text-foreground [overflow-wrap:anywhere]",
                      props.monospace && "font-mono text-xs",
                    )}
                  >
                    {operation.name}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">{operation.count}</td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                    {formatDuration(operation.totalMs)}
                  </td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                    {formatDuration(operation.maxMs)}
                  </td>
                  <td className="py-1 text-right whitespace-nowrap text-muted-foreground">
                    {formatRelativeTimeLabel(operation.lastAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Summary({ health }: { readonly health: ServerHealth }) {
  const facts: ReadonlyArray<readonly [label: string, value: string]> = [
    ["Running for", formatDuration(health.uptimeMs)],
    [
      "Memory",
      `${formatMegabytes(health.rssBytes)} (heap ${formatMegabytes(health.heapUsedBytes)})`,
    ],
    [
      "Event loop delay",
      health.eventLoopDelay
        ? `typical ${formatDelay(health.eventLoopDelay.p50Ms)}, 99th percentile ${formatDelay(health.eventLoopDelay.p99Ms)}, worst ${formatDelay(health.eventLoopDelay.maxMs)}`
        : "Not measured",
    ],
  ];
  return (
    <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-ui">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-foreground tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What has been slow in the server since it started. The server already logs
 * each of these; this shows the totals without reading the log.
 */
export function ServerHealthSettings() {
  const health = useQuery(serverHealthQueryOptions());
  return (
    <SettingsCard
      title="Server health"
      description="What has been slow since the F5 server started. A long event loop delay means the server was busy and everything else waited, including streaming and terminals."
      searchTarget="general.server-health"
      actions={
        <Button
          size="xs"
          variant="outline"
          disabled={health.isFetching}
          onClick={() => void health.refetch()}
        >
          <RefreshCwIcon className="size-3.5" />
          Refresh
        </Button>
      }
    >
      {health.data ? (
        <>
          <Summary health={health.data} />
          <div className="space-y-3">
            <SlowOperations
              title={`Requests that took ${formatThreshold(health.data.slowRouteThresholdMs)} or longer`}
              nameHeading="Request"
              empty="None since the server started."
              operations={health.data.slowRoutes}
            />
            <SlowOperations
              title={`Database statements slower than ${formatThreshold(health.data.slowStatementThresholdMs)}`}
              nameHeading="Statement"
              empty="None since the server started."
              operations={health.data.slowStatements}
              monospace
            />
          </div>
        </>
      ) : (
        <p className="text-ui text-muted-foreground">
          {health.isError ? "Server health could not be loaded." : "Loading…"}
        </p>
      )}
    </SettingsCard>
  );
}
