import { expect, it } from "vitest";
import { worktreePathExceedsWindowsLimit, worktreePathSlug } from "./worktreePaths.ts";

it("bounds portable labels and retains a fixed fallback for empty labels", () => {
  expect(worktreePathSlug("/ fix/login ")).toBe("fix-login");
  expect(worktreePathSlug("a".repeat(100))).toHaveLength(32);
  expect(worktreePathSlug("... 💻 /")).toBe("wt");
});
it("counts the Windows path limit in UTF-16 units, including surrogate pairs", () => {
  expect(worktreePathExceedsWindowsLimit("x".repeat(180), "win32")).toBe(false);
  expect(worktreePathExceedsWindowsLimit("x".repeat(179) + "💻", "win32")).toBe(true);
  expect(worktreePathExceedsWindowsLimit("x".repeat(500), "darwin")).toBe(false);
});
