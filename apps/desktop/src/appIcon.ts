import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { APP_ICON_IDS, DEFAULT_APP_ICON_ID, type AppIconId } from "@t3tools/contracts";
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";

export const APP_ICON_SET_CHANNEL = "desktop:app-icon-set";
export const APP_ICON_CHANGED_CHANNEL = "desktop:app-icon-changed";
export const APP_ICON_CLAIM_DOCK_PROMPT_CHANNEL = "desktop:app-icon-claim-dock-prompt";
export const APP_ICON_DISMISS_DOCK_PROMPT_CHANNEL = "desktop:app-icon-dismiss-dock-prompt";
export const APP_ICON_RESTART_DOCK_CHANNEL = "desktop:app-icon-restart-dock";
/** Synchronous: preload reads the current choice every time a page loads, reloads included. */
export const APP_ICON_GET_CHANNEL = "desktop:app-icon-get";
/** Window argument carrying the choice, so a new window never shows the default first. */
export const APP_ICON_ARGUMENT = "f5-app-icon";
/**
 * How the Dock tile plug-in (native/dock-tile/F5DockTile.m) learns the choice, so a pinned
 * Dock icon keeps it while F5 is quit: the id under this key in the app's own preferences,
 * then a distributed notification named by the app's bundle id plus this suffix, carrying
 * the id again in its userInfo under DOCK_TILE_CHOICE_USER_INFO_KEY.
 */
export const DOCK_TILE_CHOICE_KEY = "F5AppIcon";
export const DOCK_TILE_CHANGED_SUFFIX = ".app-icon-changed";
export const DOCK_TILE_CHOICE_USER_INFO_KEY = "id";

/**
 * The first release with the current built-in artwork (#953 landed just after beta.42 was
 * cut), and when it was published: no installation can have taken the artwork earlier.
 */
const CURRENT_ARTWORK_VERSION = "0.1.12-beta.47";
const CURRENT_ARTWORK_SINCE = Date.parse("2026-11-26T10:16:59Z");
/** A restarted Dock drops the icon a running app set, so the choice is set again. */
const DOCK_RESTART_REAPPLY_DELAYS_MS = [1500, 5000];

export type AppIconFile = "macos.png" | "linux.png" | "windows.ico";

/** The contents of `app-icon.json`. */
export interface AppIconState {
  readonly id: AppIconId;
  /**
   * The built-in icon last seen, and when it was first seen to differ from the one
   * before it. `changedAt` is null when it has never changed on this installation.
   */
  readonly bundle: { readonly hash: string; readonly changedAt: number | null } | null;
  /** The `changedAt` the Dock restart was last offered for. */
  readonly promptedFor: number | null;
}

export const INITIAL_APP_ICON_STATE: AppIconState = {
  id: DEFAULT_APP_ICON_ID,
  bundle: null,
  promptedFor: null,
};

export function isAppIconId(value: unknown): value is AppIconId {
  return (APP_ICON_IDS as readonly unknown[]).includes(value);
}

const timestamp = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Unknown or missing values fall back field by field, so one bad field keeps the rest. */
export function parseAppIconState(value: unknown): AppIconState {
  if (typeof value !== "object" || value === null) return INITIAL_APP_ICON_STATE;
  const { id, bundle, promptedFor } = value as Record<string, unknown>;
  const { hash, changedAt } = (
    typeof bundle === "object" && bundle !== null ? bundle : {}
  ) as Record<string, unknown>;
  return {
    id: isAppIconId(id) ? id : DEFAULT_APP_ICON_ID,
    bundle: typeof hash === "string" && hash ? { hash, changedAt: timestamp(changedAt) } : null,
    promptedFor: timestamp(promptedFor),
  };
}

export function readAppIconState(path: string): AppIconState {
  try {
    return parseAppIconState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return INITIAL_APP_ICON_STATE;
  }
}

