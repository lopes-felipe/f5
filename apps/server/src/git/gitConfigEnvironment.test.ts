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
  const launcher = Path.join(
    githubLauncherDir(stateDir),
    process.platform === "win32" ? "gh.cmd" : "gh",
  );

  it("Default keeps inherited entries and workstation helpers, adding only the author include", () => {
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
    expect(pairsOf(env)).toEqual([
      ["user.useConfigOnly", "1"],
      ["include.path", profileGitAuthorConfigPath(stateDir)],
    ]);
  });

  it("isolated profiles reset inherited helpers and use the profile launcher", () => {
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
    const helperPath = process.platform === "win32" ? launcher.replaceAll("\\", "/") : launcher;
    expect(pairsOf(env)).toEqual([
      ["include.path", profileGitAuthorConfigPath(stateDir)],
      ["credential.helper", ""],
      ["credential.helper", `!'${helperPath}' auth git-credential`],
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

  it("quotes helper paths with single quotes", () => {
    const [, , helper] = profileSessionGitConfigPairs({
      stateDir: "/s",
      launcherDir: "/it's/bin",
      isolated: true,
      platform: "linux",
    });
    expect(helper).toEqual(["credential.helper", `!'/it'"'"'s/bin/gh' auth git-credential`]);
  });
});
