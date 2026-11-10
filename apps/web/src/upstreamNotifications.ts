import type { DesktopNotificationsBridge, ProjectId } from "@t3tools/contracts";

import { presentOsNotification } from "./notificationCenter/osNotifications";
import type { AppNotificationConstructor } from "./notifications";

export function formatUpstreamInboxTitle(count: number): string {
  return `Upstream: ${count} new topic${count === 1 ? "" : "s"} to review`;
}

export function showUpstreamInboxNotification(input: {
  NotificationConstructor: AppNotificationConstructor;
  bridge?: DesktopNotificationsBridge | null;
  projectId: ProjectId;
  count: number;
  focusWindow: () => void;
  navigateToUpstream: (projectId: ProjectId) => void | Promise<void>;
}): Promise<boolean> {
  return presentOsNotification(
    {
      id: `upstream:${input.projectId}:${Date.now()}`,
      title: formatUpstreamInboxTitle(input.count),
      tag: `upstream:${input.projectId}`,
      target: { kind: "upstream", projectId: input.projectId },
    },
    {
      NotificationConstructor: input.NotificationConstructor,
      ...(input.bridge !== undefined ? { bridge: input.bridge } : {}),
      onActivate: () => {
        input.focusWindow();
        void input.navigateToUpstream(input.projectId);
      },
    },
  );
}
