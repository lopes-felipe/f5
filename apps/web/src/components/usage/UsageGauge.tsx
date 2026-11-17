import { cn } from "../../lib/utils";

const clampUsage = (percent: number | null) =>
  percent !== null && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;

/** Spoken and tooltip text for reported weekly consumption. */
export function describeWeeklyUsage(percent: number | null): string {
  const used = clampUsage(percent);
  return used === null ? "Weekly usage unavailable" : Math.round(used) + "% of weekly limit used";
}

/**
 * A speedometer whose needle moves only when reported weekly consumption changes. It is
 * decorative: the control that hosts it carries `describeWeeklyUsage` in its accessible name,
 * since a progressbar nested in a button is never announced.
 */
export function UsageGauge({ percent }: { readonly percent: number | null }) {
  const used = clampUsage(percent);
  return (
    <span
      aria-hidden="true"
      data-slot="usage-gauge"
      data-used={used === null ? undefined : used}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center",
        used !== null && used >= 100
          ? "text-destructive"
          : used !== null && used >= 90
            ? "text-warning"
            : "text-muted-foreground",
      )}
    >
      <svg
        viewBox="0 -0.5 24 24"
        className="size-full"
        style={{ margin: 0 }}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path data-slot="usage-gauge-dial" d="M3.34 19a10 10 0 1 1 17.32 0" />
        <g
          data-slot="usage-gauge-needle"
          style={{
            transformBox: "view-box",
            // The dial's optical center is y=11.5; its needle still pivots at (12,14).
            transformOrigin: "50% 60.416667%",
            transform: "rotate(" + ((used ?? 0) * 2.4 - 120) + "deg)",
            opacity: used === null ? 0 : 1,
          }}
          className="motion-safe:transition-[transform,opacity] motion-safe:duration-500 motion-safe:ease-out"
        >
          <path d="M12 14V7" />
        </g>
        <circle
          cx="12"
          cy="14"
          r="1"
          fill="currentColor"
          stroke="none"
          opacity={used === null ? 0 : 1}
        />
      </svg>
    </span>
  );
}
