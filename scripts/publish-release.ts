import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import {
  assertReleaseProfileAllowed,
  fetchReleaseSummaries,
  parseReleaseProfile,
} from "./lib/release-profile.ts";
const tag = process.env.TAG!;
const run = (args: string[]) => execFileSync("gh", args, { encoding: "utf8" });
const existing = spawnSync("gh", ["release", "view", tag, "--json", "isDraft"], {
  encoding: "utf8",
});
if (existing.status === 0) {
  if (!JSON.parse(existing.stdout).isDraft) throw new Error("Published releases are immutable");
  // Preserve existing drafts and assets. A maintainer can inspect a failed attempt.
  throw new Error("A draft already exists. Inspect it before retrying publication.");
}
// Re-check immediately before the draft exists: another release may have shipped since preflight.
assertReleaseProfileAllowed(
  parseReleaseProfile(process.env.PROFILE),
  fetchReleaseSummaries(process.env.GH_REPO!),
);
const assets = readdirSync("release-assets").sort();
run([
  "release",
  "create",
  tag,
  "--verify-tag",
  "--draft",
  "--title",
  `F5 ${tag}`,
  "--notes-file",
  "notes.md",
  ...(process.env.PRERELEASE === "true" ? ["--prerelease"] : []),
  ...assets.map((name) => `release-assets/${name}`),
]);
const remote = JSON.parse(run(["release", "view", tag, "--json", "assets"])) as {
  assets: { name: string; size: number }[];
};
const expected = assets.map((name) => ({ name, size: statSync(`release-assets/${name}`).size }));
const actual = remote.assets
  .map(({ name, size }) => ({ name, size }))
  .sort((a, b) => a.name.localeCompare(b.name));
if (
  JSON.stringify(expected.sort((a, b) => a.name.localeCompare(b.name))) !== JSON.stringify(actual)
)
  throw new Error("Uploaded asset names/sizes differ from verified bundle");
