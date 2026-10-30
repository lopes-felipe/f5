import { createHash } from "node:crypto";
import type { ReleaseCandidate } from "./release-candidate.ts";
import { publishedWindowsBaselines } from "../published-windows-upgrade.ts";
import type { PublishedReleaseSummary } from "../lib/release-profile.ts";
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";

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
