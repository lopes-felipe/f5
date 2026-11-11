import { describe, expect, it } from "vitest";
import { runsGitWithoutConsole } from "./resolveCommand";

describe("console-free Git reads", () => {
  const git = "C:\\Program Files\\Git\\ucrt64\\bin\\git.exe";
  it.each([
    [["rev-parse", "--git-path", "index"], true],
    [["--git-dir", "C:\\repo\\.git", "symbolic-ref", "refs/remotes/origin/HEAD"], true],
    [["remote", "get-url", "--", "origin"], true],
    [["config", "--get", "branch.main.pushRemote"], true],
    [["config", "--get", "--", "branch.main.pushRemote"], true],
    [["config", "--get", "--", "remote.pushDefault"], true],
    [["config", "--get", "--", "branch.main.gh-merge-base"], true],
    [["config", "--get", "--", "branch.autoSetupMerge"], true],
    [["rev-parse", "--path-format=absolute", "--git-path", "index"], true],
    [["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"], true],
    [["rev-parse", "--path-format=absolute", "--git-common-dir"], true],
    [["rev-parse", "--path-format=absolute", "--show-toplevel"], true],
    [["remote", "-v"], true],
    [["symbolic-ref", "--quiet", "HEAD"], true],
    [["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true],
    [["rev-parse", "HEAD"], false],
    [["symbolic-ref", "HEAD", "refs/heads/x"], false],
    [["symbolic-ref", "-qd", "refs/remotes/origin/HEAD"], false],
    [["config", "--get", "--edit"], false],
    [["config", "--get", "--", "user.name", "--edit"], false],
    [["remote", "update"], false],
    [["rev-parse", "--path-format=absolute", "HEAD"], false],
    [["-c", "core.pager=x", "config", "--get", "user.name"], false],
  ] as const)("classifies %j as %s", (args, expected) => {
    expect(runsGitWithoutConsole("win32", git, args)).toBe(expected);
  });
  it.each([
    ["win32", "C:\\Program Files\\Git\\cmd\\git.exe"],
    ["win32", "C:\\Users\\x\\scoop\\shims\\git.exe"],
    ["linux", git],
  ] as const)("keeps console on %s for %s", (platform, executable) => {
    expect(runsGitWithoutConsole(platform, executable, ["remote"])).toBe(false);
  });
});
