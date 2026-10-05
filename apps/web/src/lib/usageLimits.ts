import type { UsageAccounts } from "@t3tools/contracts";

/** Formats the cached snapshot only; callers must use refresh: "none". */
export function formatUsageLimits(accounts: UsageAccounts): string {
  const remaining = (label: string, used: number | null) =>
    `${label}: ${used === null ? "unknown" : `${Math.max(0, 100 - used).toFixed(0)}% remaining`}`;
  return (
    accounts
      .map((account) => {
        const windows = account.sections.flatMap((section) => {
          if (section.kind === "provider-limits" && section.snapshot)
            return section.snapshot.data.windows.map((window) =>
              remaining(window.label, window.usedPercent),
            );
          if (section.kind === "claude-usage" && section.snapshot)
            return section.snapshot.data.windows.map((window) =>
              remaining(window.label, window.utilization),
            );
          if (section.kind === "codex-limits" && section.snapshot)
            return section.snapshot.data.rateLimits
              .filter((limit) => limit.id === "codex")
              .flatMap((limit) => [limit.primary, limit.secondary])
              .flatMap((window) =>
                window
                  ? [
                      remaining(
                        window.windowDurationMins === 10080 ? "Weekly" : "Session",
                        window.usedPercent,
                      ),
                    ]
                  : [],
              );
          return [];
        });
        return `${account.displayName}: ${windows.join(", ") || "Unavailable"}`;
      })
      .join("; ") || "No account snapshots available."
  );
}
