import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseScopedGitConfigKeys,
  readOnlyGitConfigPairs,
  withReadOnlyGitConfig,
} from "./readOnlyGitConfig.ts";

/** Helpers these reads run. `gpg.program` runs only for signed commits, so it isn't among them. */
const HELPERS = ["external", "textconv", "command", "clean", "fsmonitor"] as const;

/**
 * A repository whose own config runs a helper for each kind of read. Each helper touches a
 * marker in `$F5_MARKERS`, so a run can tell which helpers ran.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "f5-readonly-git-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  // Isolated from the developer's own Git config; the "global" file stands for yours.
  const globalConfig = path.join(root, "global.gitconfig");
  writeFileSync(globalConfig, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: string[], env: NodeJS.ProcessEnv = environment) =>
    execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  // `notes.txt` uses the attribute-selected driver; `plain.md` the external diff.
  writeFileSync(path.join(repo, "notes.txt"), "one\n");
  writeFileSync(path.join(repo, "plain.md"), "one\n");
  writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=helper filter=helper\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  writeFileSync(path.join(repo, "notes.txt"), "two\n");
  writeFileSync(path.join(repo, "plain.md"), "two\n");
  const touch = (name: string) => `sh -c 'touch "$F5_MARKERS/${name}"; cat'`;
  git(["config", "diff.external", touch("external")]);
  git(["config", "diff.helper.textconv", touch("textconv")]);
  git(["config", "diff.helper.command", touch("command")]);
  git(["config", "filter.helper.clean", touch("clean")]);
  git(["config", "core.fsmonitor", touch("fsmonitor")]);
  git(["config", "gpg.program", touch("gpg")]);
  /** Runs the reads a review stage makes; returns the helpers that ran. */
  const helpersRun = (env: NodeJS.ProcessEnv): string[] => {
    const markers = mkdtempSync(path.join(root, "markers-"));
    for (const args of [
      ["status", "--short"],
      ["diff"],
      ["diff", "--no-ext-diff"],
      ["log", "-1", "-p", "--show-signature"],
    ])
      try {
        git(args, { ...env, F5_MARKERS: markers });
      } catch {
        // A read can fail: Git won't run an emptied helper.
      }
    return HELPERS.filter((name) => existsSync(path.join(markers, name)));
  };
  return { repo, environment, helpersRun };
}

describe("parseScopedGitConfigKeys", () => {
  it("reads scope and key, with or without a value", () => {
    expect(
      parseScopedGitConfigKeys("local\0diff.external\nsh -c x\0global\0core.fsmonitor\0"),
    ).toEqual([
      { scope: "local", key: "diff.external" },
      { scope: "global", key: "core.fsmonitor" },
    ]);
  });
});

describe("readOnlyGitConfigPairs", () => {
  it("overrides every helper the repository defines, and none of yours", async () => {
    const { repo, environment } = fixture();
    const pairs = await readOnlyGitConfigPairs(repo, environment);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["core.fsmonitor", "false"],
        ["diff.external", ""],
        ["diff.helper.textconv", ""],
        ["diff.helper.command", ""],
        ["filter.helper.clean", ""],
        ["gpg.program", ""],
      ]),
    );
    expect(pairs.some(([key]) => key.startsWith("filter.lfs"))).toBe(false);
    expect(pairs.filter(([key]) => key === "core.fsmonitor")).toHaveLength(1);
  });

  it("keeps only the fsmonitor override outside a repository", async () => {
    const { environment } = fixture();
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "f5-readonly-git-outside-")));
    expect(await readOnlyGitConfigPairs(outside, environment)).toEqual([
      ["core.fsmonitor", "false"],
    ]);
  });

  it("rejects when Git can't read the config", async () => {
    const { environment } = fixture();
    await expect(
      readOnlyGitConfigPairs(path.join(os.tmpdir(), "f5-missing-readonly-git-dir"), environment),
    ).rejects.toThrow("couldn't read the Git config");
  });
});

describe("withReadOnlyGitConfig", () => {
  // The helpers are POSIX shell snippets.
  it.skipIf(process.platform === "win32")(
    "makes Git refuse the repository's helpers instead of running them",
    async () => {
      const { repo, environment, helpersRun } = fixture();
      // Without the overrides, these reads run every helper.
      expect(helpersRun(environment)).toEqual([...HELPERS]);
      expect(helpersRun(await withReadOnlyGitConfig(environment, repo))).toEqual([]);
    },
  );

  it("appends after the Git config the environment already carries", async () => {
    const { repo, environment } = fixture();
    const env = await withReadOnlyGitConfig(
      {
        ...environment,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "include.path",
        GIT_CONFIG_VALUE_0: "/profile.gitconfig",
      },
      repo,
    );
    expect(env.GIT_CONFIG_KEY_0).toBe("include.path");
    expect(env.GIT_CONFIG_KEY_1).toBe("core.fsmonitor");
    expect(Number(env.GIT_CONFIG_COUNT)).toBeGreaterThan(2);
  });
});
