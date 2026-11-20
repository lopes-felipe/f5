import type { AntigravityReleaseAsset } from "./antigravityRelease";

export const ANTIGRAVITY_CLI_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

export function antigravityCliTarget(platform: NodeJS.Platform, arch: string) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch))
    return null;
  return (platform === "win32" ? "windows" : platform) + "_" + (arch === "x64" ? "amd64" : arch);
}

export function parseAntigravityCliRelease(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  if (!value || typeof value !== "object" || !antigravityCliTarget(platform, arch)) return null;
  const manifest = value as Record<string, unknown>;
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    typeof manifest.url !== "string" ||
    typeof manifest.sha512 !== "string" ||
    !/^[a-f0-9]{128}$/i.test(manifest.sha512)
  )
    return null;
  const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  const folder =
    (platform === "win32" ? "windows" : platform) + "-" + (arch === "arm64" ? "arm" : "x64");
  const filename =
    "cli_" +
    os +
    "_" +
    (arch === "x64" ? "x64" : "arm64") +
    (platform === "win32" ? ".exe" : ".tar.gz");
  const prefix =
    "https://storage.googleapis.com/antigravity-public/antigravity-cli/" + manifest.version + "-";
  const rest = manifest.url.startsWith(prefix) ? manifest.url.slice(prefix.length) : "";
  if (!/^\d+\//.test(rest) || rest.replace(/^\d+\//, "") !== folder + "/" + filename) return null;
  return {
    version: manifest.version,
    url: manifest.url,
    sha512: manifest.sha512.toLowerCase(),
    archiveBytes: 1024 * 1024 * 1024,
    archiveSizeUnknown: true,
    format: platform === "win32" ? "executable" : "tar.gz",
    executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
  };
}

export async function lookupAntigravityCliRelease(signal?: AbortSignal) {
  const target = antigravityCliTarget(process.platform, process.arch);
  if (!target) return null;
  const response = await fetch(ANTIGRAVITY_CLI_MANIFEST_BASE + "/" + target + ".json", {
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Could not check Antigravity updates.");
  const body = await response.text();
  if (body.length > 64 * 1024) throw new Error("Antigravity update manifest is too large.");
  return parseAntigravityCliRelease(JSON.parse(body), process.platform, process.arch);
}
