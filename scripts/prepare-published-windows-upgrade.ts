// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fetchReleaseSummaries } from "./lib/release-profile.ts";
import {
  publishedWindowsBaseline,
  verifyWindowsUpgradeArtifacts,
  windowsUpgradeAssets,
} from "./published-windows-upgrade.ts";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    channel: { type: "string" },
    "target-dir": { type: "string" },
    "baseline-dir": { type: "string" },
    "log-dir": { type: "string", default: "rehearsal-logs" },
  },
});
const target = values.target;
const channel = values.channel;
const targetDir = values["target-dir"];
const baselineDir = values["baseline-dir"];
const repository = process.env.GITHUB_REPOSITORY;
if (
  !target ||
  (channel !== "latest" && channel !== "beta") ||
  !targetDir ||
  !baselineDir ||
  !repository ||
  !process.env.GITHUB_OUTPUT
)
  throw new Error("Expected target, channel, target-dir, baseline-dir and GitHub Actions context");

verifyWindowsUpgradeArtifacts(targetDir, target, channel);
const baseline = publishedWindowsBaseline(fetchReleaseSummaries(repository), target, channel);
if (baseline) {
  mkdirSync(baselineDir, { recursive: true });
  execFileSync(
    "gh",
    [
      "release",
      "download",
      `v${baseline}`,
      "--repo",
      repository,
      "--dir",
      baselineDir,
      ...windowsUpgradeAssets(baseline, channel).flatMap((name) => ["--pattern", name]),
    ],
    { stdio: "inherit", timeout: 300_000 },
  );
  verifyWindowsUpgradeArtifacts(baselineDir, baseline, channel);
}
mkdirSync(values["log-dir"], { recursive: true });
writeFileSync(
  join(values["log-dir"], "published-upgrade.json"),
  JSON.stringify(
    { baseline: baseline ?? null, target, channel, targetArtifact: "desktop-win-x64" },
    null,
    2,
  ) + "\n",
);
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `available=${Boolean(baseline)}\nbaseline=${baseline ?? ""}\n`,
);
console.log(
  baseline
    ? `Rehearse published ${baseline} -> desktop-win-x64 ${target}`
    : `No published ${channel} baseline; the same-commit rehearsal covers the first release`,
);
