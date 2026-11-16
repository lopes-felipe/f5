import type { DesktopNotificationsBridge } from "@t3tools/contracts";

import { isMacPlatform } from "../lib/utils";
import type { AppNotificationConstructor } from "../notifications";
import type { NotificationTarget } from "./openTarget";

export interface OsNotificationInput {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly tag?: string;
  readonly silent?: boolean;
  /** Any image URL. macOS shows the app icon for desktop notifications instead. */
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
  /**
   * Turns the icon into the PNG data URL the main process can decode, or null to send none.
   * Defaults to rasterizing on Windows and Linux and skipping it on macOS.
   */
  readonly desktopIcon?: (icon: string) => Promise<string | null>;
}

function defaultBridge(): DesktopNotificationsBridge | null {
  return typeof window === "undefined" ? null : (window.desktopBridge?.notifications ?? null);
}

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const DESKTOP_ICON_SIZE = 64;

/** Electron's `nativeImage` only decodes PNG and JPEG, so SVG status glyphs are drawn first. */
async function defaultDesktopIcon(icon: string): Promise<string | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  if (isMacPlatform(navigator.platform)) return null;
  if (icon.startsWith(PNG_DATA_URL_PREFIX)) return icon;
  try {
    const image = new Image();
    image.src = icon;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = DESKTOP_ICON_SIZE;
    canvas.height = DESKTOP_ICON_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, DESKTOP_ICON_SIZE, DESKTOP_ICON_SIZE);
    const png = canvas.toDataURL("image/png");
    return png.startsWith(PNG_DATA_URL_PREFIX) ? png : null;
  } catch {
    return null;
  }
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
    const icon = input.icon
      ? await (deps.desktopIcon ?? defaultDesktopIcon)(input.icon).catch(() => null)
      : null;
    const shown = await bridge
      .show({
        id: input.id,
        title: input.title,
        target: input.target,
        ...(input.body ? { body: input.body } : {}),
        ...(input.tag ? { tag: input.tag } : {}),
        ...(input.silent ? { silent: true } : {}),
        ...(icon ? { icon } : {}),
      })
      .catch(() => false);
    if (shown) return true;
  }
  return presentInBrowser(input, Constructor, deps.onActivate);
}