export function writeAppIconState(path: string, state: AppIconState): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state));
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function isOlderVersion(version: string, than: string): boolean {
  try {
    return compareCliReleaseVersions(version, than) < 0;
  } catch {
    return false;
  }
}

/**
 * When the built-in icon last changed under a Dock that may still show the old one.
 * Null means it never has, as on a fresh installation.
 */
export function bundleIconChangedAt(input: {
  readonly stored: AppIconState["bundle"];
  readonly hash: string;
  readonly now: number;
  /**
   * When this version was installed, when known. Without it, this launch stands in for
   * the install, and a Dock that restarted in between is wrongly taken for stale.
   */
  readonly installedAt: number | null;
  /** The version this launch was updated from, when it follows an update. */
  readonly updatedFrom: string | null;
  /** Whether F5 had run on this machine before this launch. */
  readonly existingInstallation: boolean;
}): number | null {
  const installedAt = Math.min(input.installedAt ?? input.now, input.now);
  if (input.stored) return input.stored.hash === input.hash ? input.stored.changedAt : installedAt;
  if (input.updatedFrom !== null && isOlderVersion(input.updatedFrom, CURRENT_ARTWORK_VERSION))
    return installedAt;
  // Installations that took the new artwork before F5 recorded icon changes.
  return input.existingInstallation ? CURRENT_ARTWORK_SINCE : null;
}

