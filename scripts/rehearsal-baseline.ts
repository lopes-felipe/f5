// @effect-diagnostics nodeBuiltinImport:off
/**
 * Chooses the Windows update rehearsal pair and prints it as GitHub step outputs.
 * When a release is published on the channel, the baseline is its installer,
 * downloaded and checked against its SHA256SUMS; otherwise both builds are unpublished.
 *
 * Usage: node scripts/rehearsal-baseline.ts --version V --channel latest|beta --output-dir D
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RELEASE_UPDATE_OWNER, RELEASE_UPDATE_REPO } from "./lib/app-update-config.ts";
import {
  rehearsalTarget,
  selectPublishedBaseline,
  verifyDownloadedChecksums,
  type RehearsalChannel,
} from "./lib/rehearsal-baseline.ts";
import { fetchReleaseSummaries } from "./lib/release-profile.ts";
import { rehearsalVersions } from "./lib/update-rehearsal.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    channel: { type: "string" },
    "output-dir": { type: "string" },
  },
});
const { version, channel, "output-dir": outputDir } = values;
if (!version || !outputDir || (channel !== "latest" && channel !== "beta"))
  throw new Error("Usage: --version V --channel latest|beta --output-dir D");
const repository = `${RELEASE_UPDATE_OWNER}/${RELEASE_UPDATE_REPO}`;

function output(pair: {
  baseline: string;
  baselineChannel: RehearsalChannel;
  target: string;
  published: boolean;
}) {
  console.error(
    `Rehearsing ${pair.published ? "published" : "unpublished"} ${pair.baseline} (${pair.baselineChannel}) → ${pair.target} (${channel})`,
  );
  console.log(
    `baseline=${pair.baseline}\nbaseline_channel=${pair.baselineChannel}\ntarget=${pair.target}\npublished=${pair.published}`,
  );
}

const baseline = selectPublishedBaseline(fetchReleaseSummaries(repository), channel);
if (!baseline) {
  const pair = rehearsalVersions(version, channel);
  output({ ...pair, baselineChannel: channel, published: false });
} else {
  const dir = join(outputDir, baseline.version);
  mkdirSync(dir, { recursive: true });
  const names = [...baseline.assets, "SHA256SUMS"];
  const args = ["release", "download", baseline.tag, "-R", repository, "-D", dir, "--clobber"];
  for (const name of names) args.push("-p", name);
  // Runner downloads from GitHub fail transiently; stdout is reserved for step outputs.
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync("gh", args, { stdio: ["ignore", 2, 2] });
    if (result.status === 0) break;
    if (attempt === 3) throw new Error(`Could not download ${baseline.tag}'s installer`);
    console.error(`Download of ${baseline.tag} failed (attempt ${attempt}/3); retrying`);
  }
  verifyDownloadedChecksums(dir, readFileSync(join(dir, "SHA256SUMS"), "utf8"), baseline.assets);
  output({
    baseline: baseline.version,
    baselineChannel: baseline.channel,
    target: rehearsalTarget(version, channel, baseline.version),
    published: true,
  });
}
