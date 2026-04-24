import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

import { installLocalPushFriendlyGitWrapper } from "./testUtils.ts";

describe("installLocalPushFriendlyGitWrapper", () => {
  it("is reference counted", () => {
    const restoreA = installLocalPushFriendlyGitWrapper();
    const restoreB = installLocalPushFriendlyGitWrapper();
    const wrapperDir = process.env.PATH?.split(delimiter)[0] ?? "";

    expect(process.env.T3_REAL_GIT_BIN).toBeTruthy();
    expect(wrapperDir.length).toBeGreaterThan(0);
    expect(existsSync(join(wrapperDir, "git-wrapper.cjs"))).toBe(true);
    expect(existsSync(join(wrapperDir, process.platform === "win32" ? "git.cmd" : "git"))).toBe(
      true,
    );

    restoreB();
    expect(process.env.T3_REAL_GIT_BIN).toBeTruthy();
    expect(existsSync(wrapperDir)).toBe(true);

    restoreA();
    expect(process.env.T3_REAL_GIT_BIN).toBeUndefined();
    expect(existsSync(wrapperDir)).toBe(false);
  });
});
