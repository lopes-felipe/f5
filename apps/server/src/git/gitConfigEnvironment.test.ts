import * as Path from "node:path";
import { describe, expect, it } from "vitest";
import { fallbackDefaultProfile } from "../profiles/ProfileRegistryStore";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv";
import {
  appendGitConfigPairs,
  profileGitAuthorConfigPath,
  profileSessionGitConfigPairs,
  renderProfileGitAuthorConfig,
} from "./gitConfigEnvironment";
import { githubLauncherDir } from "./GithubCliLauncher";

const pairsOf = (env: NodeJS.ProcessEnv) =>
  Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, index) => [
    env[`GIT_CONFIG_KEY_${index}`],
    env[`GIT_CONFIG_VALUE_${index}`],
  ]);

describe("appendGitConfigPairs", () => {
  it("appends after existing entries", () => {
    const env = appendGitConfigPairs(
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" },
      [["a.b", "c"]],
    );
    expect(pairsOf(env)).toEqual([
      ["core.pager", "cat"],
      ["a.b", "c"],
    ]);
  });

  it("rejects a corrupt count", () => {
    expect(() => appendGitConfigPairs({ GIT_CONFIG_COUNT: "x" }, [["a.b", "c"]])).toThrow(
      /GIT_CONFIG_COUNT/,
    );
  });
});

describe("renderProfileGitAuthorConfig", () => {
  it("quotes values and requires both fields", () => {
    expect(renderProfileGitAuthorConfig(' A "B" \\C ', "a@example.com")).toContain(
      '\tname = "A \\"B\\" \\\\C"\n\temail = "a@example.com"',
    );
    expect(renderProfileGitAuthorConfig("A", "")).not.toContain("[user]");
    expect(renderProfileGitAuthorConfig("A\nB", "a@example.com")).not.toContain("[user]");
  });
});

describe("agent and terminal Git configuration", () => {
  const stateDir = Path.resolve("git-config-env-test");
  const shellPath = (value: string) =>
    process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  const helper = `!ELECTRON_RUN_AS_NODE=1 '${shellPath(process.execPath)}' '${shellPath(
    Path.join(githubLauncherDir(stateDir), "gh.cjs"),
  )}' auth git-credential`;

  it("Default keeps repository identity, inherited entries, and workstation helpers", () => {
    const env = buildAccountExecutionEnvironment({
      purpose: "terminal",
      stateDir,
      profile: fallbackDefaultProfile(stateDir),
      baseEnv: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.useConfigOnly",
        GIT_CONFIG_VALUE_0: "1",
      },
    });
    expect(pairsOf(env)).toEqual([["user.useConfigOnly", "1"]]);
  });

  it("isolated profiles scope the profile helper to GitHub hosts only", () => {
    const env = buildAccountExecutionEnvironment({
      purpose: "provider",
      stateDir,
      profile: { ...fallbackDefaultProfile(stateDir), isDefault: false },
      baseEnv: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "x",
      },
    });
    // No projection on disk: github.com is always known. No unscoped helper reset, so
    // non-GitHub hosts keep their inherited (system) helpers.
    expect(pairsOf(env)).toEqual([
      ["include.path", profileGitAuthorConfigPath(stateDir)],
      ["credential.https://github.com.helper", ""],
      ["credential.https://github.com.helper", helper],
    ]);
  });

  it("does not add session Git configuration to account processes", () => {
    const env = buildAccountExecutionEnvironment({
      purpose: "account",
      stateDir,
      profile: fallbackDefaultProfile(stateDir),
      baseEnv: {},
    });
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("quotes helper paths and runs node directly (no gh.cmd through sh on Windows)", () => {
    const pairs = profileSessionGitConfigPairs({
      stateDir: "/s",
      launcherDir: "/it's/bin",
      isolated: true,
      githubHosts: ["github.com", "ghe.example.com"],
      execPath: "/opt/node",
      platform: "linux",
    });
    expect(pairs.at(-1)).toEqual([
      "credential.https://ghe.example.com.helper",
      `!ELECTRON_RUN_AS_NODE=1 '/opt/node' '/it'"'"'s/bin/gh.cjs' auth git-credential`,
    ]);
    const windows = profileSessionGitConfigPairs({
      stateDir: "C:\\s",
      launcherDir: "C:\\Users\\me\\bin",
      isolated: true,
      githubHosts: ["github.com"],
      execPath: "C:\\Program Files\\F5\\F5.exe",
      platform: "win32",
    });
    expect(windows.at(-1)?.[1]).toBe(
      `!ELECTRON_RUN_AS_NODE=1 'C:/Program Files/F5/F5.exe' 'C:/Users/me/bin/gh.cjs' auth git-credential`,
    );
    expect(
      profileSessionGitConfigPairs({
        stateDir: "/s",
        launcherDir: "/b",
        isolated: false,
        githubHosts: ["github.com"],
      }),
    ).toEqual([]);
  });
});
