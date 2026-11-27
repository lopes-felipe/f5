import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_HOOK_ON_FAILURE_MIN_VERSION,
  claudeHookOnFailureSupported,
  claudeReadOnlyStageRuntimeConflict,
} from "./claudeExecutableVersion.ts";
import { buildClaudeFlagPermissions } from "./claudeFlagPermissions.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("buildClaudeFlagPermissions", () => {
  it("lists absolute exemptions with their resolved spelling and skips roots and relatives", () => {
    const root = mkdtempSync(NodePath.join(tmpdir(), "f5-flag-permissions-"));
    roots.push(root);
    const link = NodePath.join(root, "attachments-link");
    symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
    const permissions = buildClaudeFlagPermissions({
      readExemptDirectories: [link, "/", "relative/plans", undefined, "/f5-missing/plans"],
    });
    expect(permissions.blockReadsExemptPaths).toEqual([
      link,
      realpathSync(root),
      NodePath.resolve("/f5-missing/plans"),
    ]);
    expect(permissions).not.toHaveProperty("blockWritesOutsideWorkingDirectories");
  });

  it("confines writes only when enabled and omits empty exemptions", () => {
    expect(buildClaudeFlagPermissions({ readExemptDirectories: [] })).toEqual({});
    expect(
      buildClaudeFlagPermissions({ readExemptDirectories: [], confineWritesToWorkspace: true }),
    ).toEqual({ blockWritesOutsideWorkingDirectories: true });
  });
});

describe("claudeHookOnFailureSupported", () => {
  it.each([
    [undefined, undefined, true],
    ["claude", undefined, true],
    ["/opt/claude", undefined, false],
    ["/opt/claude", "2.1.316", false],
    ["/opt/claude", CLAUDE_HOOK_ON_FAILURE_MIN_VERSION, true],
    ["/opt/claude", "2.2.0", true],
  ] as const)("binary=%s version=%s → %s", (binary, version, expected) => {
    expect(claudeHookOnFailureSupported(binary, version)).toBe(expected);
    // A read-only stage runs exactly where a failing hook blocks the tool.
    expect(claudeReadOnlyStageRuntimeConflict(binary, version) === undefined).toBe(expected);
  });

  it("says which executable and version a read-only stage can't use", () => {
    expect(claudeReadOnlyStageRuntimeConflict("/opt/claude", "2.1.316")).toContain(
      "the custom executable `/opt/claude`: it reports version 2.1.316, and a stage needs Claude Code 2.1.317 or later",
    );
    expect(claudeReadOnlyStageRuntimeConflict("/opt/claude", undefined)).toContain(
      "F5 couldn't read its version",
    );
  });
});
