import type { DesktopNotificationsBridge } from "@t3tools/contracts";

import type { AppNotificationConstructor } from "../notifications";
import type { NotificationTarget } from "./openTarget";

export interface OsNotificationInput {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly tag?: string;
  readonly silent?: boolean;
  /** Only the browser path shows it; macOS shows the app icon for desktop notifications. */
  readonly icon?: string;
  readonly target: NotificationTarget;
}

export interface OsNotificationDeps {
  /** Defaults to the desktop bridge when F5 runs in its desktop shell. */
  readonly bridge?: DesktopNotificationsBridge | null;
  /** Defaults to `window.Notification`; the browser path for web and remote clients. */
  readonly NotificationConstructor?: AppNotificationConstructor | null;
  /** Runs when the browser notification is clicked. Desktop clicks arrive as activations. */
  readonly onActivate: (target: NotificationTarget) => void;
}

function defaultBridge(): DesktopNotificationsBridge | null {
  return typeof window === "undefined" ? null : (window.desktopBridge?.notifications ?? null);
}

function defaultConstructor(): AppNotificationConstructor | null {
  return typeof window === "undefined" || typeof window.Notification === "undefined"
    ? null
    : window.Notification;
}

function presentInBrowser(
  input: OsNotificationInput,
  Constructor: AppNotificationConstructor | null,
  onActivate: (target: NotificationTarget) => void,
): boolean {
  if (!Constructor) return false;
  try {
    const notification = new Constructor(input.title, {
      ...(input.body ? { body: input.body } : {}),
      ...(input.tag ? { tag: input.tag } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.silent ? { silent: true } : {}),
      data: { id: input.id, target: input.target },
    });
    notification.addEventListener("click", () => {
      notification.close();
      onActivate(input.target);
    });
    return true;
  } catch {
    // OS presentation may be unavailable even after permission was granted.
    return false;
  }
}

/**
 * Shows an OS notification. On desktop the main process owns it, so its click still opens the
 * target after a reload, a closed window, or from Notification Center.
 */
export async function presentOsNotification(
  input: OsNotificationInput,
  deps: OsNotificationDeps,
): Promise<boolean> {
  const bridge = deps.bridge === undefined ? defaultBridge() : deps.bridge;
  const Constructor =
    deps.NotificationConstructor === undefined
      ? defaultConstructor()
      : deps.NotificationConstructor;
  if (bridge) {
    const shown = await bridge
      .show({
        id: input.id,
        title: input.title,
        target: input.target,
        ...(input.body ? { body: input.body } : {}),
        ...(input.tag ? { tag: input.tag } : {}),
        ...(input.silent ? { silent: true } : {}),
      })
      .catch(() => false);
    if (shown) return true;
  }
  return presentInBrowser(input, Constructor, deps.onActivate);
}
