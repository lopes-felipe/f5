import { useEffect, useState } from "react";
import { cn } from "../../../lib/utils";

export function QuotaMeter(props: {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  accessibleName: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const remainingMinutes = props.resetsAt
    ? Math.max(0, Math.ceil((Date.parse(props.resetsAt) - now) / 60_000))
    : null;
  const percent =
    props.utilization === null ? undefined : Math.min(100, Math.max(0, props.utilization));
  const remainingPercent = percent === undefined ? undefined : 100 - percent;
  const reset =
    props.resetsAt && Number.isFinite(Date.parse(props.resetsAt))
      ? `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(props.resetsAt))}`
      : "Reset time unavailable";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{props.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {props.utilization === null ? "Unknown" : `${remainingPercent!.toFixed(0)}% remaining`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={props.accessibleName}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent}
        aria-valuetext={
          props.utilization === null ? "Unknown" : `${remainingPercent!.toFixed(0)}% remaining`
        }
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            (percent ?? 0) >= 90 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${remainingPercent ?? 0}%` }}
        />
      </div>
      <p className="text-2xs text-muted-foreground">
        {reset}
        {remainingMinutes !== null && Number.isFinite(remainingMinutes)
          ? ` · ${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m remaining`
          : ""}
      </p>
    </div>
  );
}
