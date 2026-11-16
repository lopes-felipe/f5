import { describe, expect, it } from "vitest";
import {
  gitConfigArgs,
  literalGitPathspec,
  resolveAutoFeatureBranchName,
  sanitizeFeatureBranchName,
} from "./git";

describe("sanitizeFeatureBranchName", () => {
  it.each(["feature", "fix", "team/jules"])("preserves the %s namespace", (namespace) => {
    expect(sanitizeFeatureBranchName(`${namespace}/refine-toolbar`)).toBe(
      `${namespace}/refine-toolbar`,
    );
  });

  it("sanitizes an explicit namespace before preserving it", () => {
    expect(sanitizeFeatureBranchName(' "FIX//Calendar recruitment filter" ')).toBe(
      "fix/calendar-recruitment-filter",
    );
  });

  it.each([
    ["refine toolbar", "feature/refine-toolbar"],
    ["", "feature/update"],
    ["fix///", "feature/fix"],
  ])("keeps the feature fallback for unprefixed input %j", (input, expected) => {
    expect(sanitizeFeatureBranchName(input)).toBe(expected);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("resolves case-insensitive collisions within the generated namespace", () => {
    expect(
      resolveAutoFeatureBranchName(
        ["FIX/refine-toolbar", "fix/refine-toolbar-2"],
        "fix/refine-toolbar",
      ),
    ).toBe("fix/refine-toolbar-3");
  });

  it("keeps the fallback when no preferred branch is supplied", () => {
    expect(resolveAutoFeatureBranchName(["feature/update"])).toBe("feature/update-2");
  });

  it.each([
    ["fix/name", ["fix"], "fix-2/name"],
    ["team/jules/fix/name", ["team/jules"], "team/jules-2/fix/name"],
    ["fix/name", ["fix/name/child"], "fix/name-2"],
    ["fix/name", ["fixes", "fix/name-extra/child"], "fix/name"],
  ])("resolves %s against namespace blockers %j", (preferredBranch, existingNames, expected) => {
    expect(resolveAutoFeatureBranchName(existingNames, preferredBranch)).toBe(expected);
  });
});

describe("Git argument boundaries", () => {
  it("preserves pathspec magic and wildcard filenames as literal paths", () => {
    expect(literalGitPathspec(":(glob)**")).toBe(":(literal):(glob)**");
    expect(literalGitPathspec("src/[a]*.ts")).toBe(":(literal)src/[a]*.ts");
  });
  it("permits app-owned safety and durability overrides", () => {
    expect(
      gitConfigArgs([
        ["status.showUntrackedFiles", "all"],
        ["core.fsyncMethod", "batch"],
      ]),
    ).toEqual(["-c", "status.showUntrackedFiles=all", "-c", "core.fsyncMethod=batch"]);
  });
  it("rejects executable overrides, includes and multiline values", () => {
    for (const key of ["core.sshCommand", "alias.run", "include.path", "--global"])
      expect(() => gitConfigArgs([[key, "payload"]])).toThrow("Unsupported");
    expect(() => gitConfigArgs([["core.fsmonitor", "false\ninclude.path=x"]])).toThrow(
      "Unsupported",
    );
  });
});
