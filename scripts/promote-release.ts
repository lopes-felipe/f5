/**
 * Publishes a release draft: the only supported way to undraft.
 *
 *   bun run release:promote --tag v1.2.3
 *
 * A draft that embeds a certifying integration record is published only when main holds
 * an all-passed acceptance report for that tag's exact artifact (see
 * `accept-integration.ts`). On any problem the draft stays a draft.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promotionProblems, remoteTagCommit, type PromotionIo } from "./lib/release-promotion.ts";

const index = process.argv.indexOf("--tag");
const tag = index < 0 ? undefined : process.argv[index + 1];
if (!tag) throw new Error("Usage: release:promote --tag <vX.Y.Z>");
const run = (command: string, args: ReadonlyArray<string>) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

run("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
const io: PromotionIo = {
  show: (revision, path) => {
    const result = spawnSync("git", ["show", `${revision}:${path}`], { encoding: "utf8" });
    return result.status === 0 ? result.stdout : undefined;
  },
  commitOf: (name) =>
    remoteTagCommit(name, {
      local: (local) => run("git", ["rev-list", "-n", "1", local]).trim(),
      remote: (remote) =>
        run("git", [
          "ls-remote",
          "--tags",
          "origin",
          `refs/tags/${remote}`,
          `refs/tags/${remote}^{}`,
        ]),
    }),
  isAncestor: (commit, revision) =>
    spawnSync("git", ["merge-base", "--is-ancestor", commit, revision]).status === 0,
  release: (name) => {
    const view = JSON.parse(run("gh", ["release", "view", name, "--json", "isDraft,assets"])) as {
      isDraft: boolean;
      assets: ReadonlyArray<{ name: string }>;
    };
    return { isDraft: view.isDraft, assets: view.assets.map((asset) => asset.name) };
  },
  assetSha256: (name, asset) => {
    const directory = mkdtempSync(join(tmpdir(), "f5-promote-"));
    try {
      run("gh", ["release", "download", name, "--pattern", asset, "--dir", directory]);
      return createHash("sha256")
        .update(readFileSync(join(directory, asset)))
        .digest("hex");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
};

const problems = promotionProblems(tag, io);
if (problems.length) {
  console.error(`Not promoting ${tag}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exitCode = 1;
} else {
  run("gh", ["release", "edit", tag, "--draft=false"]);
  console.log(`Published ${tag}.`);
}
