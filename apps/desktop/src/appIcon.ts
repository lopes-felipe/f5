import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { APP_ICON_IDS, DEFAULT_APP_ICON_ID, type AppIconId } from "@t3tools/contracts";
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";

export const APP_ICON_SET_CHANNEL = "desktop:app-icon-set";
export const APP_ICON_CHANGED_CHANNEL = "desktop:app-icon-changed";
export const APP_ICON_CLAIM_DOCK_PROMPT_CHANNEL = "desktop:app-icon-claim-dock-prompt";
export const APP_ICON_RESTART_DOCK_CHANNEL = "desktop:app-icon-restart-dock";
/** Window argument carrying the choice, so a new window never shows the default first. */
export const APP_ICON_ARGUMENT = "f5-app-icon";

/** The first build with the current built-in artwork, and when that artwork landed. */
const CURRENT_ARTWORK_VERSION = "0.1.12-beta.42";
const CURRENT_ARTWORK_SINCE = Date.parse("2026-11-26T08:07:02Z");
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
  /** The version this launch was updated from, when it follows an update. */
  readonly updatedFrom: string | null;
  /** Whether F5 had run on this machine before this launch. */
  readonly existingInstallation: boolean;
}): number | null {
  if (input.stored) return input.stored.hash === input.hash ? input.stored.changedAt : input.now;
  if (input.updatedFrom !== null && isOlderVersion(input.updatedFrom, CURRENT_ARTWORK_VERSION))
    return input.now;
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

/** When the Dock process started, or null when that cannot be read. */
export async function readDockStartedAt(
  run: (file: string, args: readonly string[]) => Promise<string>,
  now: number,
): Promise<number | null> {
  try {
    const pid = (await run("/usr/bin/pgrep", ["-x", "Dock"])).trim().split(/\s+/)[0];
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
  readonly updatedFrom: string | null;
  readonly existingInstallation: boolean;
  readonly now: number;
  readDockStartedAt(): Promise<number | null>;
}

export function createAppIconController(ports: AppIconPorts) {
  let state = ports.readState();
  let dockStale = false;
  let staleDockDetection: Promise<void> = Promise.resolve();
  const isMac = ports.platform === "darwin";

  const persist = (next: AppIconState) => {
    state = next;
    try {
      ports.writeState(next);
    } catch (error) {
      ports.log(`Could not save the app icon choice: ${String(error)}`);
    }
  };
  const setDockIcon = () => {
    const path = ports.iconPath(state.id, "macos.png");
    if (path) ports.setDockIcon(path);
  };
  /** The bundle's own icon renders best, so a packaged app only overrides it when it must. */
  const dockNeedsOverride = () =>
    !ports.isPackaged || state.id !== DEFAULT_APP_ICON_ID || dockStale;
  const windowIconPath = (): string | null =>
    isMac
      ? null
      : ports.iconPath(state.id, ports.platform === "win32" ? "windows.ico" : "linux.png");

  return {
    id: (): AppIconId => state.id,
    /** The icon new windows take; macOS windows have none. */
    windowIconPath,
    applyAtLaunch(): void {
      if (isMac && dockNeedsOverride()) setDockIcon();
    },
    set(id: unknown): void {
      if (!isAppIconId(id)) throw new Error("Unknown app icon");
      if (id !== state.id) persist({ ...state, id });
      if (isMac) setDockIcon();
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
    /** True once per icon change, for the one window that offers to restart the Dock. */
    async claimDockRefreshPrompt(): Promise<boolean> {
      await staleDockDetection;
      const changedAt = state.bundle?.changedAt ?? null;
      if (!dockStale || changedAt === null || state.promptedFor === changedAt) return false;
      persist({ ...state, promptedFor: changedAt });
      return true;
    },
    async restartDock(): Promise<void> {
      if (!isMac) throw new Error("Only macOS has a Dock to restart");
      await ports.restartDock();
      dockStale = false;
      if (dockNeedsOverride())
        for (const delay of DOCK_RESTART_REAPPLY_DELAYS_MS) ports.later(setDockIcon, delay);
    },
  };
}

export type AppIconController = ReturnType<typeof createAppIconController>;

/** Every handler checks its caller first: only an app window's main frame may use them. */
export function registerAppIconIpc<Event>(
  ipc: {
    removeHandler(channel: string): void;
    handle(channel: string, listener: (event: Event, ...args: unknown[]) => unknown): void;
  },
  controller: Pick<AppIconController, "set" | "claimDockRefreshPrompt" | "restartDock">,
  assertCaller: (event: Event) => void,
): void {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    [APP_ICON_SET_CHANNEL]: (id) => controller.set(id),
    [APP_ICON_CLAIM_DOCK_PROMPT_CHANNEL]: () => controller.claimDockRefreshPrompt(),
    [APP_ICON_RESTART_DOCK_CHANNEL]: () => controller.restartDock(),
  };
  for (const [channel, run] of Object.entries(handlers)) {
    ipc.removeHandler(channel);
    ipc.handle(channel, async (event, ...args) => {
      assertCaller(event);
      return run(...args);
    });
  }
}
