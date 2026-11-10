import type { DesktopNotificationsBridge, TrackedPullRequest } from "@t3tools/contracts";

import { presentOsNotification } from "./notificationCenter/osNotifications";
import type { AppNotificationConstructor } from "./notifications";

export function formatPrNotificationTitle(pr: TrackedPullRequest): string {
  return `${pr.primaryReason}: ${pr.repository.nameWithOwner}#${pr.number}`;
}

export function showPrAttentionNotification(input: {
  NotificationConstructor: AppNotificationConstructor;
  bridge?: DesktopNotificationsBridge | null;
  pullRequest: TrackedPullRequest;
  batch?: { id: string; count: number };
  focusWindow: () => void;
  navigateToPrHub: (focusedPrKey?: string) => void | Promise<void>;
}): Promise<boolean> {
  const grouped = input.batch !== undefined && input.batch.count > 1;
  const focusedKey = grouped ? undefined : input.pullRequest.key;
  return presentOsNotification(
    {
      id: `pr:${input.batch?.id ?? input.pullRequest.key}:${Date.now()}`,
      title: grouped
        ? `${input.batch!.count} pull requests need your attention`
        : formatPrNotificationTitle(input.pullRequest),
      body: input.pullRequest.nextAction,
      tag: input.batch?.id ?? input.pullRequest.key,
      target: focusedKey ? { kind: "prHub", prKey: focusedKey } : { kind: "prHub" },
    },
    {
      NotificationConstructor: input.NotificationConstructor,
      ...(input.bridge !== undefined ? { bridge: input.bridge } : {}),
      onActivate: () => {
        input.focusWindow();
        void input.navigateToPrHub(focusedKey);
      },
    },
  );
}
