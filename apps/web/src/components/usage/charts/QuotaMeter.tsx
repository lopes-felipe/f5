import { cn } from "../../../lib/utils";

export function QuotaMeter(props: {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  accessibleName: string;
}) {
  const percent =
    props.utilization === null ? undefined : Math.min(100, Math.max(0, props.utilization));
  const reset =
    props.resetsAt && Number.isFinite(Date.parse(props.resetsAt))
      ? `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(props.resetsAt))}`
      : "Reset time unavailable";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{props.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {props.utilization === null ? "Unknown" : `${props.utilization.toFixed(0)}% used`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={props.accessibleName}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={props.utilization === null ? "Unknown" : `${props.utilization}% used`}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            (percent ?? 0) >= 90 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{reset}</p>
    </div>
  );
}
