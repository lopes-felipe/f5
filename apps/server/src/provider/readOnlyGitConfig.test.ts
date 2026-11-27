import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  makeReadOnlyGitGuard,
  parseScopedGitConfigKeys,
  readOnlyGitConfigPairs,
  withReadOnlyGitConfig,
} from "./readOnlyGitConfig.ts";
import { READ_ONLY_WORKFLOW_ENVIRONMENT } from "./readOnlyWorkflowShell.ts";

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
    expect(pairs.toSorted()).toEqual([
      ["core.fsmonitor", "false"],
      ["diff.external", ""],
      ["diff.helper.command", ""],
      // `cat` passes the content through, so the read still works.
      ["diff.helper.textconv", "cat"],
      ["filter.helper.clean", "cat"],
      ["gpg.program", ""],
    ]);
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

  it.skipIf(process.platform === "win32")(
    "keeps a diff working when the repository has a textconv and a required filter",
    async () => {
      const { repo, environment } = fixture();
      const git = (args: string[], env: NodeJS.ProcessEnv) =>
        execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", stdio: "pipe" });
      git(["config", "--unset", "diff.external"], environment);
      git(["config", "--unset", "diff.helper.command"], environment);
      git(["config", "filter.helper.required", "true"], environment);
      git(["config", "filter.helper.process", `sh -c 'touch "$F5_MARKERS/process"'`], environment);
      expect(await readOnlyGitConfigPairs(repo, environment)).toEqual(
        expect.arrayContaining([
          // A filter process has no pass-through stand-in, so the filter stops being required.
          ["filter.helper.process", ""],
          ["filter.helper.required", "false"],
        ]),
      );
      const markers = mkdtempSync(path.join(os.tmpdir(), "f5-readonly-git-markers-"));
      const guarded = { ...(await withReadOnlyGitConfig(environment, repo)), F5_MARKERS: markers };
      // An emptied textconv or required filter would fail the whole command.
      expect(git(["diff"], guarded)).toContain("+two");
      expect(git(["status", "--short"], guarded)).toContain("notes.txt");
      expect(readdirSync(markers)).toEqual([]);
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

describe("READ_ONLY_WORKFLOW_ENVIRONMENT", () => {
  const gitVersion = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
  // `GIT_NO_LAZY_FETCH` came with Git 2.45.
  const lazyFetchSwitch =
    gitVersion !== null && Number(gitVersion[1]) * 100 + Number(gitVersion[2]) >= 245;

  it.skipIf(!lazyFetchSwitch || process.platform === "win32")(
    "keeps a read of a missing object from fetching it in a partial clone",
    () => {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "f5-readonly-git-partial-")));
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: path.join(root, "global.gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      };
      writeFileSync(environment.GIT_CONFIG_GLOBAL!, '[protocol "file"]\n\tallow = always\n');
      const git = (args: string[], env: NodeJS.ProcessEnv = environment) =>
        execFileSync("git", args, { env, encoding: "utf8", stdio: "pipe" });
      const source = path.join(root, "source");
      git(["init", "-q", source]);
      for (const [key, value] of [
        ["user.email", "test@example.com"],
        ["user.name", "Test"],
        ["commit.gpgsign", "false"],
        ["uploadpack.allowFilter", "true"],
        ["uploadpack.allowAnySHA1InWant", "true"],
      ])
        git(["-C", source, "config", key!, value!]);
      writeFileSync(path.join(source, "notes.txt"), "stored\n");
      git(["-C", source, "add", "."]);
      git(["-C", source, "commit", "-qm", "init"]);
      const clone = path.join(root, "clone");
      // Blobs are left out and nothing is checked out, so `notes.txt` is a missing object.
      git(["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${source}`, clone]);
      expect(() =>
        git(["-C", clone, "show", "HEAD:notes.txt"], {
          ...environment,
          ...READ_ONLY_WORKFLOW_ENVIRONMENT,
        }),
      ).toThrow();
      // Without the switch the same read fetches the blob from the remote.
      expect(git(["-C", clone, "show", "HEAD:notes.txt"])).toBe("stored\n");
    },
  );
});

describe("makeReadOnlyGitGuard", () => {
  /**
   * A path as a shell command writes it. The guard reads commands as POSIX shell, where a
   * backslash escapes the next character, so a Windows path is written with forward slashes.
   */
  const written = (value: string) => value.replaceAll("\\", "/");

  /**
   * A stage folder that is a repository without helpers, next to a second repository, with
   * `git` bound to a folder and the isolated environment. The native realpath expands a
   * Windows short name such as `RUNNER~1`, as Git does in the paths it prints.
   */
  function workspace() {
    const root = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), "f5-readonly-git-guard-")),
    );
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: path.join(root, "global.gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    writeFileSync(
      environment.GIT_CONFIG_GLOBAL!,
      '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n',
    );
    const git = (directory: string, args: string[]) =>
      execFileSync("git", ["-C", directory, ...args], {
        env: environment,
        encoding: "utf8",
        stdio: "pipe",
      });
    const init = (name: string) => {
      const directory = path.join(root, name);
      mkdirSync(directory, { recursive: true });
      git(directory, ["init", "-q"]);
      git(directory, ["config", "user.email", "test@example.com"]);
      git(directory, ["config", "user.name", "Test"]);
      git(directory, ["config", "commit.gpgsign", "false"]);
      writeFileSync(path.join(directory, "notes.txt"), "one\n");
      git(directory, ["add", "."]);
      git(directory, ["commit", "-qm", "init"]);
      return directory;
    };
    return { root, environment, git, init, stage: init("stage") };
  }

  it("lets Git run in the stage's repository and in one without helpers", async () => {
    const { stage, init, environment } = workspace();
    const other = init("other");
    const guard = await makeReadOnlyGitGuard(stage, environment);
    expect(guard.pairs).toEqual([["core.fsmonitor", "false"]]);
    for (const command of [
      "git status --short",
      `git -C ${written(other)} log --oneline -1`,
      `cd ${written(other)} && git diff`,
      "git -C ../other diff",
      // Your own global helpers are not the repository's.
      "git diff | head -5",
    ])
      expect(await guard.refusal(command), command).toBeUndefined();
  });

  it("says nothing about a command that runs no Git, or that the classifier refuses", async () => {
    const { stage, init, git, environment } = workspace();
    const other = init("other");
    git(other, ["config", "diff.external", "./x.sh"]);
    const guard = await makeReadOnlyGitGuard(stage, environment);
    expect(await guard.refusal(`cd ${written(other)} && cat notes.txt`)).toBeUndefined();
    expect(await guard.refusal(`cd ${written(other)} && git commit -m x`)).toBeUndefined();
  });

  it.each([
    ["git -C <other> diff", (other: string) => `git -C ${written(other)} diff`],
    ["git -C ../other log -p", () => "git -C ../other log -p"],
    ["cd <other> && git diff", (other: string) => `cd ${written(other)} && git diff`],
    ["cd <other>; git status", (other: string) => `cd ${written(other)}; git status --short`],
    ["cd .. && git -C other show", () => "cd .. && git -C other show HEAD"],
    ["a folder in a variable", (other: string) => `D=${written(other)}; git -C $D diff`],
    [
      "git -C <a> -C <b>",
      (other: string) => `git -C ${written(path.dirname(other))} -C other diff`,
    ],
  ])("refuses Git in another repository that defines a helper: %s", async (_name, command) => {
    const { stage, init, git, environment } = workspace();
    const other = init("other");
    git(other, ["config", "diff.external", "./x.sh"]);
    const guard = await makeReadOnlyGitGuard(stage, environment);
    const refusal = await guard.refusal(command(other));
    expect(refusal).toContain(`the Git config of ${other} sets \`diff.external\``);
    expect(refusal).toContain("read that repository with `gh` or F5's forge tools");
  });

  it("refuses Git in a nested repository that defines a helper", async () => {
    const { stage, init, git, environment } = workspace();
    const nested = init("stage/scratch");
    git(nested, ["config", "diff.driver.textconv", "./x.sh"]);
    const guard = await makeReadOnlyGitGuard(stage, environment);
    expect(await guard.refusal("git -C scratch diff")).toContain("`diff.driver.textconv`");
    expect(await guard.refusal("cd scratch && git log -p")).toContain("`diff.driver.textconv`");
    // The stage's own repository doesn't read it: the folder is only untracked there.
    expect(await guard.refusal("git status --short")).toBeUndefined();
  });

  it("uses the folder a request says the command starts in", async () => {
    const { stage, init, git, environment } = workspace();
    const other = init("other");
    git(other, ["config", "filter.x.clean", "./x.sh"]);
    const guard = await makeReadOnlyGitGuard(stage, environment);
    expect(await guard.refusal("git status --short", other)).toContain("`filter.x.clean`");
    expect(await guard.refusal("git status --short", stage)).toBeUndefined();
  });

  it("refuses a helper added to the stage's repository after the stage started", async () => {
    const { stage, git, environment } = workspace();
    git(stage, ["config", "diff.early.textconv", "./early.sh"]);
    const guard = await makeReadOnlyGitGuard(stage, environment);
    // Present at the start: overridden, so Git can run.
    expect(guard.pairs).toContainEqual(["diff.early.textconv", "cat"]);
    expect(await guard.refusal("git diff")).toBeUndefined();
    git(stage, ["config", "diff.late.textconv", "./late.sh"]);
    expect(await guard.refusal("git diff")).toContain(
      `the Git config of ${stage} sets \`diff.late.textconv\``,
    );
    // So is another program of a filter whose `clean` was overridden.
    git(stage, ["config", "--unset", "diff.late.textconv"]);
    git(stage, ["config", "filter.early.clean", "./clean.sh"]);
    const filtered = await makeReadOnlyGitGuard(stage, environment);
    expect(await filtered.refusal("git status")).toBeUndefined();
    git(stage, ["config", "filter.early.process", "./process.sh"]);
    expect(await filtered.refusal("git status")).toContain("`filter.early.process`");
  });

  it("refuses Git in a repository whose submodule defines a helper", async () => {
    const { root, stage, init, git, environment } = workspace();
    const library = init("library");
    git(stage, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "lib"]);
    git(stage, ["commit", "-qm", "add submodule"]);
    const guard = await makeReadOnlyGitGuard(stage, environment);
    expect(await guard.refusal("git status --short")).toBeUndefined();
    // Git keeps the submodule's repository, and its config, under the parent's `modules/`.
    const moduleDirectory = path.join(stage, ".git", "modules", "lib");
    execFileSync("git", ["--git-dir", moduleDirectory, "config", "filter.x.clean", "./x.sh"], {
      env: environment,
    });
    const refusal = await guard.refusal("git status --short");
    expect(refusal).toContain("`filter.x.clean`");
    expect(refusal).toContain(moduleDirectory);
    expect(await guard.refusal(`cd ${written(root)} && git -C stage diff`)).toContain(
      "`filter.x.clean`",
    );
  });

  it("refuses Git in a repository that tracks a nested repository with a helper", async () => {
    const { stage, init, git, environment } = workspace();
    const nested = init("stage/vendor");
    // The index records the nested repository as a submodule; its config stays in its own `.git`.
    git(stage, ["add", "vendor"]);
    const guard = await makeReadOnlyGitGuard(stage, environment);
    expect(await guard.refusal("git status --short")).toBeUndefined();
    git(nested, ["config", "filter.x.clean", "./x.sh"]);
    expect(await guard.refusal("git status --short")).toContain(
      `the Git config of ${nested} sets \`filter.x.clean\``,
    );
  });

  it("refuses a folder it can't work out", async () => {
    const { stage, environment } = workspace();
    const guard = await makeReadOnlyGitGuard(stage, environment);
    expect(await guard.refusal("cd stage other && git status")).toContain(
      "F5 can't tell which folder this `cd` leads to",
    );
    expect(await guard.refusal("git -C ~someone/repo status")).toContain(
      "F5 can't tell which folder this `git -C` leads to",
    );
    // A folder that doesn't exist: Git fails there, and nothing runs.
    expect(await guard.refusal("git -C ./missing status")).toBeUndefined();
    expect(await guard.refusal("cd - && git status")).toBeUndefined();
    expect(await guard.refusal("cd && git -C stage status")).toBeUndefined();
  });

  it("refuses when Git can't read a repository's config", async () => {
    const { stage, init, environment } = workspace();
    const other = init("other");
    writeFileSync(path.join(other, ".git", "config"), "[core\n");
    const guard = await makeReadOnlyGitGuard(stage, environment);
    expect(await guard.refusal(`git -C ${written(other)} status`)).toContain(
      `F5 couldn't read the Git config of ${other}`,
    );
  });
});
