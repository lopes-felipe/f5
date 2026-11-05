import { cn } from "../../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { CodexDailyTokenDay } from "../codexDailyTokens";

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function exactTokens(tokens: string): string {
  try {
    return BigInt(tokens).toLocaleString();
  } catch {
    return tokens;
  }
}

/**
 * Daily Codex account tokens as columns: in-range days in the primary color, earlier
 * days muted, the peak ringed. No y axis; the stat tiles above carry the scale.
 */
export function DailyTokenBars(props: {
  readonly days: ReadonlyArray<CodexDailyTokenDay>;
  readonly peakDate: string | null;
}) {
  const max = Math.max(1, ...props.days.map((day) => day.value));
  const middle = props.days[Math.floor((props.days.length - 1) / 2)];
  return (
    <figure className="space-y-1.5" aria-label="Daily account tokens (UTC)">
      <div
        aria-hidden="true"
        className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground"
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary" />
          Daily tokens in range (UTC)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-muted-foreground/35" />
          Before range
        </span>
      </div>
      <div
        aria-hidden="true"
        data-testid="daily-token-bars"
        className="flex h-24 items-end gap-0.5 border-b border-border"
      >
        {props.days.map((day) => (
          <Tooltip key={day.date}>
            <TooltipTrigger
              render={
                <div
                  data-testid="daily-token-bar"
                  data-in-range={day.inRange ? "true" : "false"}
                  className="flex h-full min-w-0 flex-1 items-end"
                />
              }
            >
              <div
                className={cn(
                  "w-full rounded-t-sm",
                  day.inRange ? "bg-primary" : "bg-muted-foreground/35",
                  day.date === props.peakDate &&
                    "outline-2 outline-offset-1 outline-foreground outline-solid",
                )}
                style={{ height: `max(2px, ${(day.value / max) * 100}%)` }}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {dayLabel(day.date)} · {exactTokens(day.tokens)} tokens
              {day.reported ? "" : " (not reported)"}
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
      <div aria-hidden="true" className="flex justify-between text-2xs text-muted-foreground">
        <span>{dayLabel(props.days[0]!.date)}</span>
        {middle && props.days.length > 2 ? <span>{dayLabel(middle.date)}</span> : null}
        <span>{dayLabel(props.days.at(-1)!.date)}</span>
      </div>
      <table className="sr-only">
        <caption>Daily account tokens (UTC)</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {props.days.map((day) => (
            <tr key={day.date}>
              <td>{dayLabel(day.date)}</td>
              <td>{day.reported ? exactTokens(day.tokens) : "Not reported"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
