// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
export const CLI_TARGETS = [
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
] as const;
export type CliTarget = (typeof CLI_TARGETS)[number];
export interface CliArtifact {
  target: CliTarget;
  url: string;
  sha256: string;
  size: number;
}
export interface CliRelease {
  schemaVersion: 1;
  version: string;
  artifacts: CliArtifact[];
}
export const RELEASE_MANIFEST_URL =
  "https://github.com/lopes-felipe/f5/releases/latest/download/f5-cli-release.json";
export function versionToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(value) ||
    value.length > 100
  )
    throw new Error("Invalid release version.");
  if (
    value
      .split("-")[0]!
      .split(".")
      .some((part) => part.length > 1 && part.startsWith("0")) ||
    value
      .slice(value.indexOf("-") + 1)
      .split(".")
      .some((part) => /^0\d+$/.test(part))
  )
    throw new Error("Release versions must use canonical semver tokens.");
  return value;
}
export function cliTarget(platform = process.platform, architecture = process.arch): CliTarget {
  const target = `${platform}-${architecture}`;
  if (!(CLI_TARGETS as readonly string[]).includes(target))
    throw new Error(
      `No F5 CLI archive for ${target}. Intel macOS users can use the desktop package.`,
    );
  return target as CliTarget;
}
export function parseRelease(value: unknown): CliRelease {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("version" in value) ||
    !("artifacts" in value) ||
    !Array.isArray(value.artifacts)
  )
    throw new Error("Invalid F5 release manifest.");
  const version = versionToken(value.version);
  const targets = new Set<string>();
  const artifacts = value.artifacts.map((item: unknown): CliArtifact => {
    if (
      !item ||
      typeof item !== "object" ||
      !("target" in item) ||
      !("url" in item) ||
      !("sha256" in item) ||
      !("size" in item) ||
      typeof item.target !== "string" ||
      !(CLI_TARGETS as readonly string[]).includes(item.target) ||
      targets.has(item.target) ||
      typeof item.url !== "string" ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.size !== "number" ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0 ||
      item.size > 1024 * 1024 * 1024
    )
      throw new Error("Invalid or duplicate release artifact.");
    const url = new URL(item.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Release artifacts require HTTPS.");
    targets.add(item.target);
    return {
      target: item.target as CliTarget,
      url: url.href,
      sha256: item.sha256,
      size: item.size,
    };
  });
  return { schemaVersion: 1, version, artifacts };
}
export function selectArtifact(release: CliRelease, target = cliTarget()): CliArtifact {
  const artifact = release.artifacts.find((item) => item.target === target);
  if (!artifact) throw new Error(`Release ${release.version} has no archive for ${target}.`);
  return artifact;
}
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Semver precedence for exact release tokens; updates never silently downgrade. */
export function compareCliReleaseVersions(left: string, right: string): number {
  const split = (input: string) => {
    const [core, ...rest] = versionToken(input).split("-");
    return {
      core: core!.split(".").map(BigInt),
      prerelease: rest.length ? rest.join("-").split(".") : [],
    };
  };
  const a = split(left),
    b = split(right);
  for (let index = 0; index < 3; index++)
    if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]! ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index],
      y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
