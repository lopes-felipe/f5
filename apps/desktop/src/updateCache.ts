import { access, readFile } from "node:fs/promises";
import * as Path from "node:path";
import { isDebPackage } from "./linuxPackage";

interface ReleaseFile {
  url: string;
  sha512: string;
}

// Match electron-updater's package and Mac architecture selection. Matching
// another artifact in the feed would start an unwanted network download.
export function selectCachedUpdateFile(
  files: readonly ReleaseFile[],
  platform: NodeJS.Platform,
  hostArch: string,
  appArch: string,
  isDebPackage: boolean,
): ReleaseFile | undefined {
  let candidates = files;
  if (platform === "darwin") {
    const preferArm64 = hostArch === "arm64" && files.some((file) => file.url.includes("arm64"));
    candidates = files.filter((file) => file.url.includes("arm64") === preferArm64);
  }
  const extension =
    platform === "darwin"
      ? ".zip"
      : platform === "win32"
        ? ".exe"
        : isDebPackage
          ? ".deb"
          : ".appimage";
  const packages = candidates.filter((file) => file.url.toLowerCase().endsWith(extension));
  return packages.find((file) => file.url.includes(appArch)) ?? packages[0];
}

export async function hasCachedUpdate(
  updater: unknown,
  files: readonly ReleaseFile[],
  runtime: { hostArch: string; appArch: string },
  platform: NodeJS.Platform,
  resourcesPath: string,
): Promise<boolean> {
  try {
    const debPackage = await isDebPackage(platform, resourcesPath);
    const selected = selectCachedUpdateFile(
      files,
      platform,
      runtime.hostArch,
      runtime.appArch,
      debPackage,
    );
    if (!selected) return false;
    // Use the configured updater cache, including custom updaterCacheDirName.
    const helper = await (
      updater as {
        getOrCreateDownloadHelper(): Promise<{ cacheDirForPendingUpdate: string }>;
      }
    ).getOrCreateDownloadHelper();
    const directory = helper.cacheDirForPendingUpdate;
    const info: unknown = JSON.parse(
      await readFile(Path.join(directory, "update-info.json"), "utf8"),
    );
    if (
      typeof info !== "object" ||
      info === null ||
      !("sha512" in info) ||
      info.sha512 !== selected.sha512 ||
      !("fileName" in info) ||
      typeof info.fileName !== "string" ||
      Path.basename(info.fileName) !== info.fileName
    )
      return false;
    await access(Path.join(directory, info.fileName));
    return true;
  } catch {
    // Missing, interrupted, and malformed caches remain click-to-download.
    return false;
  }
}