/** Seconds from `ps -o etime=`, formatted `[[dd-]hh:]mm:ss`. */
export function parseElapsedSeconds(etime: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return ((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!;
}

/**
 * When this user's Dock process started, or null when that cannot be read. With fast user
 * switching, every logged-in user has a Dock.
 */
export async function readDockStartedAt(
  run: (file: string, args: readonly string[]) => Promise<string>,
  now: number,
  uid: number,
): Promise<number | null> {
  try {
    const pid = (await run("/usr/bin/pgrep", ["-x", "-U", String(uid), "Dock"]))
      .trim()
      .split(/\s+/)[0];
    if (!pid || !/^\d+$/.test(pid)) return null;
    const elapsed = parseElapsedSeconds(await run("/bin/ps", ["-o", "etime=", "-p", pid]));
    return elapsed === null ? null : now - elapsed * 1000;
  } catch {
    return null;
  }
}

/** A Dock that started before the built-in icon changed still shows the old one. */
export function isDockStale(changedAt: number | null, dockStartedAt: number | null): boolean {
  return changedAt !== null && dockStartedAt !== null && dockStartedAt < changedAt;
}

export interface AppIconPorts {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readState(): AppIconState;
  writeState(state: AppIconState): void;
  /** The absolute path of a generated icon file, or null when it is missing. */
  iconPath(id: AppIconId, file: AppIconFile): string | null;
  setDockIcon(path: string): void;
  /** Puts the bundle's own icon back in the Dock. */
  restoreDockIcon(): void;
  /** Records the choice for the Dock tile plug-in and tells it to look. */
  publishDockChoice(id: AppIconId): void;
  setWindowIcons(path: string): void;
  /** Tells every app window of every profile about the new choice. */
  broadcast(id: AppIconId): void;
  restartDock(): Promise<void>;
  later(run: () => void, delayMs: number): void;
  log(message: string): void;
}

export interface StaleDockInput {
  /** A hash of the bundle's own icon, or null when it cannot be read. */
  readonly bundleIconHash: string | null;
  readonly installedAt: number | null;
  readonly updatedFrom: string | null;
  readonly existingInstallation: boolean;
  readonly now: number;
  readDockStartedAt(): Promise<number | null>;
}

export function createAppIconController(ports: AppIconPorts) {
  let state = ports.readState();
  let dockStale = false;
  let staleDockDetection: Promise<void> = Promise.resolve();
  /** The window showing the Dock restart offer, by its web contents id. */
  let promptShownBy: number | null = null;
  const isMac = ports.platform === "darwin";

  /** For bookkeeping only: a failed write is logged and the session carries on. */
  const persist = (next: AppIconState) => {
    state = next;
    try {
      ports.writeState(next);
    } catch (error) {
      ports.log(`Could not save the app icon state: ${String(error)}`);
    }
  };
  const setDockIcon = () => {
    const path = ports.iconPath(state.id, "macos.png");
    if (path) ports.setDockIcon(path);
  };
  /**
   * Only a packaged macOS app carries the plug-in. A failure costs the icon shown while F5
   * is quit, never the one shown now, so it is logged and the change carries on.
   */
  const publishDockChoice = () => {
    if (!isMac || !ports.isPackaged) return;
    try {
      ports.publishDockChoice(state.id);
    } catch (error) {
      ports.log(`Could not record the app icon for the Dock: ${String(error)}`);
    }
  };
  /** The bundle's own icon renders best, so a packaged app only overrides it when it must. */
  const dockNeedsOverride = () =>
    !ports.isPackaged || state.id !== DEFAULT_APP_ICON_ID || dockStale;
  const applyDockIcon = () => (dockNeedsOverride() ? setDockIcon() : ports.restoreDockIcon());
  const windowIconPath = (): string | null =>
    isMac
      ? null
      : ports.iconPath(state.id, ports.platform === "win32" ? "windows.ico" : "linux.png");
  const promptPending = () => {
    const changedAt = state.bundle?.changedAt ?? null;
    return dockStale && changedAt !== null && state.promptedFor !== changedAt;
  };
  /** The offer has been answered: it is not made again for this icon change. */
  const settlePrompt = () => {
    promptShownBy = null;
    const changedAt = state.bundle?.changedAt ?? null;
    if (changedAt !== null && state.promptedFor !== changedAt)
      persist({ ...state, promptedFor: changedAt });
  };

  return {
    id: (): AppIconId => state.id,
    /** The icon new windows take; macOS windows have none. */
    windowIconPath,
    applyAtLaunch(): void {
      if (isMac && dockNeedsOverride()) setDockIcon();
      // Every launch, so the plug-in's record recovers if it was lost or never written.
      publishDockChoice();
    },
    /** Once more at quit, the moment the Dock starts drawing the plug-in's tile. */
    publishDockChoiceAtQuit: publishDockChoice,
    set(id: unknown): void {
      if (!isAppIconId(id)) throw new Error("Unknown app icon");
      if (id !== state.id) {
        // Saved first: a choice that cannot be saved would be lost at the next launch, so
        // it is refused, nothing changes, and choosing it again tries the save again.
        const next = { ...state, id };
        try {
          ports.writeState(next);
        } catch (error) {
          ports.log(`Could not save the app icon choice: ${String(error)}`);
          throw new Error("The app icon choice could not be saved", { cause: error });
        }
        state = next;
      }
      publishDockChoice();
      if (isMac) applyDockIcon();
      else {
        const path = windowIconPath();
        if (path) ports.setWindowIcons(path);
      }
      ports.broadcast(id);
    },
    /**
     * Packaged macOS only: notes when the built-in icon changed, and covers a Dock that
     * still shows the old one by setting the icon from the running app.
     */
    detectStaleDock(input: StaleDockInput): Promise<void> {
      if (!isMac || !ports.isPackaged || input.bundleIconHash === null) return staleDockDetection;
      const hash = input.bundleIconHash;
      staleDockDetection = (async () => {
        const changedAt = bundleIconChangedAt({ ...input, hash, stored: state.bundle });
        if (state.bundle?.hash !== hash || state.bundle.changedAt !== changedAt)
          persist({ ...state, bundle: { hash, changedAt } });
        dockStale = isDockStale(changedAt, await input.readDockStartedAt());
        if (dockStale) setDockIcon();
      })();
      return staleDockDetection;
    },
    /**
     * Whether the calling window should offer to restart the Dock: one window at a time,
     * and the same one again after it reloads. The offer only counts as made once the
     * person answers it, so a window that closes first leaves it for another.
     */
    async claimDockRefreshPrompt(callerId: number): Promise<boolean> {
      await staleDockDetection;
      if (!promptPending()) return false;
      if (promptShownBy !== null && promptShownBy !== callerId) return false;
      promptShownBy = callerId;
      return true;
    },
    /** The person closed the offer without restarting the Dock. */
    dismissDockRefreshPrompt(callerId: number): void {
      if (promptShownBy === callerId) settlePrompt();
    },
    /** A window went away; if it held the offer, another window may make it. */
    releaseCaller(callerId: number): void {
      if (promptShownBy === callerId) promptShownBy = null;
    },
    /** Only from the window showing the offer, and only while the Dock is still stale. */
    async restartDock(callerId: number): Promise<void> {
      if (!isMac) throw new Error("Only macOS has a Dock to restart");
      if (!promptPending() || promptShownBy !== callerId)
        throw new Error("No Dock restart is pending");
      settlePrompt();
      await ports.restartDock();
      dockStale = false;
      for (const delay of DOCK_RESTART_REAPPLY_DELAYS_MS)
        ports.later(() => {
          if (dockNeedsOverride()) setDockIcon();
        }, delay);
    },
  };
}

export type AppIconController = ReturnType<typeof createAppIconController>;

/** What the IPC handlers need from an Electron IPC event. */
export interface AppIconCaller {
  readonly sender: { readonly id: number };
}

/** Every handler checks its caller first: only an app window's main frame may use them. */
export function registerAppIconIpc<Event extends AppIconCaller>(
  ipc: {
    removeHandler(channel: string): void;
    handle(channel: string, listener: (event: Event, ...args: unknown[]) => unknown): void;
    removeAllListeners(channel: string): void;
    on(channel: string, listener: (event: Event & { returnValue?: unknown }) => void): void;
  },
  controller: Pick<
    AppIconController,
    "id" | "set" | "claimDockRefreshPrompt" | "dismissDockRefreshPrompt" | "restartDock"
  >,
  assertCaller: (event: Event) => void,
): void {
  const handlers: Record<string, (caller: number, ...args: unknown[]) => unknown> = {
    [APP_ICON_SET_CHANNEL]: (_caller, id) => controller.set(id),
    [APP_ICON_CLAIM_DOCK_PROMPT_CHANNEL]: (caller) => controller.claimDockRefreshPrompt(caller),
    [APP_ICON_DISMISS_DOCK_PROMPT_CHANNEL]: (caller) => controller.dismissDockRefreshPrompt(caller),
    [APP_ICON_RESTART_DOCK_CHANNEL]: (caller) => controller.restartDock(caller),
  };
  for (const [channel, run] of Object.entries(handlers)) {
    ipc.removeHandler(channel);
    ipc.handle(channel, async (event, ...args) => {
      assertCaller(event);
      return run(event.sender.id, ...args);
    });
  }
  // A synchronous reply must always be set, or the calling page hangs.
  ipc.removeAllListeners(APP_ICON_GET_CHANNEL);
  ipc.on(APP_ICON_GET_CHANNEL, (event) => {
    try {
      assertCaller(event);
      event.returnValue = controller.id();
    } catch {
      event.returnValue = null;
    }
  });
}

/** Writes the choice where the Dock tile plug-in reads it, and tells the plug-in. */
export function createDockChoicePublisher(
  preferences: {
    setUserDefault(key: string, type: "string", value: string): void;
    postNotification(
      event: string,
      userInfo: Record<string, unknown>,
      deliverImmediately?: boolean,
    ): void;
  },
  bundleId: string,
): (id: AppIconId) => void {
  return (id) => {
    preferences.setUserDefault(DOCK_TILE_CHOICE_KEY, "string", id);
    preferences.postNotification(
      `${bundleId}${DOCK_TILE_CHANGED_SUFFIX}`,
      { [DOCK_TILE_CHOICE_USER_INFO_KEY]: id },
      true,
    );
  };
}
