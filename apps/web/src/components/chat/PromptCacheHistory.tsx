import { cn } from "~/lib/utils";

import {
  formatCacheRatio,
  formatIdle,
  type TurnCacheState,
  type TurnCacheSummary,
} from "./cacheIndicator.logic";
import type { PromptCacheMeterView } from "../../lib/useThreadCacheTurns";

const BAR_TONE: Record<TurnCacheState, string> = {
  warm: "bg-success",
  miss: "bg-warning",
  "cold-start": "bg-muted-foreground/60",
  unreported: "bg-border",
};

/** The newest turns that fit the popup's width; older ones scroll off the left. */
const MAX_BARS = 40;

function barLabel(turn: TurnCacheSummary, index: number): string {
  const position = `Turn ${index + 1}`;
  if (turn.ratio === null) return `${position}: no cache data`;
  const state =
    turn.state === "miss" ? ", cache miss" : turn.state === "cold-start" ? ", first turn" : "";
  return `${position}: ${formatCacheRatio(turn.ratio)} from cache${state}`;
}

function lastTurnText(turn: TurnCacheSummary): string {
  if (turn.ratio === null) return "no cache data";
  if (turn.state === "miss") {
    return turn.idleMs === null ? "miss" : `miss · idle ${formatIdle(turn.idleMs)}`;
  }
  if (turn.state === "cold-start") return "first turn";
  return `${formatCacheRatio(turn.ratio)} from cache`;
}

/**
 * "Prompt cache · this thread": one bar per recorded turn, oldest first, with
 * the overall hit rate. A bar's height is the share of input read from the
 * cache; clicking one scrolls the timeline to that turn's reply.
 */
export function PromptCacheHistory(props: { view: PromptCacheMeterView }) {
  const { summary, canSelectTurn, onSelectTurn } = props.view;
  const offset = Math.max(0, summary.turns.length - MAX_BARS);
  const shown = summary.turns.slice(offset);
  const last = summary.last;
  return (
    <div data-slot="prompt-cache-history" className="space-y-1.5">
      <p className="font-medium text-foreground">Prompt cache · this thread</p>
      <div className="flex h-6 items-end gap-0.5" role="group" aria-label="Prompt cache per turn">
        {shown.map((turn, shownIndex) => {
          const index = offset + shownIndex;
          const selectable = canSelectTurn(turn.turnId);
          const height = turn.ratio === null ? 0.25 : Math.max(0.12, turn.ratio);
          return (
            <button
              key={turn.turnId}
              type="button"
              data-cache-state={turn.state}
              aria-label={barLabel(turn, index)}
              title={barLabel(turn, index)}
              disabled={!selectable}
              onClick={() => onSelectTurn(turn.turnId)}
              className="group/bar flex h-full w-2 shrink-0 items-end rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:cursor-pointer"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "block w-full rounded-xs transition-opacity group-enabled/bar:group-hover/bar:opacity-70",
                  BAR_TONE[turn.state],
                )}
                style={{ height: `${Math.round(height * 100)}%` }}
              />
            </button>
          );
        })}
      </div>
      <p className="text-muted-foreground">
        One bar per turn, oldest first. Click a bar to jump to that turn.
      </p>
      {summary.overallRatio !== null ? (
        <p className="flex justify-between gap-3 text-muted-foreground">
          <span>Overall</span>
          <span className="tabular-nums text-foreground">
            {formatCacheRatio(summary.overallRatio)} from cache
          </span>
        </p>
      ) : null}
      {last ? (
        <p className="flex justify-between gap-3 text-muted-foreground">
          <span>Last turn</span>
          <span
            data-slot="prompt-cache-last-turn"
            className={cn(
              "tabular-nums",
              last.state === "miss" ? "text-warning" : "text-foreground",
            )}
          >
            {lastTurnText(last)}
          </span>
        </p>
      ) : null}
    </div>
  );
}
