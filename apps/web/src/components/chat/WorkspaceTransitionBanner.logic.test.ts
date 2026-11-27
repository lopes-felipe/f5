import { ThreadId, type WorkspaceTransitionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  describeWorkspaceSwitch,
  workspaceSwitchIsRunning,
} from "./WorkspaceTransitionBanner.logic";

const source = { path: "/project", repository: "/project/.git", branch: "main", headSha: "base" };
const transition = (patch: Partial<WorkspaceTransitionSnapshot>): WorkspaceTransitionSnapshot => ({
  operationId: "switch",
  threadId: ThreadId.makeUnsafe("thread"),
  version: 1,
  intent: "attach_existing",
  phase: "applying",
  source,
  target: { ...source, path: "/managed/repo-1a2b/topic-3c4d", branch: "topic" },
  observed: null,
  result: null,
  error: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  ...patch,
});

describe("workspaceSwitchIsRunning", () => {
  it.each(["reserved", "stopping", "applying", "applied"] as const)("holds at %s", (phase) => {
    expect(workspaceSwitchIsRunning(transition({ phase }))).toBe(true);
  });

  it.each(["needs_recovery", "completed", "failed", "cancelled"] as const)(
    "holds nothing at %s",
    (phase) => {
      expect(workspaceSwitchIsRunning(transition({ phase }))).toBe(false);
    },
  );

  it("holds nothing without a switch", () => {
    expect(workspaceSwitchIsRunning(null)).toBe(false);
    expect(workspaceSwitchIsRunning(undefined)).toBe(false);
  });
});

describe("describeWorkspaceSwitch", () => {
  it.each([
    ["move_to_new_worktree", "Moving this thread to a new worktree…"],
    ["use_project_checkout", "Moving this thread to the project folder…"],
    ["attach_existing", "Switching to topic-3c4d…"],
    ["checkout_branch", "Switching to topic…"],
    ["create_branch_and_checkout", "Switching to topic…"],
    ["recreate", "Restoring the worktree…"],
    ["recreate_from_base", "Restoring the worktree…"],
  ] as const)("names what %s is doing", (intent, text) => {
    expect(describeWorkspaceSwitch(transition({ intent }))).toBe(text);
  });

  it("names the folder of a Windows path and copes with a missing branch", () => {
    expect(
      describeWorkspaceSwitch(
        transition({ target: { ...source, path: "C:\\managed\\topic", branch: "topic" } }),
      ),
    ).toBe("Switching to topic…");
    expect(
      describeWorkspaceSwitch(
        transition({ intent: "checkout_branch", target: { ...source, branch: null } }),
      ),
    ).toBe("Switching branch…");
  });
});
