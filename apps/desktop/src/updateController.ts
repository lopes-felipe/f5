import { getUpdateErrorMessage } from "./updateErrors";
import type {
  DesktopUpdateActionResult,
  DesktopUpdateChannel,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { electronUpdaterChannelSettings } from "./updateChannel";
import {
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnUpdateAvailable,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnDownloadFailure,
} from "./updateMachine";

export interface UpdaterPort {
  check(): Promise<{
    version: string;
    releaseNotes: string | null;
    cachedDownload?: boolean;
  } | null>;
  download(): Promise<unknown>;
  applySettings(settings: {
    channel: string;
    allowPrerelease: boolean;
    allowDowngrade: false;
  }): void;
}
export function createUpdateController(options: {
  port: UpdaterPort;
  getState(): DesktopUpdateState;
  emit(state: DesktopUpdateState): void;
  writePreferences(channel: DesktopUpdateChannel): void;
  timeoutMs?: number;
  isQuitting?(): boolean;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  let pendingManual = false;
  let pendingCheck: Promise<DesktopUpdateActionResult> | null = null;
  // electron-updater coalesces native checks internally. After a timeout, drain that
  // request before starting another, so a channel change cannot reuse its result.
  let activePortCheck: ReturnType<UpdaterPort["check"]> | null = null;
  const result = (accepted: boolean): DesktopUpdateActionResult => ({
    accepted,
    completed: accepted && options.getState().status !== "error",
    state: options.getState(),
  });
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  const applyChannel = (channel: DesktopUpdateChannel) =>
    options.port.applySettings({
      ...electronUpdaterChannelSettings(channel),
      allowDowngrade: false,
    });
  async function check(isManual: () => boolean = () => true): Promise<DesktopUpdateActionResult> {
    const state = options.getState();
    if (
      !state.enabled ||
      state.status === "downloaded" ||
      state.status === "downloading" ||
      state.status === "preparing"
    )
      return result(false);
    options.emit(reduceDesktopUpdateStateOnCheckStart(state));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const runPortCheck = async () => {
      while (activePortCheck) {
        await activePortCheck.catch(() => undefined);
        if (expired) return null;
      }
      if (expired) return null;
      const request = options.port.check();
      activePortCheck = request;
      try {
        return await request;
      } finally {
        if (activePortCheck === request) activePortCheck = null;
      }
    };
    try {
      const info = await Promise.race([
        runPortCheck(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error("Update check timed out. Try again."));
          }, options.timeoutMs ?? 30_000);
        }),
      ]);
      clearTimeout(timer);
      const now = new Date().toISOString();
      options.emit(
        info
          ? reduceDesktopUpdateStateOnUpdateAvailable(
              options.getState(),
              info.version,
              now,
              info.releaseNotes,
            )
          : reduceDesktopUpdateStateOnNoUpdate(options.getState(), now),
      );
      if (info?.cachedDownload) {
        // Release the check slot first. Previously queued channel changes take
        // precedence, and a slow cache validation/download cannot hold pendingCheck.
        void enqueue(async () => {
          const current = options.getState();
          if (
            current.channel !== state.channel ||
            current.status !== "available" ||
            current.availableVersion !== info.version ||
            current.downloadedVersion === info.version
          )
            return;
          await download();
        });
      }
    } catch (error) {
      options.emit(
        reduceDesktopUpdateStateOnCheckFailure(
          options.getState(),
          getUpdateErrorMessage(error, "check"),
          new Date().toISOString(),
          isManual(),
        ),
      );
    } finally {
      clearTimeout(timer);
    }
    return result(true);
  }
  async function download(): Promise<DesktopUpdateActionResult> {
    if (options.isQuitting?.() || options.getState().status !== "available") return result(false);
    options.emit(reduceDesktopUpdateStateOnDownloadStart(options.getState()));
    try {
      await options.port.download();
      return result(true);
    } catch (error) {
      options.emit(
        reduceDesktopUpdateStateOnDownloadFailure(
          options.getState(),
          getUpdateErrorMessage(error, "download"),
        ),
      );
      return { ...result(true), completed: false };
    }
  }
  return {
    applyChannel,
    requestCheck(reason: string) {
      pendingManual ||= !["startup", "poll"].includes(reason);
      if (!pendingCheck)
        pendingCheck = enqueue(() => check(() => pendingManual)).finally(() => {
          pendingCheck = null;
          pendingManual = false;
        });
      return pendingCheck;
    },
    download() {
      return enqueue(download);
    },
    setChannel(channel: DesktopUpdateChannel) {
      if (["downloading", "preparing"].includes(options.getState().status))
        return Promise.resolve(result(false));
      return enqueue(async () => {
        if (channel !== "stable" && channel !== "beta") throw new Error("Invalid update channel");
        options.writePreferences(channel);
        applyChannel(channel);
        const state = options.getState();
        options.emit({
          ...state,
          channel,
          ...(!state.enabled || state.status === "downloaded"
            ? {}
            : { status: "idle", availableVersion: null, releaseNotes: null }),
        });
        return !state.enabled || state.status === "downloaded" ? result(true) : check();
      });
    },
  };
}
