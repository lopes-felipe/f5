import { Schema } from "effect";

/**
 * The app icons people can choose in Settings > Appearance, default first.
 * `scripts/generate-brand-assets.py` draws one set of files per id.
 */
export const APP_ICON_IDS = [
  "lines",
  "classic",
  "mono",
  "cobalt",
  "sunrise",
  "cool",
  "light",
  "blue",
  "glow",
  "terminal",
] as const;
export const AppIconId = Schema.Literals(APP_ICON_IDS);
export type AppIconId = typeof AppIconId.Type;
export const DEFAULT_APP_ICON_ID: AppIconId = "lines";

/** One choice for the whole desktop app: every profile shares the Dock or taskbar icon. */
export interface DesktopAppIconBridge {
  /** The choice when this page loaded. */
  readonly initial: AppIconId;
  /** The latest choice, kept current from the moment the page loaded. */
  current: () => AppIconId;
  /** Rejects, changing nothing, when the choice cannot be saved. */
  set: (id: AppIconId) => Promise<void>;
  onChange: (listener: (id: AppIconId) => void) => () => void;
  /**
   * macOS. Whether this window should offer to restart the Dock, because an update changed
   * the built-in icon while the Dock still shows the old one. True for one window at a
   * time, until the offer is answered with `dismissDockRefreshPrompt` or `restartDock`.
   */
  claimDockRefreshPrompt: () => Promise<boolean>;
  /** macOS. The person closed the offer: it is not made again for this icon change. */
  dismissDockRefreshPrompt: () => Promise<void>;
  /** macOS. Restarts the Dock so it reloads the built-in icon; only while offered here. */
  restartDock: () => Promise<void>;
}
