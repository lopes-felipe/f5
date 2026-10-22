import type { ProjectId } from "@t3tools/contracts";

import type { AppNotificationConstructor, AppNotificationInstance } from "./notifications";

export function formatUpstreamInboxTitle(count: number): string {
  return `Upstream: ${count} new topic${count === 1 ? "" : "s"} to review`;
}

export function showUpstreamInboxNotification(input: {
  NotificationConstructor: AppNotificationConstructor;
  projectId: ProjectId;
  count: number;
  focusWindow: () => void;
  navigateToUpstream: (projectId: ProjectId) => void | Promise<void>;
}): AppNotificationInstance {
  const notification = new input.NotificationConstructor(formatUpstreamInboxTitle(input.count), {
    tag: `upstream:${input.projectId}`,
    data: { projectId: input.projectId },
  });
  notification.addEventListener("click", () => {
    notification.close();
    input.focusWindow();
    void input.navigateToUpstream(input.projectId);
  });
  return notification;
}
