import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BaseUpdater as BaseType } from "electron-updater/out/BaseUpdater";
import type { MacUpdater as MacType } from "electron-updater/out/MacUpdater";
import type { NsisUpdater as NsisType } from "electron-updater/out/NsisUpdater";
import type { VerifyUpdateCodeSignature } from "electron-updater";
import { createUpdaterInstallerAdapter } from "./updateInstallerAdapter";
import { createUpdateInstaller } from "./updateInstall";
const require = createRequire(import.meta.url);
const { BaseUpdater } = require("electron-updater/out/BaseUpdater") as {
  BaseUpdater: typeof BaseType;
};
const { NsisUpdater } = require("electron-updater/out/NsisUpdater") as {
  NsisUpdater: typeof NsisType;
};
class NativeBaseUpdater extends BaseUpdater {
  calls = 0;
  constructor() {
    super(null, { version: "0.1.0", quit: vi.fn() } as never);
    this.logger = null;
    this.downloadedUpdateHelper = { file: "installer", downloadedFileInfo: {} } as never;
  }
  get payloadPath() {
    return this.installerPath;
  }
  protected async doDownloadUpdate(): Promise<string[]> {
    throw new Error("Unexpected download in install regression");
  }
  protected doInstall() {
    this.calls++;
    return true;
  }
  // Only the OS quit scheduling is replaced. The real BaseUpdater.install
  // implementation, its downloaded payload, and its attempt guard are exercised.
  override quitAndInstall(silent = false, forceRun = false) {
    this.install(silent, forceRun);
  }
}
it.each(["error", "watchdog"])(
  "resets the real BaseUpdater guard after %s and installs again",
  async (failure) => {
    vi.useFakeTimers();
    try {
      const native = new NativeBaseUpdater();
      const adapter = createUpdaterInstallerAdapter(native, "win32");
      const recover = vi.fn(async () => {});
      const installer = createUpdateInstaller({
        canInstall: () => true,
        confirm: async () => true,
        prepare: async () => true,
        install: adapter.install,
        resetAttempt: adapter.resetAttempt,
        recover,
        timeoutMs: 60_000,
      });
      let recovered: Promise<void> | undefined;
      native.on("error", (error: Error) => {
        recovered = installer.onError(error.message);
      });
      await installer.request();
      expect(native.calls).toBe(1);
      // Prove a retry without the adapter reset really is ignored by 6.8.3.
      native.install();
      expect(native.calls).toBe(1);
      if (failure === "error") {
        native.emit("error", new Error("async installer failure"));
        await recovered;
      } else await vi.advanceTimersByTimeAsync(60_001);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(native.payloadPath).toBe("installer");
      await installer.request();
      expect(native.calls).toBe(2);
      await installer.onError("finish test");
    } finally {
      vi.useRealTimers();
    }
  },
);
describe("Windows update signature check", () => {
  const publisherNames = ["F5"];
  const installerPath = "C:\\updater\\pending\\temp-F5-x64.exe";
  // execFile marks the error killed when the verifier exceeds its 20-second timeout.
  const timedOut = () =>
    Object.assign(new Error("Command failed: powershell.exe"), { killed: true });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  // Runs the real NsisUpdater.verifySignature, which NSIS downloads call and
  // which accepts only null as a valid signature.
  function nsisUpdater(verify: VerifyUpdateCodeSignature) {
    const native = new NsisUpdater(undefined, { version: "0.1.0", quit: vi.fn() } as never);
    native.logger = logger;
    native.verifyUpdateCodeSignature = verify;
    Object.assign(native, { configOnDisk: { value: Promise.resolve({ publisherName: "F5" }) } });
    createUpdaterInstallerAdapter(native, "win32");
    const check = native as unknown as {
      verifySignature(path: string): Promise<string | null>;
    };
    return { native, check: () => check.verifySignature(installerPath) };
  }

  it("retries a timed-out signature check with the same verifier and installer", async () => {
    const verify = vi
      .fn<VerifyUpdateCodeSignature>()
      .mockRejectedValueOnce(timedOut())
      .mockResolvedValueOnce(null);
    const { check } = nsisUpdater(verify);

    await expect(check()).resolves.toBeNull();
    expect(verify.mock.calls).toEqual([
      [publisherNames, installerPath],
      [publisherNames, installerPath],
    ]);
  });

  it.each([
    { name: "an invalid signature", outcome: () => Promise.resolve("Invalid publisher"), calls: 1 },
    {
      name: "another error",
      outcome: () => Promise.reject(new Error("Cannot execute PowerShell")),
      calls: 1,
    },
    { name: "two timeouts", outcome: () => Promise.reject(timedOut()), calls: 2 },
  ])("fails on $name on every download without stacking retries", async ({ outcome, calls }) => {
    const verify = vi.fn<VerifyUpdateCodeSignature>(outcome);
    const { check } = nsisUpdater(verify);

    for (let download = 1; download <= 2; download++) {
      const result = await check().catch((error: unknown) => error);
      expect(result).not.toBeNull();
      expect(verify).toHaveBeenCalledTimes(calls * download);
    }
  });

  it("rejects a retry when the capability probe skips verification", async () => {
    let native: InstanceType<typeof NsisUpdater> | undefined;
    const verify = vi
      .fn<VerifyUpdateCodeSignature>()
      .mockRejectedValueOnce(timedOut())
      .mockImplementationOnce(async () => {
        // electron-updater resolves null even though its failed probe skipped verification.
        native!.logger?.warn(
          "Cannot execute ConvertTo-Json: spawnSync powershell.exe ETIMEDOUT. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.",
        );
        return null;
      });
    const updater = nsisUpdater(verify);
    native = updater.native;

    await expect(updater.check()).resolves.toBe(
      "Signature validation was skipped after a timed-out check.",
    );
    expect(verify).toHaveBeenCalledTimes(2);
    expect(native.logger).toBe(logger);
  });
});
it.each([false, true])(
  "stages using real MacUpdater before cleanup without a handoff timeout (stage error first: %s)",
  async (failFirst) => {
    vi.useFakeTimers();
    const native = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    });
    const electronPath = require.resolve("electron");
    const previous = require.cache[electronPath];
    require.cache[electronPath] = { exports: { autoUpdater: native } } as NodeModule;
    try {
      const { MacUpdater } = require("electron-updater/out/MacUpdater") as {
        MacUpdater: typeof MacType;
      };
      const updater = new MacUpdater(undefined, { version: "0.1.0", quit: vi.fn() } as never);
      updater.logger = null;
      const adapter = createUpdaterInstallerAdapter(updater, "darwin");
      const prepare = vi.fn(async () => true);
      const recover = vi.fn(async () => {});
      const installer = createUpdateInstaller({
        canInstall: () => true,
        confirm: async () => true,
        stage: adapter.stage,
        prepare,
        install: adapter.install,
        resetAttempt: adapter.resetAttempt,
        watchdogEnabled: adapter.watchdogEnabled,
        recover,
      });
      if (failFirst) {
        const failed = installer.request();
        await vi.advanceTimersByTimeAsync(1);
        native.emit("error", new Error("Squirrel staging failed"));
        expect((await failed).completed).toBe(false);
        expect(prepare).not.toHaveBeenCalled();
        // Only MacUpdater's permanent state listener remains. No delayed native
        // update-downloaded event can trigger a quit after failure recovery.
        expect(native.listenerCount("update-downloaded")).toBe(1);
        expect(native.quitAndInstall).not.toHaveBeenCalled();
        recover.mockClear();
        native.checkForUpdates.mockClear();
      }
      const request = installer.request();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      native.emit("update-downloaded");
      await request;
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(native.quitAndInstall).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      if (previous) require.cache[electronPath] = previous;
      else delete require.cache[electronPath];
      vi.useRealTimers();
    }
  },
);
it.each([false, true])(
  "drives real NsisUpdater.quitAndInstall with asynchronous spawn (failure: %s)",
  async (fails) => {
    vi.useFakeTimers();
    const electronPath = require.resolve("electron");
    const previous = require.cache[electronPath];
    const events = new EventEmitter();
    require.cache[electronPath] = { exports: { autoUpdater: events } } as NodeModule;
    try {
      const { NsisUpdater } = require("electron-updater/out/NsisUpdater") as {
        NsisUpdater: typeof import("electron-updater/out/NsisUpdater").NsisUpdater;
      };
      let resolveSpawn!: (value: boolean) => void;
      let rejectSpawn!: (error: Error) => void;
      const spawn = new Promise<boolean>((resolve, reject) => {
        resolveSpawn = resolve;
        rejectSpawn = reject;
      });
      const quit = vi.fn();
      class NativeNsis extends NsisUpdater {
        constructor() {
          super(undefined, { version: "0.1.0", quit } as never);
          this.logger = null;
          this.downloadedUpdateHelper = { file: "installer.exe", downloadedFileInfo: {} } as never;
        }
        protected override spawnLog(): Promise<boolean> {
          return spawn;
        }
      }
      const updater = new NativeNsis();
      const adapter = createUpdaterInstallerAdapter(updater, "win32");
      const recover = vi.fn(async () => {});
      const installer = createUpdateInstaller({
        canInstall: () => true,
        confirm: async () => true,
        prepare: async () => true,
        install: adapter.install,
        resetAttempt: adapter.resetAttempt,
        recover,
        watchdogEnabled: false,
      });
      updater.on("error", (error: Error) => {
        void installer.onError(error.message);
      });
      const request = installer.request();
      await vi.advanceTimersByTimeAsync(1);
      // The real BaseUpdater callback already requested quit, but the launch is unresolved.
      expect(quit).not.toHaveBeenCalled();
      if (fails) rejectSpawn(Object.assign(new Error("spawn failed"), { code: "EACCES" }));
      else resolveSpawn(true);
      expect((await request).completed).toBe(!fails);
      await vi.advanceTimersByTimeAsync(1);
      expect(quit).toHaveBeenCalledTimes(fails ? 0 : 1);
      expect(recover).toHaveBeenCalledTimes(fails ? 1 : 0);
    } finally {
      if (previous) require.cache[electronPath] = previous;
      else delete require.cache[electronPath];
      vi.useRealTimers();
    }
  },
);
it("times out macOS staging without a delayed quit and permits another attempt", async () => {
  vi.useFakeTimers();
  const native = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  const electronPath = require.resolve("electron");
  const previous = require.cache[electronPath];
  require.cache[electronPath] = { exports: { autoUpdater: native } } as NodeModule;
  try {
    const { MacUpdater } = require("electron-updater/out/MacUpdater") as {
      MacUpdater: typeof MacType;
    };
    const updater = new MacUpdater(undefined, { version: "0.1.0" } as never);
    updater.logger = null;
    const adapter = createUpdaterInstallerAdapter(updater, "darwin", { stagingTimeoutMs: 500 });
    const recover = vi.fn(async () => {});
    const installer = createUpdateInstaller({
      canInstall: () => true,
      confirm: async () => true,
      stage: adapter.stage,
      prepare: async () => true,
      install: adapter.install,
      recover,
      watchdogEnabled: false,
    });
    const request = installer.request();
    await vi.advanceTimersByTimeAsync(501);
    expect((await request).completed).toBe(false);
    expect(installer.pending).toBe(false);
    native.emit("update-downloaded");
    expect(native.quitAndInstall).not.toHaveBeenCalled();
    expect((await installer.request()).completed).toBe(true);
    expect(native.quitAndInstall).toHaveBeenCalledTimes(1);
  } finally {
    if (previous) require.cache[electronPath] = previous;
    else delete require.cache[electronPath];
    vi.useRealTimers();
  }
});
