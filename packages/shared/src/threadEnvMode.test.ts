import { describe, expect, it } from "vitest";

import { nonDefaultThreadEnvMode, resolveThreadEnvMode } from "./threadEnvMode";

describe("resolveThreadEnvMode", () => {
  it("uses explicit, project, and global values in precedence order", () => {
    expect(
      resolveThreadEnvMode({
        requested: "local",
        projectDefault: "worktree",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(resolveThreadEnvMode({ projectDefault: "worktree", globalDefault: "local" })).toBe(
      "worktree",
    );
    expect(resolveThreadEnvMode({ globalDefault: "local" })).toBe("local");
  });
});

describe("nonDefaultThreadEnvMode", () => {
  it("returns the opposite environment mode", () => {
    expect(nonDefaultThreadEnvMode("local")).toBe("worktree");
    expect(nonDefaultThreadEnvMode("worktree")).toBe("local");
  });
});
