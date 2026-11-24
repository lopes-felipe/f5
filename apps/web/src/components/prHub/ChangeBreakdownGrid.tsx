import type { PrHubChangeBreakdown } from "@t3tools/contracts";

export function ChangeBreakdownGrid({
  breakdown,
  additions,
  deletions,
}: {
  breakdown: PrHubChangeBreakdown;
  additions: number;
  deletions: number;
}) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-1 tabular-nums">
      {Object.entries(breakdown)
        .filter(([, value]) => value.additions || value.deletions)
        .map(([kind, value]) => (
          <div key={kind} className="contents">
            <span className="capitalize">{kind}</span>
            <span className="text-success-foreground">+{value.additions}</span>
            <span className="text-destructive-foreground">−{value.deletions}</span>
          </div>
        ))}
      <span>Total</span>
      <span>+{additions}</span>
      <span>−{deletions}</span>
    </div>
  );
}
