import type {
  PrHubCheck,
  PrHubCheckLog,
  PrHubCheckRun,
  PrHubCheckStatus,
} from "@t3tools/contracts";

export type PrCheckGroupId = "failed" | "running" | "passed" | "skipped";

export interface PrCheckGroup<Check extends PrHubCheck = PrHubCheck> {
  readonly id: PrCheckGroupId;
  readonly label: string;
  readonly checks: readonly Check[];
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
export function groupPrChecks<Check extends PrHubCheck>(
  checks: readonly Check[],
): PrCheckGroup<Check>[] {
  const sorted = checks.toSorted(
    (a, b) =>
      Number(b.required === true) - Number(a.required === true) || a.name.localeCompare(b.name),
  );
  return GROUP_ORDER.flatMap((id) => {
    const members = sorted.filter((check) => GROUP_OF[check.status] === id);
    return members.length > 0 ? [{ id, label: GROUP_LABELS[id], checks: members }] : [];
  });
}

export interface PrCheckWorkflow {
  /** Null for checks that belong to no workflow: commit statuses and other apps' checks. */
  readonly name: string | null;
  readonly checks: readonly PrHubCheckRun[];
}

/**
 * Splits one outcome group by workflow, in name order, with the checks that belong to no
 * workflow last. The order of the checks inside a workflow is kept.
 */
export function prCheckWorkflows(checks: readonly PrHubCheckRun[]): PrCheckWorkflow[] {
  const byName = new Map<string | null, PrHubCheckRun[]>();
  for (const check of checks) {
    const list = byName.get(check.workflow);
    if (list) list.push(check);
    else byName.set(check.workflow, [check]);
  }
  return [...byName.entries()]
    .toSorted(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([name, members]) => ({ name, checks: members }));
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

/** How long a check ran, or has been running: "42s", "3m 12s", "1h 4m". */
export function prCheckDuration(
  check: Pick<PrHubCheckRun, "startedAt" | "completedAt" | "status">,
  now = Date.now(),
): string | null {
  if (!check.startedAt) return null;
  const end = check.completedAt
    ? Date.parse(check.completedAt)
    : check.status === "pending"
      ? now
      : NaN;
  const seconds = Math.round((end - Date.parse(check.startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Why a check has no log to show, in the reader's words. */
export function prCheckLogUnavailableText(
  reason: NonNullable<PrHubCheckLog["unavailable"]>,
): string {
  switch (reason) {
    case "pending":
      return "The log is available once the job finishes.";
    case "unsupported":
      return "This check does not publish a log F5 can read.";
    case "expired":
      return "The log is no longer available; the forge deletes old logs.";
    case "forbidden":
      return "Your account is not allowed to read this log.";
    case "failed":
      return "The log could not be loaded. It may be too large to show here.";
  }
}

/** The checks worth an agent's attention: failed before cancelled, required ones first. */
export function prFailingChecks(checks: readonly PrHubCheckRun[]): PrHubCheckRun[] {
  return checks
    .filter((check) => check.status === "failure" || check.status === "cancelled")
    .toSorted(
      (a, b) =>
        Number(b.status === "failure") - Number(a.status === "failure") ||
        Number(b.required === true) - Number(a.required === true),
    );
}

/** A few lines of cleanup after the error are enough for a reader who has the rest. */
const LINES_AFTER_ERROR = 5;

/**
 * Shortens a log excerpt to a character budget for a prompt. The explanation of a failure
 * comes before its error marker, so lines are dropped from the top; without a marker the
 * end of the excerpt is kept.
 */
export function prCheckLogTail(
  log: Pick<PrHubCheckLog, "excerpt" | "startLine" | "errorLine">,
  maxLength: number,
): string {
  if (!log.excerpt) return "";
  const lines = log.excerpt.split("\n");
  const errorIndex = log.errorLine === null ? -1 : log.errorLine - log.startLine;
  const end =
    errorIndex >= 0 && errorIndex < lines.length
      ? Math.min(lines.length, errorIndex + 1 + LINES_AFTER_ERROR)
      : lines.length;
  const kept: string[] = [];
  let length = 0;
  for (let index = end - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (length + line.length + 1 > maxLength && kept.length > 0) break;
    kept.unshift(line.slice(0, maxLength));
    length += line.length + 1;
  }
  return kept.join("\n");
}
