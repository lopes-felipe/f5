import type { PrHubCheck, PrHubCheckStatus } from "@t3tools/contracts";

export type PrCheckGroupId = "failed" | "running" | "passed" | "skipped";

export interface PrCheckGroup {
  readonly id: PrCheckGroupId;
  readonly label: string;
  readonly checks: readonly PrHubCheck[];
}

const GROUP_OF: Record<PrHubCheckStatus, PrCheckGroupId> = {
  failure: "failed",
  cancelled: "failed",
  pending: "running",
  success: "passed",
  neutral: "skipped",
  skipped: "skipped",
};

const GROUP_LABELS: Record<PrCheckGroupId, string> = {
  failed: "Failed",
  running: "Running",
  passed: "Passed",
  skipped: "Skipped",
};

const GROUP_ORDER: readonly PrCheckGroupId[] = ["failed", "running", "passed", "skipped"];

/** What blocks comes first: failed, then running, then passed and skipped. Empty groups are left out. */
export function groupPrChecks(checks: readonly PrHubCheck[]): PrCheckGroup[] {
  const sorted = checks.toSorted(
    (a, b) =>
      Number(b.required === true) - Number(a.required === true) || a.name.localeCompare(b.name),
  );
  return GROUP_ORDER.flatMap((id) => {
    const members = sorted.filter((check) => GROUP_OF[check.status] === id);
    return members.length > 0 ? [{ id, label: GROUP_LABELS[id], checks: members }] : [];
  });
}

export function prCheckStatusLabel(status: PrHubCheckStatus): string {
  switch (status) {
    case "success":
      return "Passed";
    case "failure":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "pending":
      return "Running";
    case "neutral":
      return "Neutral";
    case "skipped":
      return "Skipped";
  }
}

/** "2 failed, 1 running, 14 passed": the tab's one-line summary. */
export function prChecksSummary(checks: readonly PrHubCheck[]): string {
  return groupPrChecks(checks)
    .map((group) => `${group.checks.length} ${group.label.toLowerCase()}`)
    .join(", ");
}
