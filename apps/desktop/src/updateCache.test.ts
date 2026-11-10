import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { createHash } from "node:crypto";
// Private boundaries below are checked against electron-updater 6.8.3.
// Keep real selection and disk validation; replace only network/OS boundaries.
import { AppImageUpdater } from "electron-updater/out/AppImageUpdater.js";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";
import { describe, expect, it, vi } from "vitest";
import { hasCachedUpdate, selectCachedUpdateFile } from "./updateCache";

const files = [
  "arm64.dmg",
  "x64.dmg",
  "arm64.zip",
  "x64.zip",
  "x64.exe",
  "x64.deb",
  "x64.AppImage",
].map((extension) => ({ url: "F5-" + extension, sha512: extension }));

describe("cached installer recovery", () => {
  it("restores readiness using the installed updater's disk validation without network download", async () => {
    const directory = await mkdtemp(Path.join(tmpdir(), "f5-native-update-"));
    const filename = "F5-x64.AppImage";
    const sha512 = createHash("sha512").update("installer bytes").digest("base64");
    const info = {
      version: "1.2.4",
      releaseDate: "2026-10-01T00:00:00Z",
      files: [{ url: filename, sha512 }],
      path: filename,
      sha512,
    };
    const feed = vi.spyOn(GenericProvider.prototype, "getLatestVersion").mockResolvedValue(info);
    try {
      const configPath = Path.join(directory, "app-update.yml");
      await writeFile(configPath, "updaterCacheDirName: custom-cache\n");
      const pending = Path.join(directory, "custom-cache", "pending");
      await mkdir(pending, { recursive: true });
      await writeFile(Path.join(pending, filename), "installer bytes");
      await writeFile(
        Path.join(pending, "update-info.json"),
        JSON.stringify({ fileName: filename, sha512, isAdminRightsRequired: false }),
      );
      const updater = new AppImageUpdater(undefined, {
        version: "1.2.3",
        name: "F5",
        isPackaged: true,
        appUpdateConfigPath: configPath,
        userDataPath: directory,
        baseCachePath: directory,
        whenReady: () => Promise.resolve(),
        relaunch: vi.fn(),
        quit: vi.fn(),
        onQuit: vi.fn(),
      });
      updater.logger = null;
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.setFeedURL({ provider: "generic", url: "https://example.invalid/" });
      vi.spyOn(updater, "isUpdaterActive").mockReturnValue(true);
      const download = vi.fn(() => Promise.reject(new Error("unexpected network download")));
      Object.assign(updater, { httpExecutor: { download } });
      const downloaded = vi.fn();
      updater.on("update-downloaded", downloaded);
      expect((await updater.checkForUpdates())?.isUpdateAvailable).toBe(true);
      expect(
        await hasCachedUpdate(
          updater,
          info.files,
          { hostArch: "x64", appArch: "x64" },
          "linux",
          directory,
        ),
      ).toBe(true);
      await updater.downloadUpdate();
      expect(downloaded).toHaveBeenCalledTimes(1);
      expect(download).not.toHaveBeenCalled();
    } finally {
      feed.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    ["darwin", "x64", "x64", false, "x64.zip"],
    ["darwin", "arm64", "x64", false, "arm64.zip"],
    ["darwin", "arm64", "arm64", false, "arm64.zip"],
    ["win32", "x64", "x64", false, "x64.exe"],
    ["linux", "x64", "x64", true, "x64.deb"],
    ["linux", "x64", "x64", false, "x64.AppImage"],
  ] as const)("selects the native package for %s %s %s", (platform, host, app, deb, selected) => {
    expect(selectCachedUpdateFile(files, platform, host, app, deb)?.sha512).toBe(selected);
  });
  it("prefers the app architecture over a universal or other-architecture package listed first", () => {
    const mixed = ["universal.zip", "x64.zip", "arm64.zip"].map((url) => ({ url, sha512: url }));
    expect(selectCachedUpdateFile(mixed, "darwin", "x64", "x64", false)?.url).toBe("x64.zip");
    expect(selectCachedUpdateFile(mixed, "darwin", "arm64", "x64", false)?.url).toBe("arm64.zip");
    const windows = ["arm64.exe", "x64.exe"].map((url) => ({ url, sha512: url }));
    expect(selectCachedUpdateFile(windows, "win32", "x64", "x64", false)?.url).toBe("x64.exe");
  });

  it("uses the configured cache and ignores missing, incomplete and unrelated artifacts", async () => {
    const directory = await mkdtemp(Path.join(tmpdir(), "f5-update-cache-"));
    try {
      const pending = Path.join(directory, "custom-cache", "pending");
      await mkdir(pending, { recursive: true });
      const updater = {
        getOrCreateDownloadHelper: async () => ({ cacheDirForPendingUpdate: pending }),
      };
      const inspect = () =>
        hasCachedUpdate(updater, files, { hostArch: "arm64", appArch: "x64" }, "darwin", directory);
      expect(await inspect()).toBe(false);
      await writeFile(Path.join(pending, "update-info.json"), "{");
      expect(await inspect()).toBe(false);
      const metadata = (sha512: string) =>
        writeFile(
          Path.join(pending, "update-info.json"),
          JSON.stringify({ fileName: "update.zip", sha512 }),
        );
      await metadata("arm64.zip");
      expect(await inspect()).toBe(false);
      await writeFile(Path.join(pending, "update.zip"), "cached bytes");
      expect(await inspect()).toBe(true);
      await metadata("x64.zip");
      expect(await inspect()).toBe(false);
      await metadata("older-release");
      expect(await inspect()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
