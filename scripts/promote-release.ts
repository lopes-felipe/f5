/**
 * Publishes a release draft: the only supported way to undraft.
 *
 *   bun run release:promote --tag v1.2.3
 *
 * A draft is published only when every certifying record's evidence commit is in the
 * source's history. On any problem the draft stays a draft. Publishers create drafts
 * without a tag (the tag would appear in the public release feed); for such a draft the
 * tag is created at its recorded source commit immediately before undrafting.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  promotionProblems,
  promotionSource,
  remoteTagCommit,
  type PromotionIo,
} from "./lib/release-promotion.ts";

const index = process.argv.indexOf("--tag");
const tag = index < 0 ? undefined : process.argv[index + 1];
if (!tag) throw new Error("Usage: release:promote --tag <vX.Y.Z>");
const run = (command: string, args: ReadonlyArray<string>) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

run("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
const view = JSON.parse(
  run("gh", ["release", "view", tag, "--json", "isDraft,targetCommitish"]),
) as { isDraft: boolean; targetCommitish?: string };
const source = promotionSource(tag, {
  tagExists: () => run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).trim() !== "",
  remoteTagCommit: () =>
    remoteTagCommit(tag, {
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
  release: () => ({ draft: view.isDraft, target_commitish: view.targetCommitish }),
});
if (source.needsTag) run("git", ["fetch", "--quiet", "origin", source.commit]);
const io: PromotionIo = {
  show: (revision, path) => {
    const result = spawnSync("git", ["show", `${revision}:${path}`], { encoding: "utf8" });
    return result.status === 0 ? result.stdout : undefined;
  },
  commitOf: () => source.commit,
  isAncestor: (commit, revision) =>
    spawnSync("git", ["merge-base", "--is-ancestor", commit, revision]).status === 0,
  release: () => ({ isDraft: view.isDraft }),
};

const problems = promotionProblems(tag, io);
if (problems.length) {
  console.error(`Not promoting ${tag}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exitCode = 1;
} else {
  if (source.needsTag)
    run("gh", [
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/git/refs",
      "-f",
      `ref=refs/tags/${tag}`,
      "-f",
      `sha=${source.commit}`,
    ]);
  run("gh", ["release", "edit", tag, "--draft=false"]);
  console.log(`Published ${tag}.`);
}
