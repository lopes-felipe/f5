import { describe, expect, it } from "vitest";
import { appendGitConfigPairs } from "./gitConfigEnvironment.ts";
import { isManagedGitCommand, managedGitProcessEnvironment } from "./gitProcessEnvironment.ts";

describe("managed Git environment", () => {
  it("preserves inherited entries and credentials without changing the caller", () => {
    const original = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "fixture-helper",
      GH_TOKEN: "fixture-token",
      GIT_OPTIONAL_LOCKS: "1",
    };
    const next = managedGitProcessEnvironment(original, "linux");
    expect(original.GIT_CONFIG_COUNT).toBe("1");
    expect(original.GIT_OPTIONAL_LOCKS).toBe("1");
    expect(next).toMatchObject({
      ...original,
      GIT_CONFIG_COUNT: "2",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_KEY_1: "safe.bareRepository",
      GIT_CONFIG_VALUE_1: "explicit",
    });
  });
  it("handles opposing count spellings and enables long paths on Windows", () => {
    const next = managedGitProcessEnvironment(
      {
        GIT_CONFIG_COUNT: "0",
        git_config_count: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "fixture-helper",
      },
      "win32",
    );
    expect(next).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      git_config_count: "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "fixture-helper",
      GIT_CONFIG_KEY_1: "safe.bareRepository",
      GIT_CONFIG_VALUE_1: "explicit",
      GIT_CONFIG_KEY_2: "core.longpaths",
      GIT_CONFIG_VALUE_2: "true",
    });
  });
  it("ignores noncanonical environment spellings outside Windows", () => {
    const next = managedGitProcessEnvironment({ git_config_count: "9" }, "linux");
    expect(next.GIT_CONFIG_COUNT).toBe("1");
    expect(next.GIT_CONFIG_KEY_0).toBe("safe.bareRepository");
    expect(next.GIT_CONFIG_KEY_1).toBeUndefined();
  });
  it("uses Git's count syntax and rejects malformed counts without echoing their values", () => {
    for (const raw of ["", "0", "-0", "+0", " +1", "0001"]) {
      const next = appendGitConfigPairs({ GIT_CONFIG_COUNT: raw }, [["a.b", "c"]], "linux");
      expect(next.GIT_CONFIG_COUNT).toBe(String(Number(raw) + 1));
    }
    for (const raw of ["1e2", "1 ", "-1", "Infinity", "count-private-fixture"]) {
      expect(() =>
        appendGitConfigPairs({ GIT_CONFIG_COUNT: raw }, [["a.b", "c"]], "linux"),
      ).toThrow("Invalid GIT_CONFIG_COUNT.");
    }
  });
  it("recognizes native Git and GitHub CLI paths while keeping other subprocesses unchanged", () => {
    for (const command of [
      "git",
      "/usr/bin/git",
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "gh",
      "gh.cmd",
    ]) {
      expect(isManagedGitCommand(command)).toBe(true);
    }
    for (const command of ["node", "claude", "ps", "/tmp/my-git", "github-client"]) {
      expect(isManagedGitCommand(command)).toBe(false);
    }
  });
});
