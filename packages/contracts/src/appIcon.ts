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
  /** The choice when this window was created. */
  readonly initial: AppIconId;
  set: (id: AppIconId) => Promise<void>;
  onChange: (listener: (id: AppIconId) => void) => () => void;
  /**
   * macOS. True once, across all windows and profiles, after an update changed the
   * built-in icon while the Dock still shows the old one.
   */
  claimDockRefreshPrompt: () => Promise<boolean>;
  /** macOS. Restarts the Dock so it reloads the built-in icon. */
  restartDock: () => Promise<void>;
}
