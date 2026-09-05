import type { UsageBucket } from "@t3tools/contracts";
import { cn } from "../../../lib/utils";
import { ChartLegend, TOKEN_SEGMENTS } from "./ChartLegend";

export function StackedBarChart({
  buckets,
  label,
  timeZone,
}: {
  buckets: ReadonlyArray<UsageBucket>;
  label: string;
  timeZone: string;
}) {
  const columns = buckets.map((bucket) => {
    const segments = TOKEN_SEGMENTS.map((segment) => ({
      ...segment,
      value: bucket.composition?.[segment.key] ?? 0,
    }));
    const sum = segments.reduce((total, segment) => total + segment.value, 0);
    return {
      bucket,
      segments:
        sum > 0
          ? segments
          : [
              {
                key: "total",
                label: "Total",
                color: "bg-primary/70",
                value: bucket.metrics.totalTokens,
              },
            ],
      total: sum || bucket.metrics.totalTokens,
    };
  });
  const max = Math.max(0, ...columns.map((column) => column.total));
  if (!max)
    return (
      <div className="flex h-44 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        No token totals were reported in this range.
      </div>
    );
  return (
    <>
      <div
        role="img"
        aria-label={`${label} (${timeZone})`}
        className="flex h-52 items-end gap-1 overflow-hidden rounded-lg border border-border/70 bg-muted/20 px-2 pt-4 pb-2"
      >
        {columns.map(({ bucket, segments, total }, index) => (
          <div
            key={bucket.key}
            className="flex min-w-0 flex-1 flex-col items-center justify-end self-stretch"
            title={`${bucket.label} (${timeZone}): ${segments.map((s) => `${s.label}: ${s.value.toLocaleString()}`).join(", ")} tokens`}
          >
            <div className="relative flex w-full flex-1 items-end">
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm"
                style={{ height: `${total === 0 ? 0 : Math.max(2, (total / max) * 100)}%` }}
              >
                {segments.map((segment) => (
                  <div
                    key={segment.key}
                    className={`w-full ${segment.color}`}
                    style={{ height: `${total ? (segment.value / total) * 100 : 0}%` }}
                  />
                ))}
              </div>
            </div>
            <span
              className={cn(
                "mt-1 h-4 max-w-full truncate text-[9px] text-muted-foreground",
                !(
                  buckets.length <= 24 ||
                  index === 0 ||
                  index === buckets.length - 1 ||
                  index % Math.ceil(buckets.length / 8) === 0
                ) && "invisible",
              )}
            >
              {bucket.label}
            </span>
          </div>
        ))}
      </div>
      <ChartLegend />
    </>
  );
}
