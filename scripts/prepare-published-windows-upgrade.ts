// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fetchReleaseSummaries, type PublishedReleaseSummary } from "./lib/release-profile.ts";
import {
  publishedWindowsBaselines,
  verifyWindowsUpgradeArtifacts,
  windowsUpgradeAssets,
} from "./published-windows-upgrade.ts";

interface PreparationDependencies {
  readonly releases: (repository: string) => readonly PublishedReleaseSummary[];
  readonly download: (repository: string, baseline: string, names: string[], dir: string) => void;
}

const defaults: PreparationDependencies = {
  releases: fetchReleaseSummaries,
  download: (repository, baseline, names, dir) => {
    execFileSync(
      "gh",
      [
        "release",
        "download",
        `v${baseline}`,
        "--repo",
        repository,
        "--dir",
        dir,
        ...names.flatMap((name) => ["--pattern", name]),
      ],
      { stdio: "inherit", timeout: 300_000 },
    );
  },
};

export function preparePublishedWindowsUpgrade(
  args: string[],
  env: NodeJS.ProcessEnv,
  dependencies: PreparationDependencies = defaults,
): void {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string" },
      channel: { type: "string" },
      baseline: { type: "string" },
      "pinned-baseline": { type: "boolean", default: false },
      "client-channel": { type: "string" },
      "target-dir": { type: "string" },
      "baseline-dir": { type: "string" },
      "log-dir": { type: "string", default: "rehearsal-logs" },
    },
  });
  const target = values.target;
  const channel = values.channel;
  const clientChannel = values["client-channel"];
  const targetDir = values["target-dir"];
  const baselineDir = values["baseline-dir"];
  const repository = env.GITHUB_REPOSITORY;
  const output = env.GITHUB_OUTPUT;
  if (
    !target ||
    (channel !== "latest" && channel !== "beta") ||
    (clientChannel !== "latest" && clientChannel !== "beta") ||
    values.baseline === undefined ||
    !targetDir ||
    !baselineDir ||
    !repository ||
    !output
  )
    throw new Error(
      "Expected target, channel, baseline, client-channel, artifact directories and GitHub Actions context",
    );

  // Fail before any network access, and never turn a corrupt candidate into a successful skip.
  verifyWindowsUpgradeArtifacts(targetDir, target, channel);
  const releases = dependencies.releases(repository);
  // A candidate validates the immutable baseline captured by its plan. A later public
  // release is qualified separately against the same installer, never by rebuilding.
  const pinned = values["pinned-baseline"] && values.baseline !== "";
  const eligible = pinned
    ? releases.filter((r) => r.tag_name === "v" + values.baseline && !r.draft)
    : releases;
  if (pinned && eligible.length !== 1) throw new Error("Pinned published baseline is missing");
  const plans = publishedWindowsBaselines(eligible, target, channel);
  const plan = plans.find(
    (entry) => entry.baseline === values.baseline && entry.clientChannel === clientChannel,
  );
  if ((plans.length && !plan) || (!plans.length && values.baseline !== ""))
    throw new Error("Published upgrade plan changed after preflight; rerun the release rehearsal");
  if (plan) {
    mkdirSync(baselineDir, { recursive: true });
    dependencies.download(
      repository,
      plan.baseline,
      windowsUpgradeAssets(plan.baseline, plan.baselineChannel),
      baselineDir,
    );
    verifyWindowsUpgradeArtifacts(baselineDir, plan.baseline, plan.baselineChannel);
  }
  mkdirSync(values["log-dir"], { recursive: true });
  writeFileSync(
    join(values["log-dir"], "published-upgrade.json"),
    JSON.stringify(
      {
        baseline: plan?.baseline ?? null,
        baselineChannel: plan?.baselineChannel ?? null,
        clientChannel,
        target,
        channel,
        targetArtifact: "desktop-win-x64",
      },
      null,
      2,
    ) + "\n",
  );
  appendFileSync(
    output,
    `available=${Boolean(plan)}\nbaseline=${plan?.baseline ?? ""}\nbaseline_channel=${plan?.baselineChannel ?? channel}\n`,
  );
  console.log(
    plan
      ? `Rehearse published ${plan.baseline} (${clientChannel} client) -> desktop-win-x64 ${target}`
      : "No published Windows baseline; the same-commit rehearsal covers the first release",
  );
}

if (process.argv[1]?.endsWith("prepare-published-windows-upgrade.ts"))
  preparePublishedWindowsUpgrade(process.argv.slice(2), process.env);
