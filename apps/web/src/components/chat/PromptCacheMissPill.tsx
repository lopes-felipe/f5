import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatCompactTokens, formatExactTokens } from "./composer/contextMeter.logic";
import { formatCacheRatio, formatIdle, type TurnCacheSummary } from "./cacheIndicator.logic";

const HOVER_DELAY_MS = 150;

const BREAKDOWN = [
  { key: "cacheReadTokens", label: "Read from cache", tone: "bg-success" },
  { key: "cacheWriteTokens", label: "Written to cache", tone: "bg-warning" },
  { key: "uncachedInputTokens", label: "Uncached input", tone: "bg-primary" },
] as const;

/**
 * The amber pill beside a reply's timestamp when its turn missed the prompt
 * cache, with the turn's token breakdown on hover or click.
 */
export function PromptCacheMissPill(props: { turn: TurnCacheSummary }) {
  const { turn } = props;
  const parts = [
    "Cache miss",
    turn.rewrittenTokens !== null
      ? `rewrote ${formatCompactTokens(turn.rewrittenTokens)} tokens`
      : null,
    turn.idleMs !== null ? `idle ${formatIdle(turn.idleMs)}` : null,
  ].filter((part): part is string => part !== null);
  const inputTotal = turn.cacheReadTokens + turn.cacheWriteTokens + turn.uncachedInputTokens;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={HOVER_DELAY_MS}
        closeDelay={HOVER_DELAY_MS}
        data-slot="prompt-cache-miss"
        className="ms-1.5 inline-flex h-5 items-center gap-1.5 rounded-full border border-warning/50 bg-warning/12 px-2 align-middle text-2xs text-foreground outline-none transition-colors hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-warning/20"
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
        {parts.join(" · ")}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" sideOffset={6} className="w-72 leading-tight">
        <div data-slot="prompt-cache-breakdown" className="space-y-2 text-xs">
          <p className="flex justify-between gap-3 font-medium text-foreground">
            <span>Prompt cache</span>
            <span className="font-normal text-muted-foreground">
              this turn
              {turn.ratio !== null ? ` · ${formatCacheRatio(turn.ratio)} from cache` : ""}
            </span>
          </p>
          {inputTotal > 0 ? (
            <div className="flex h-2 overflow-hidden rounded-full bg-border" aria-hidden="true">
              {BREAKDOWN.map((part) => (
                <span
                  key={part.key}
                  className={part.tone}
                  style={{ width: `${(turn[part.key] / inputTotal) * 100}%` }}
                />
              ))}
            </div>
          ) : null}
          <div className="space-y-0.5">
            {BREAKDOWN.map((part) => (
              <p key={part.key} className="flex justify-between gap-3 tabular-nums">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden="true" className={`size-1.5 rounded-full ${part.tone}`} />
                  {part.label}
                </span>
                <span className="text-foreground">{formatExactTokens(turn[part.key])}</span>
              </p>
            ))}
            <p className="flex justify-between gap-3 tabular-nums">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground" />
                Output
              </span>
              <span className="text-foreground">{formatExactTokens(turn.outputTokens)}</span>
            </p>
          </div>
          <p className="text-muted-foreground">
            Totals for the whole turn, so one cold request in a turn that was otherwise cached won't
            show on its own.
            {turn.idleMs !== null
              ? ` The previous turn ended ${formatIdle(turn.idleMs)} before this one started.`
              : ""}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
