import type { TrackedPullRequest } from "@t3tools/contracts";
import type { AppNotificationConstructor, AppNotificationInstance } from "./notifications";

export function formatPrNotificationTitle(pr: TrackedPullRequest): string {
  return `${pr.primaryReason}: ${pr.repository.nameWithOwner}#${pr.number}`;
}

export function showPrAttentionNotification(input: {
  NotificationConstructor: AppNotificationConstructor;
  pullRequest: TrackedPullRequest;
  focusWindow: () => void;
  navigateToPrHub: (focusedPrKey?: string) => void | Promise<void>;
}): AppNotificationInstance {
  const notification = new input.NotificationConstructor(
    formatPrNotificationTitle(input.pullRequest),
    {
      body: input.pullRequest.nextAction,
      tag: input.pullRequest.key,
      data: { key: input.pullRequest.key },
    },
  );

  notification.addEventListener("click", () => {
    notification.close();
    input.focusWindow();
    void input.navigateToPrHub(input.pullRequest.key);
  });

  return notification;
}
