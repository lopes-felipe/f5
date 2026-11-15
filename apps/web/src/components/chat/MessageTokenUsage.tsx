import type { ThreadId, TurnId, UsageThreadTurn } from "@t3tools/contracts";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useThreadCacheTurns } from "../../lib/useThreadCacheTurns";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usageTableClasses } from "../usage/kit";
import { formatUsageTokens, turnTokenUsage } from "./tokenUsage.logic";

interface ThreadUsageView {
  byTurnId: ReadonlyMap<TurnId, UsageThreadTurn>;
}
const ThreadUsageContext = createContext<ThreadUsageView | null>(null);

/** One shared query and event subscription for the footers, independent of cache indicator settings. */
export function ThreadTokenUsageProvider(props: {
  threadId: ThreadId | null;
  children: ReactNode;
}) {
  const history = useThreadCacheTurns(props.threadId, true);
  const value = useMemo<ThreadUsageView | null>(
    () =>
      history
        ? {
            byTurnId: new Map(history.turns.map((turn) => [turn.turnId, turn])),
          }
        : null,
    [history],
  );
  return <ThreadUsageContext value={value}>{props.children}</ThreadUsageContext>;
}

function TokenValue(props: {
  label: string;
  value: number | null | undefined;
  estimated?: boolean | undefined;
  partial?: boolean | undefined;
  emphasis?: boolean;
}) {
  return (
    <tr className={cn(usageTableClasses.compactRow, props.emphasis && "bg-muted/40 font-medium")}>
      <th
        scope="row"
        className={cn(
          usageTableClasses.compactCell,
          "py-1.5 pl-2 text-left",
          !props.emphasis && "font-normal",
        )}
      >
        {props.label}
      </th>
      <td
        className={cn(
          usageTableClasses.compactCell,
          usageTableClasses.numeric,
          "whitespace-nowrap py-1.5 pr-2",
        )}
      >
        {props.value == null
          ? "Not reported"
          : (props.estimated ? "~" : "") + formatUsageTokens(props.value)}
        {props.partial && props.value != null ? " (partial)" : ""}
      </td>
    </tr>
  );
}

export function MessageTokenUsage(props: {
  turnId?: TurnId | null | undefined;
  reasoningTokens?: number | undefined;
  reasoningEstimated?: boolean | undefined;
  streaming: boolean;
}) {
  const history = useContext(ThreadUsageContext);
  const turn = props.turnId ? history?.byTurnId.get(props.turnId) : undefined;
  const usage = turn ? turnTokenUsage(turn) : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {usage?.total != null
          ? `${formatUsageTokens(usage.total)} tokens${usage.partial ? " (partial)" : ""}`
          : props.streaming
            ? "Tokens: Pending"
            : "Tokens: Not reported"}
      </TooltipTrigger>
      <TooltipPopup side="top" className="w-80 max-w-[calc(100vw-2rem)] whitespace-normal">
        <div className="space-y-2 py-1 text-xs">
          <div className="flex items-baseline justify-between gap-3 px-2">
            <p className="text-sm font-medium">Token usage</p>
            <span className="text-2xs text-muted-foreground">This turn</span>
          </div>
          <table aria-label="Token usage for this turn" className={usageTableClasses.table}>
            <thead className={usageTableClasses.head}>
              <tr>
                <th scope="col" className={cn(usageTableClasses.compactHeadCell, "pl-2")}>
                  Metric
                </th>
                <th
                  scope="col"
                  className={cn(
                    usageTableClasses.compactHeadCell,
                    usageTableClasses.numeric,
                    "pr-2",
                  )}
                >
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>
              <TokenValue label="Input" value={usage?.input} partial={usage?.inputPartial} />
              <TokenValue label="Output" value={usage?.output} />
              <TokenValue
                label={usage?.partial ? "Partial total" : "Total"}
                value={usage?.total}
                emphasis
              />
            </tbody>
            <tbody className="text-muted-foreground">
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={2}
                  className="px-2 pt-3 pb-1 text-left text-2xs font-medium"
                >
                  Included in input
                </th>
              </tr>
              <TokenValue label="Cache read" value={turn?.cacheReadTokens} />
              <TokenValue label="Cache write" value={turn?.cacheWriteTokens} />
            </tbody>
            <tbody className="text-muted-foreground">
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={2}
                  className="px-2 pt-3 pb-1 text-left text-2xs font-medium"
                >
                  Included in output
                </th>
              </tr>
              <TokenValue
                label="Reasoning"
                value={props.reasoningTokens}
                estimated={props.reasoningEstimated}
              />
            </tbody>
          </table>
          {usage?.partial ? (
            <p className="border-t border-border/50 px-2 pt-2 text-2xs text-muted-foreground">
              Some usage is not reported. The partial total includes known tokens only.
            </p>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
