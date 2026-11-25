import type { UsageMetrics } from "@t3tools/contracts";
import { formatUsd } from "./format";

type Segment = { label: string; value: number; color: string };

function CostBar({ title, segments }: { title: string; segments: readonly Segment[] }) {
  const visible = segments.filter(({ value }) => value > 0);
  const total = visible.reduce((sum, { value }) => sum + value, 0);
  if (total === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">{title}</p>
      <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-muted">
        {visible.map(({ label, value, color }) => (
          <span key={label} className={color} style={{ width: `${(value / total) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {visible.map(({ label, value, color }) => (
          <li key={label} className="flex items-center gap-1.5 tabular-nums">
            <span aria-hidden="true" className={`size-2 rounded-sm ${color}`} />
            {label} {formatUsd(value)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function UsageCostBreakdown({ metrics }: { metrics: UsageMetrics }) {
  const breakdown = metrics.costBreakdown;
  if (!breakdown) return null;
  const { byType, bySpeed, speedPremiumUsd } = breakdown;
  return (
    <div className="space-y-4">
      <CostBar
        title="Cost by type"
        segments={[
          { label: "Input", value: byType.input, color: "bg-primary" },
          { label: "Output", value: byType.output, color: "bg-info" },
          { label: "Cache read", value: byType.cacheRead, color: "bg-success" },
          { label: "Cache write", value: byType.cacheWrite, color: "bg-warning" },
          { label: "Unattributed", value: byType.unattributed, color: "bg-muted-foreground" },
        ]}
      />
      <CostBar
        title="Cost by speed"
        segments={[
          { label: "Standard", value: bySpeed.standard, color: "bg-primary" },
          { label: "Fast", value: bySpeed.fast, color: "bg-info" },
          { label: "Ultrafast", value: bySpeed.ultrafast, color: "bg-warning" },
          { label: "Unknown", value: bySpeed.unknown, color: "bg-muted-foreground" },
        ]}
      />
      {speedPremiumUsd > 0 ? (
        <p className="text-xs text-muted-foreground">
          Estimated speed premium {formatUsd(speedPremiumUsd)}
        </p>
      ) : null}
    </div>
  );
}
