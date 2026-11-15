import { cn } from "../../lib/utils";

/** A quota meter, animated only when its reported consumption changes. */
export function UsageRing({ percent }: { readonly percent: number | null }) {
  const used =
    percent !== null && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
  const description =
    used === null ? "Weekly usage unavailable" : Math.round(used) + "% of weekly limit used";
  return (
    <span
      role="progressbar"
      aria-label="Weekly usage"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={used ?? undefined}
      aria-valuetext={description}
      title={description}
      className={cn(
        "inline-flex size-4 shrink-0",
        used !== null && used >= 100
          ? "text-destructive"
          : used !== null && used >= 90
            ? "text-warning"
            : "text-primary",
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="size-full -rotate-90"
        fill="none"
        strokeWidth="3"
      >
        <circle cx="10" cy="10" r="8" stroke="currentColor" className="text-muted" />
        <circle
          cx="10"
          cy="10"
          r="8"
          pathLength="100"
          stroke="currentColor"
          strokeLinecap="round"
          strokeDasharray="100"
          strokeDashoffset={100 - (used ?? 0)}
          opacity={used === null || used === 0 ? 0 : 1}
          className="motion-safe:transition-[stroke-dashoffset,opacity] motion-safe:duration-500 motion-safe:ease-out"
        />
      </svg>
    </span>
  );
}
