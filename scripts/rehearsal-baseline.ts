// @effect-diagnostics nodeBuiltinImport:off
/**
 * Chooses the Windows update rehearsal pair and writes it as GitHub step outputs
 * (to `$GITHUB_OUTPUT`, or stdout outside Actions). When a release is published on
 * the channel, the baseline is its installer, downloaded and checked against its
 * SHA256SUMS; before any Windows release is published, both builds are unpublished.
 *
 * Usage: node scripts/rehearsal-baseline.ts --version V --channel latest|beta --output-dir D
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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

/** Runner calls to GitHub fail transiently, so each gets a few spaced attempts. */
async function retry<T>(label: string, action: () => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (error) {
      if (attempt === 4) throw error;
      console.warn(`${label} failed (attempt ${attempt}/4); retrying in ${attempt * 10}s`, error);
      await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
    }
  }
}

function output(pair: {
  baseline: string;
  baselineChannel: RehearsalChannel;
  target: string;
  published: boolean;
}) {
  console.log(
    `Rehearsing ${pair.published ? "published" : "unpublished"} ${pair.baseline} (${pair.baselineChannel}) → ${pair.target} (${channel})`,
  );
  const lines = `baseline=${pair.baseline}\nbaseline_channel=${pair.baselineChannel}\ntarget=${pair.target}\npublished=${pair.published}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

const releases = await retry("Listing releases", () => fetchReleaseSummaries(repository));
const { baseline, skipped } = selectPublishedBaseline(releases, channel);
for (const reason of skipped) console.warn(`Not a rehearsal baseline: ${reason}`);
if (!baseline) {
  const pair = rehearsalVersions(version, channel);
  output({ ...pair, baselineChannel: channel, published: false });
} else {
  const dir = join(outputDir, baseline.version);
  mkdirSync(dir, { recursive: true });
  const args = ["release", "download", baseline.tag, "-R", repository, "-D", dir, "--clobber"];
  for (const name of [...baseline.assets, "SHA256SUMS"]) args.push("-p", name);
  await retry(`Downloading ${baseline.tag}`, () => {
    const result = spawnSync("gh", args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`gh release download exited with ${result.status}`);
  });
  verifyDownloadedChecksums(dir, readFileSync(join(dir, "SHA256SUMS"), "utf8"), baseline.assets);
  output({
    baseline: baseline.version,
    baselineChannel: baseline.channel,
    target: rehearsalTarget(version, channel, baseline.version),
    published: true,
  });
}
