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
  uncached: "bg-border",
  unreported: "bg-border",
};

/**
 * Only the newest turns get a bar; older ones are left out, and their count is
 * shown instead. Bars shrink to share the row, so at the popup's width each
 * stays a few pixels wide and the newest is never clipped.
 */
const MAX_BARS = 40;

const STATE_SUFFIX: Partial<Record<TurnCacheState, string>> = {
  miss: ", cache miss",
  "cold-start": ", first turn",
  uncached: ", caching not in use",
};

function barLabel(turn: TurnCacheSummary): string {
  const position = `Turn ${turn.turnNumber}`;
  if (turn.ratio === null) return `${position}: no cache data`;
  return `${position}: ${formatCacheRatio(turn.ratio)} from cache${STATE_SUFFIX[turn.state] ?? ""}`;
}

function lastTurnText(turn: TurnCacheSummary): string {
  if (turn.ratio === null) return "no cache data";
  if (turn.state === "miss") {
    return turn.idleMs === null ? "miss" : `miss · idle ${formatIdle(turn.idleMs)}`;
  }
  if (turn.state === "cold-start") return "first turn";
  if (turn.state === "uncached") return "caching not in use";
  return `${formatCacheRatio(turn.ratio)} from cache`;
}

/**
 * "Prompt cache · this thread": one bar per recorded turn, oldest first, with
 * the overall hit rate. A bar's height is the share of input read from the
 * cache; clicking one scrolls the timeline to that turn's reply.
 */
export function PromptCacheHistory(props: { view: PromptCacheMeterView }) {
  const { summary, canSelectTurn, onSelectTurn } = props.view;
  const shown = summary.turns.slice(-MAX_BARS);
  const hiddenTurns = (shown[0]?.turnNumber ?? 1) - 1;
  const last = summary.last;
  return (
    <div data-slot="prompt-cache-history" className="space-y-1.5">
      <p className="font-medium text-foreground">Prompt cache · this thread</p>
      <div className="flex h-6 items-end gap-0.5" role="group" aria-label="Prompt cache per turn">
        {shown.map((turn) => {
          const selectable = canSelectTurn(turn.turnId);
          const height = turn.ratio === null ? 0.25 : Math.max(0.12, turn.ratio);
          return (
            <button
              key={turn.turnId}
              type="button"
              data-cache-state={turn.state}
              aria-label={barLabel(turn)}
              title={barLabel(turn)}
              disabled={!selectable}
              onClick={() => onSelectTurn(turn.turnId)}
              className="group/bar flex h-full min-w-0 max-w-2 flex-1 items-end rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:cursor-pointer"
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
        One bar per turn, oldest first
        {hiddenTurns > 0
          ? ` (${hiddenTurns} earlier ${hiddenTurns === 1 ? "turn" : "turns"} not shown)`
          : ""}
        . Click a bar to jump to that turn.
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
