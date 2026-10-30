import { versionToken } from "@t3tools/shared/cliRelease";
import type { ReleaseChannel, ReleaseProfile } from "../lib/release-profile.ts";

export interface StableIntent {
  readonly version: string;
  readonly requestId: string;
  readonly supersedes?: string;
}
export interface StableRequest extends StableIntent {
  readonly sourceSha: string;
}
export interface ReleasePlan {
  readonly schemaVersion: 1;
  readonly sourceSha: string;
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly kind: "stable" | "beta";
  readonly profile: ReleaseProfile;
  readonly anchorSha: string;
  readonly stableIntent: StableIntent | null;
  readonly runId: number;
  readonly runAttempt: number;
  readonly createdAt: string;
  readonly toolchain: {
    readonly node: string;
    readonly bun: string;
    readonly bunWindowsArm64: string;
    readonly lockSha256: string;
  };
  readonly windowsBaselines: readonly {
    readonly baseline: string;
    readonly baselineChannel: ReleaseChannel;
    readonly clientChannel: ReleaseChannel;
  }[];
}
export interface ComponentReceipt {
  readonly component: string;
  readonly sourceSha: string;
  readonly version: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly cliUpgradeBaseline?: string;
  readonly toolchain: {
    readonly node: string;
    readonly bun: string;
    readonly platform: string;
    readonly arch: string;
    readonly image: string;
  };
  readonly files: ReadonlyArray<{
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
  }>;
}
export interface CandidateArtifact {
  readonly id: number;
  readonly name: string;
  readonly digest: string;
  readonly component: string;
  readonly receipt: ComponentReceipt;
}
export interface ReleaseCandidate extends ReleasePlan {
  readonly artifacts: readonly CandidateArtifact[];
  readonly windowsBaselines: readonly {
    readonly baseline: string;
    readonly baselineChannel: ReleaseChannel;
    readonly clientChannel: ReleaseChannel;
  }[];
}
export const SHA_PATTERN = /^[a-f0-9]{40}$/;
export const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function parseStableIntent(value: unknown): StableIntent {
  if (!value || typeof value !== "object") throw new Error("Invalid stable release intent");
  const intent = value as StableIntent;
  if (!/^\d+\.\d+\.\d+$/.test(intent.version) || !ID_PATTERN.test(intent.requestId))
    throw new Error("Stable intent requires a stable version and UUID requestId");
  versionToken(intent.version);
  if (
    intent.supersedes !== undefined &&
    (!ID_PATTERN.test(intent.supersedes) || intent.supersedes === intent.requestId)
  )
    throw new Error("Invalid superseded stable request");
  return intent;
}
export function candidateVersion(input: {
  sourceSha: string;
  anchorSha: string;
  baseVersion: string;
  distance: number;
  request: StableRequest | null;
}): { version: string; kind: "stable" | "beta"; channel: ReleaseChannel } {
  if (!SHA_PATTERN.test(input.sourceSha) || !SHA_PATTERN.test(input.anchorSha))
    throw new Error("Release source and anchor must be full commit SHAs");
  if (input.request?.sourceSha === input.sourceSha) {
    parseStableIntent(input.request);
    return { version: input.request.version, kind: "stable", channel: "latest" };
  }
  if (
    !/^\d+\.\d+\.\d+$/.test(input.baseVersion) ||
    !Number.isSafeInteger(input.distance) ||
    input.distance < 1
  )
    throw new Error("Beta requires a stable base and positive first-parent distance");
  const [major, minor, patch] = input.baseVersion.split(".").map(Number);
  const version = versionToken([major, minor, patch! + 1].join(".") + "-beta." + input.distance);
  return { version, kind: "beta", channel: "beta" };
}
export function releaseComponents(profile: ReleaseProfile): string[] {
  return [
    ...(profile === "all" ? ["desktop-mac-arm64", "desktop-mac-x64", "desktop-linux-x64"] : []),
    "desktop-win-x64",
    ...["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"].map(
      (t) => "cli-" + t,
    ),
  ];
}
export function validateReceipt(receipt: ComponentReceipt, plan: ReleasePlan): void {
  if (
    !releaseComponents(plan.profile).includes(receipt.component) ||
    receipt.sourceSha !== plan.sourceSha ||
    receipt.version !== plan.version ||
    receipt.runId !== plan.runId ||
    !Number.isSafeInteger(receipt.runAttempt) ||
    receipt.runAttempt < 1 ||
    receipt.runAttempt > plan.runAttempt ||
    !receipt.files.length
  )
    throw new Error("Component provenance mismatch: " + receipt.component);
  if (
    !receipt.toolchain ||
    (["node", "bun", "platform", "arch", "image"] as const).some(
      (key) => typeof receipt.toolchain[key] !== "string" || !receipt.toolchain[key],
    )
  )
    throw new Error("Missing component toolchain identity");
  const [, platform, arch] = receipt.component.split("-");
  const expectedPlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : platform;
  if (
    receipt.toolchain.platform !== expectedPlatform ||
    receipt.toolchain.arch !== arch ||
    receipt.toolchain.bun !==
      (expectedPlatform === "win32" && arch === "arm64"
        ? plan.toolchain.bunWindowsArm64
        : plan.toolchain.bun)
  )
    throw new Error("Component platform/toolchain mismatch");
  if (
    receipt.component.startsWith("cli-") &&
    !/^\d+\.\d+\.\d+$/.test(receipt.cliUpgradeBaseline ?? "")
  )
    throw new Error("Missing native CLI installed-upgrade evidence");
  const names = new Set<string>();
  for (const file of receipt.files) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.name) ||
      names.has(file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      !HASH_PATTERN.test(file.sha256)
    )
      throw new Error("Invalid component file: " + file.name);
    names.add(file.name);
  }
}
export function validateCandidate(candidate: ReleaseCandidate): void {
  if (
    candidate.schemaVersion !== 1 ||
    !SHA_PATTERN.test(candidate.sourceSha) ||
    !SHA_PATTERN.test(candidate.anchorSha) ||
    !["all", "windows"].includes(candidate.profile) ||
    !Number.isSafeInteger(candidate.runId) ||
    candidate.runId < 1 ||
    !Number.isSafeInteger(candidate.runAttempt) ||
    candidate.runAttempt < 1 ||
    !HASH_PATTERN.test(candidate.toolchain.lockSha256)
  )
    throw new Error("Invalid release candidate identity");
  versionToken(candidate.version);
  const stable = /^\d+\.\d+\.\d+$/.test(candidate.version);
  if (
    candidate.kind !== (stable ? "stable" : "beta") ||
    candidate.channel !== (stable ? "latest" : "beta") ||
    (!stable && !/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(candidate.version))
  )
    throw new Error("Candidate version/channel mismatch");
  if (
    stable &&
    (!candidate.stableIntent ||
      parseStableIntent(candidate.stableIntent).version !== candidate.version)
  )
    throw new Error("Stable candidate has no matching release intent");
  const components = releaseComponents(candidate.profile);
  if (candidate.artifacts.length !== components.length) throw new Error("Incomplete artifact set");
  const seen = new Set<string>();
  for (const artifact of candidate.artifacts) {
    validateReceipt(artifact.receipt, candidate);
    if (
      artifact.component !== artifact.receipt.component ||
      seen.has(artifact.component) ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.id < 1 ||
      artifact.name !== artifact.component + "-attempt-" + artifact.receipt.runAttempt ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
    )
      throw new Error("Invalid candidate artifact: " + artifact.component);
    seen.add(artifact.component);
  }
  if (components.some((c) => !seen.has(c))) throw new Error("Missing release component");
}
/** Requests are oldest first. Supersession is explicit and cannot skip a published release. */
export function pendingStableRequests(
  requests: readonly StableRequest[],
  published: ReadonlyMap<string, string>,
): StableRequest[] {
  const pending = new Map<string, StableRequest>();
  const seen = new Set<string>();
  const superseded = new Set(requests.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
  for (const request of requests) {
    parseStableIntent(request);
    if (seen.has(request.requestId)) throw new Error("Stable request ID reused");
    seen.add(request.requestId);
    if (request.supersedes) {
      const previous = pending.get(request.supersedes);
      if (!previous || request.version !== previous.version)
        throw new Error("Recovery must explicitly supersede the same unpublished version");
      pending.delete(request.supersedes);
    }
    const publishedSha = superseded.has(request.requestId)
      ? undefined
      : published.get(request.version);
    if (publishedSha) {
      if (publishedSha !== request.sourceSha)
        throw new Error("Published stable version has a different source");
      continue;
    }
    if (pending.size) throw new Error("Another stable request is still pending");
    pending.set(request.requestId, request);
  }
  return [...pending.values()];
}
