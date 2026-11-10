import type { TrackedPullRequest } from "@t3tools/contracts";

import type { ToastItemTone } from "./components/ui/toast";
import type { NotifyInput } from "./notificationCenter/notify";

export function formatPrNotificationTitle(pr: TrackedPullRequest): string {
  return `${pr.primaryReason}: ${pr.repository.nameWithOwner}#${pr.number}`;
}

const PR_TOAST_ITEM_LIMIT = 3;

function prItemTone(pr: TrackedPullRequest): ToastItemTone {
  return pr.attentionState === "ci_failing" ||
    pr.attentionState === "merge_conflict" ||
    pr.attentionState === "changes_requested"
    ? "destructive"
    : "warning";
}

/** One PR is a single notice; a batch lists the first few as rows that open each PR. */
export function buildPrAttentionNotification(
  batch: { batchId: string; pullRequests: readonly TrackedPullRequest[] },
  navigateToPrHub: (focusedPrKey?: string) => void | Promise<void>,
): NotifyInput {
  const pr = batch.pullRequests[0]!;
  const count = batch.pullRequests.length;
  const os = {
    tag: batch.batchId,
    title: count > 1 ? `${count} pull requests need your attention` : formatPrNotificationTitle(pr),
    body: pr.nextAction,
  };
  if (count === 1) {
    return {
      source: "pr",
      severity: "attention",
      title: formatPrNotificationTitle(pr),
      body: pr.nextAction,
      sourceLabel: "Pull requests",
      dedupeKey: `pr:${pr.key}`,
      target: { kind: "prHub", prKey: pr.key },
      openLabel: "View",
      os,
    };
  }
  return {
    source: "pr",
    severity: "attention",
    title: `${count} pull requests need you`,
    sourceLabel: "Pull requests",
    dedupeKey: `pr-batch:${batch.batchId}`,
    items: batch.pullRequests.slice(0, PR_TOAST_ITEM_LIMIT).map((item) => ({
      id: item.key,
      label: `${item.repository.nameWithOwner}#${item.number}`,
      trailing: item.primaryReason,
      tone: prItemTone(item),
      target: { kind: "prHub", prKey: item.key },
    })),
    moreCount: Math.max(0, count - PR_TOAST_ITEM_LIMIT),
    target: { kind: "prHub" },
    actions: [
      { label: "Mark seen", onClick: () => undefined },
      {
        label: "Open hub",
        variant: "primary",
        onClick: () => void navigateToPrHub(),
      },
    ],
    os,
  };
}
