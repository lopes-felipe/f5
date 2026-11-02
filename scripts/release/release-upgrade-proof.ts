import { createHash } from "node:crypto";
import type { ReleaseCandidate } from "./release-candidate.ts";
import { publishedWindowsBaselines } from "../published-windows-upgrade.ts";
import type { PublishedReleaseSummary } from "../lib/release-profile.ts";
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";
export interface PublicationQualification {
  readonly key: string | null;
  readonly windowsBaselines: ReleaseCandidate["windowsBaselines"];
  readonly cliBaseline: string | null;
  readonly requalification: { readonly runId: number; readonly attempt: number } | null;
}
export function validatePublicationQualification(
  value: unknown,
  candidate: ReleaseCandidate,
): void {
  if (!value || typeof value !== "object")
    throw new Error("Missing release qualification manifest");
  const proof = value as PublicationQualification & {
    schemaVersion: number;
    sourceSha: string;
    candidateRun: number;
    candidateAttempt: number;
  };
  const prefix = candidate.runId + "-" + candidate.runAttempt + "-";
  if (
    proof.schemaVersion !== 1 ||
    proof.sourceSha !== candidate.sourceSha ||
    proof.candidateRun !== candidate.runId ||
    proof.candidateAttempt !== candidate.runAttempt ||
    (proof.key !== null &&
      (typeof proof.key !== "string" ||
        !proof.key.startsWith(prefix) ||
        !/^[a-f0-9]{24}$/.test(proof.key.slice(prefix.length)))) ||
    typeof proof.cliBaseline !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(proof.cliBaseline) ||
    !Array.isArray(proof.windowsBaselines) ||
    proof.windowsBaselines.some(
      (baseline) =>
        !baseline ||
        !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(baseline.baseline) ||
        !["latest", "beta"].includes(baseline.baselineChannel) ||
        !["latest", "beta"].includes(baseline.clientChannel),
    ) ||
    (proof.requalification !== null &&
      (!proof.key ||
        !Number.isSafeInteger(proof.requalification?.runId) ||
        proof.requalification.runId < 1 ||
        !Number.isSafeInteger(proof.requalification?.attempt) ||
        proof.requalification.attempt < 1))
  )
    throw new Error("Release qualification manifest mismatch");
}

export function upgradePlan(
  candidate: ReleaseCandidate,
  releases: readonly PublishedReleaseSummary[],
) {
  const baselines = publishedWindowsBaselines(releases, candidate.version, candidate.channel);
  const stable = releases
    .filter((r) => !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
    .toSorted((a, b) => compareCliReleaseVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
  if (!stable) throw new Error("Published CLI upgrade baseline missing");
  const cliBaseline = stable.tag_name.slice(1);
  const cliTargets = candidate.artifacts
    .filter((a) => a.component.startsWith("cli-") && a.receipt.cliUpgradeBaseline !== cliBaseline)
    .map((a) => ({
      target: a.component.slice(4),
      artifact: a.name,
      os: (
        {
          "darwin-arm64": "macos-latest",
          "linux-x64": "ubuntu-latest",
          "linux-arm64": "ubuntu-24.04-arm",
          "win32-x64": "windows-latest",
          "win32-arm64": "windows-11-arm",
        } as Record<string, string>
      )[a.component.slice(4)]!,
    }));
  const key =
    candidate.runId +
    "-" +
    candidate.runAttempt +
    "-" +
    createHash("sha256")
      .update(JSON.stringify({ baselines, cliBaseline }))
      .digest("hex")
      .slice(0, 24);
  return { key, baselines, cliBaseline, cliTargets };
}
export function sameBaselines(
  a: ReleaseCandidate["windowsBaselines"],
  b: ReleaseCandidate["windowsBaselines"],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
