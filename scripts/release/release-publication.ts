import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";
import type { ReleaseCandidate, StableRequest } from "./release-candidate.ts";

export type AutomationMode = "shadow" | "beta" | "all";
export function automationMode(value: string | undefined): AutomationMode {
  if (!value) return "shadow";
  if (!["shadow", "beta", "all"].includes(value))
    throw new Error("Invalid release automation mode");
  return value as AutomationMode;
}
export interface QualifiedSource {
  readonly sourceSha: string;
  readonly order: number;
}
export type ReleaseSelection = { readonly sourceSha: string; readonly reason: string } | null;
/** Inputs are trusted main history, never workflow completion order. */
export function selectPublication(
  green: readonly QualifiedSource[],
  pending: readonly StableRequest[],
): ReleaseSelection {
  if (pending.length) {
    const stable = pending[0]!;
    return green.some((c) => c.sourceSha === stable.sourceSha)
      ? { sourceSha: stable.sourceSha, reason: "stable request " + stable.requestId }
      : null;
  }
  const latest = green.toSorted((a, b) => b.order - a.order)[0];
  return latest ? { sourceSha: latest.sourceSha, reason: "newest passing main commit" } : null;
}
export interface UploadedAsset {
  readonly name: string;
  readonly size: number;
  readonly digest: string;
  readonly state: string;
}
export function missingUploads(
  expected: readonly { name: string; size: number; sha256: string }[],
  actual: readonly UploadedAsset[],
): string[] {
  const names = new Set<string>();
  for (const asset of actual) {
    const wanted = expected.find((f) => f.name === asset.name);
    if (
      names.has(asset.name) ||
      !wanted ||
      asset.size !== wanted.size ||
      asset.digest !== "sha256:" + wanted.sha256 ||
      asset.state !== "uploaded"
    )
      throw new Error("Existing release asset differs from verified candidate: " + asset.name);
    names.add(asset.name);
  }
  return expected.filter((f) => !names.has(f.name)).map((f) => f.name);
}
export function assertPublishableVersion(
  candidate: ReleaseCandidate,
  versions: readonly string[],
): void {
  for (const version of versions)
    if (compareCliReleaseVersions(candidate.version, version) <= 0)
      throw new Error("Candidate superseded by published " + version);
}
export function artifactEntries(names: readonly string[]): void {
  if (
    !names.length ||
    names.length > 100 ||
    new Set(names).size !== names.length ||
    names.some((n) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n))
  )
    throw new Error("Unsafe artifact archive entries");
}
