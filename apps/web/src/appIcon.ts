import {
  AppIconId,
  DEFAULT_APP_ICON_ID,
  type AppIconId as AppIconIdType,
  type DesktopAppIconBridge,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { updateAppSettings, useAppSettingsSelector } from "./appSettings";
import { toastManager } from "./components/ui/toast";

export const APP_ICON_LABELS: Record<AppIconIdType, string> = {
  lines: "Lines",
  classic: "Classic",
  mono: "Mono",
  cobalt: "Cobalt",
  sunrise: "Sunrise",
  cool: "Cool",
  light: "Light",
  blue: "Blue",
  glow: "Glow",
  terminal: "Terminal",
};

/** The generated image of a choice: 256px for the sidebar and picker, 32px for small glyphs. */
export function appIconUrl(id: AppIconIdType, size: 256 | 32): string {
  return `/app-icons/${id}${size === 32 ? "-32" : ""}.png`;
}

const isAppIconId = Schema.is(AppIconId);
const knownId = (id: unknown): AppIconIdType => (isAppIconId(id) ? id : DEFAULT_APP_ICON_ID);

/**
 * The desktop app holds one choice for every window and profile and announces changes.
 * One subscription per bridge keeps the latest id, however many components read it.
 */
let desktopSource: { bridge: DesktopAppIconBridge; id: AppIconIdType; stop: () => void } | null =
  null;
const desktopListeners = new Set<() => void>();

function desktopBridge(): DesktopAppIconBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.appIcon;
}

function connectDesktopSource() {
  const bridge = desktopBridge();
  if (desktopSource?.bridge === bridge) return desktopSource;
  desktopSource?.stop();
  desktopSource = null;
  if (!bridge) return null;
  const source = { bridge, id: knownId(bridge.initial), stop: () => {} };
  source.stop = bridge.onChange((id) => {
    if (!isAppIconId(id) || id === source.id) return;
    source.id = id;
    for (const listener of desktopListeners) listener();
  });
  desktopSource = source;
  return source;
}

function subscribeDesktopSource(listener: () => void): () => void {
  desktopListeners.add(listener);
  connectDesktopSource();
  return () => void desktopListeners.delete(listener);
}

const readDesktopId = (): AppIconIdType | null => connectDesktopSource()?.id ?? null;

/** The chosen app icon: the desktop app's when there is one, this browser's otherwise. */
export function useAppIcon(): {
  readonly id: AppIconIdType;
  readonly setId: (id: AppIconIdType) => void;
} {
  const desktopId = useSyncExternalStore(subscribeDesktopSource, readDesktopId, () => null);
  const browserId = useAppSettingsSelector((settings) => settings.appIcon);
  const setId = useCallback((id: AppIconIdType) => {
    const bridge = desktopBridge();
    if (!bridge) {
      updateAppSettings({ appIcon: id });
      return;
    }
    bridge.set(id).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not change the app icon",
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);
  return { id: desktopId ?? browserId, setId };
}

function showTabIcon(id: AppIconIdType): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  // The default keeps the multi-size favicon the page shipped with.
  const [href, sizes] =
    id === DEFAULT_APP_ICON_ID ? ["/favicon.ico", "48x48"] : [appIconUrl(id, 32), "32x32"];
  link.setAttribute("href", href);
  link.setAttribute("sizes", sizes);
}

/**
 * Keeps the browser tab icon on the chosen app icon and, on macOS, offers once to restart
 * a Dock that still shows the icon from before an update.
 */
export function AppIconEffects(): null {
  const { id } = useAppIcon();
  useEffect(() => showTabIcon(id), [id]);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    // Not cancelled on unmount: the claim is spent once made, so its toast must still show.
    void bridge
      .claimDockRefreshPrompt()
      .then((claimed) => {
        if (!claimed) return;
        toastManager.add({
          type: "info",
          // An offer, so it stays until answered or dismissed.
          timeout: 0,
          title: "F5 has a new icon",
          description:
            "The Dock is still showing the old one. Notification banners update after your next login.",
          actionProps: {
            children: "Restart Dock",
            onClick: () => {
              bridge.restartDock().catch((error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: "Could not restart the Dock",
                  description: error instanceof Error ? error.message : String(error),
                });
              });
            },
          },
        });
      })
      .catch((error: unknown) => console.warn("[app-icon] Dock check failed", error));
  }, []);
  return null;
}
