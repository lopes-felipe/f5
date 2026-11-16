import type { GitBranch } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceRows,
  type WorkspaceRow,
  type WorkspaceRowsInput,
  workspaceTriggerLabel,
} from "./WorkspacePicker.logic";

const branch = (name: string, overrides: Partial<GitBranch> = {}): GitBranch => ({
  name,
  current: false,
  isDefault: false,
  worktreePath: null,
  ...overrides,
});

const branches: ReadonlyArray<GitBranch> = [
  branch("fix/sidebar", { current: true, worktreePath: "/repo" }),
  branch("feature/a"),
  branch("main", { isDefault: true }),
  branch("fix/route", { worktreePath: "/wt/route" }),
  branch("origin/remote-only", { isRemote: true, remoteName: "origin" }),
];

const input = (overrides: Partial<WorkspaceRowsInput> = {}): WorkspaceRowsInput => ({
  mode: "pick",
  query: "",
  isDraft: true,
  threadId: "me",
  state: { kind: "local" },
  creatingWorktree: false,
  projectCwd: "/repo",
  projectBranch: "fix/sidebar",
  branches,
  linkedThreads: new Map([
    ["/repo", [{ threadId: "a" }, { threadId: "b" }, { threadId: "me" }]],
    ["/wt/route", [{ threadId: "c" }]],
  ]),
  checkoutMissing: false,
  prReference: null,
  canCheckoutPullRequest: true,
  multiModel: false,
  canMove: false,
  moveDisabled: false,
  hasCompletedMove: false,
  switchBlockedReason: null,
  ...overrides,
});

/** Compact, readable picture of the rows. */
const outline = (rows: ReadonlyArray<WorkspaceRow>) =>
  rows.map((row) => {
    switch (row.kind) {
      case "header":
        return `# ${row.label}`;
      case "notice":
        return `! ${row.text}`;
      case "local":
        return `local ${row.branch} (${row.threadCount})${row.selected ? " *" : ""}`;
      case "newWorktree":
        return `new ${row.branch}${row.selected ? " *" : ""}`;
      case "openWorktree":
        return `open ${row.branch} ${row.path} (${row.threadCount})${row.selected ? " *" : ""}`;
      case "newBranchWorktree":
        return `new-branch ${row.name} from ${row.base}`;
      case "pullRequest":
        return `pr ${row.reference}`;
      case "action":
        return `action ${row.label}${row.disabled ? " (disabled)" : ""}`;
      case "back":
        return "back";
      case "switchTarget":
        return `switch ${row.branch}${row.current ? " current" : ""}${row.disabled ? " (disabled)" : ""}`;
      case "createBranchHere":
        return `create ${row.name}${row.disabled ? " (disabled)" : ""}`;
    }
  });

describe("buildWorkspaceRows", () => {
  it("offers a local draft the project folder, new worktrees (default first) and open worktrees", () => {
    expect(outline(buildWorkspaceRows(input()))).toEqual([
      "# Project folder",
      "local fix/sidebar (2) *",
      "# New worktree from",
      "new main",
      "new fix/sidebar",
      "new feature/a",
      "new origin/remote-only",
      "# Open worktrees",
      "open fix/route /wt/route (1)",
      "# Manage",
      "action Switch branch here…",
      "action Manage worktrees…",
    ]);
  });

  it("marks the selected base of a new-worktree draft and drops the in-place switch", () => {
    const rows = outline(
      buildWorkspaceRows(input({ state: { kind: "newWorktree", base: "main" } })),
    );
    expect(rows).toContain("new main *");
    expect(rows).toContain("local fix/sidebar (2)");
    expect(rows).not.toContain("action Switch branch here…");
  });

  it("keeps the default branch under New worktree even when another worktree has it", () => {
    const rows = outline(
      buildWorkspaceRows(
        input({ branches: [branch("main", { isDefault: true, worktreePath: "/wt/main" })] }),
      ),
    );
    expect(rows).toContain("new main");
    expect(rows).toContain("open main /wt/main (0)");
  });

  it("hides New worktree for a started thread and offers its moves", () => {
    const rows = outline(
      buildWorkspaceRows(input({ isDraft: false, canMove: true, moveDisabled: true })),
    );
    expect(rows.some((row) => row.startsWith("new "))).toBe(false);
    expect(rows).toEqual([
      "# Project folder",
      "local fix/sidebar (2) *",
      "# Open worktrees",
      "open fix/route /wt/route (1)",
      "# Manage",
      "action Switch branch here…",
      "action Move to a new worktree… (disabled)",
      "action Manage worktrees…",
    ]);
  });

  it("selects a started worktree thread's own worktree and offers removal and discarding a move", () => {
    const rows = outline(
      buildWorkspaceRows(
        input({
          isDraft: false,
          state: { kind: "worktree", path: "/wt/route", branch: "fix/route" },
          threadId: "c",
          hasCompletedMove: true,
        }),
      ),
    );
    expect(rows).toContain("open fix/route /wt/route (0) *");
    expect(rows.slice(-4)).toEqual([
      "action Switch branch here…",
      "action Manage worktrees…",
      "action Discard originals from move…",
      "action Remove worktree…",
    ]);
  });

  it("does not offer an in-place switch of a missing checkout", () => {
    const rows = outline(
      buildWorkspaceRows(
        input({
          isDraft: false,
          checkoutMissing: true,
          state: { kind: "worktree", path: "/wt/gone", branch: "gone" },
        }),
      ),
    );
    expect(rows).not.toContain("action Switch branch here…");
    expect(rows).toContain("action Remove worktree…");
  });

  it("only explains setup while the worktree is being created", () => {
    expect(
      outline(
        buildWorkspaceRows(
          input({
            isDraft: false,
            creatingWorktree: true,
            state: { kind: "newWorktree", base: "main" },
          }),
        ),
      ),
    ).toEqual([
      "! The worktree is being created. Manage it once setup finishes.",
      "# Manage",
      "action Manage worktrees…",
    ]);
  });

  it("filters by query, hides Manage, and offers a new branch worktree from the selected base", () => {
    expect(
      outline(
        buildWorkspaceRows(input({ query: "feat", state: { kind: "newWorktree", base: "main" } })),
      ),
    ).toEqual(["# New worktree from", "new feature/a", "new-branch feat from main"]);
    // No base selected yet: the default branch.
    expect(outline(buildWorkspaceRows(input({ query: "topic" })))).toEqual([
      "new-branch topic from main",
    ]);
  });

  it("offers no new branch for an exact match, a fan-out send or a started thread", () => {
    expect(outline(buildWorkspaceRows(input({ query: "main" })))).not.toContain(
      "new-branch main from main",
    );
    expect(
      outline(buildWorkspaceRows(input({ query: "topic", multiModel: true }))).some((row) =>
        row.startsWith("new-branch"),
      ),
    ).toBe(false);
    expect(
      outline(buildWorkspaceRows(input({ query: "topic", isDraft: false }))).some((row) =>
        row.startsWith("new-branch"),
      ),
    ).toBe(false);
  });

  it("puts Checkout Pull Request first for a PR reference, unless the checkout is missing", () => {
    expect(outline(buildWorkspaceRows(input({ query: "#42", prReference: "#42" })))[0]).toBe(
      "pr #42",
    );
    expect(
      outline(
        buildWorkspaceRows(input({ query: "#42", prReference: "#42", checkoutMissing: true })),
      ),
    ).not.toContain("pr #42");
    expect(
      outline(
        buildWorkspaceRows(
          input({ query: "#42", prReference: "#42", canCheckoutPullRequest: false }),
        ),
      ),
    ).not.toContain("pr #42");
  });

  describe("switch mode", () => {
    it("lists the branches this checkout can take and creating one", () => {
      expect(outline(buildWorkspaceRows(input({ mode: "switch", query: "" })))).toEqual([
        "back",
        "# Switch Local to",
        "switch fix/sidebar current (disabled)",
        "switch feature/a",
        "switch main",
        "switch origin/remote-only",
      ]);
      expect(outline(buildWorkspaceRows(input({ mode: "switch", query: "new topic" })))).toEqual([
        "back",
        "# Switch Local to",
        "create new-topic",
      ]);
    });

    it("does not offer creating a branch that matches a remote branch's local name", () => {
      expect(outline(buildWorkspaceRows(input({ mode: "switch", query: "remote-only" })))).toEqual([
        "back",
        "# Switch Local to",
        "switch origin/remote-only",
      ]);
    });

    it("disables every switch and names the blockers when the checkout is in use", () => {
      expect(
        outline(
          buildWorkspaceRows(
            input({
              mode: "switch",
              query: "zzz",
              switchBlockedReason:
                "In use by Review PR 719 (running turn). Start a new worktree instead.",
            }),
          ),
        ),
      ).toEqual([
        "back",
        "! In use by Review PR 719 (running turn). Start a new worktree instead.",
        "# Switch Local to",
        "create zzz (disabled)",
      ]);
    });

    it("switches a worktree to branches that are not checked out elsewhere", () => {
      expect(
        outline(
          buildWorkspaceRows(
            input({
              mode: "switch",
              state: { kind: "worktree", path: "/wt/route", branch: "fix/route" },
            }),
          ),
        ),
      ).toEqual([
        "back",
        "# Switch this worktree to",
        "switch feature/a",
        "switch main",
        "switch fix/route current (disabled)",
        "switch origin/remote-only",
      ]);
    });
  });
});

describe("workspaceTriggerLabel", () => {
  const base = {
    creatingWorktree: false,
    activeThreadBranch: null,
    projectBranch: "fix/sidebar",
    checkoutMissing: false,
  };
  it("says where the thread works", () => {
    expect(workspaceTriggerLabel({ ...base, state: { kind: "local" } })).toBe(
      "Local · fix/sidebar",
    );
    expect(workspaceTriggerLabel({ ...base, projectBranch: null, state: { kind: "local" } })).toBe(
      "Local",
    );
    expect(workspaceTriggerLabel({ ...base, state: { kind: "newWorktree", base: "main" } })).toBe(
      "New worktree · from main",
    );
    expect(
      workspaceTriggerLabel({
        ...base,
        state: { kind: "worktree", path: "/wt/route", branch: "fix/route" },
      }),
    ).toBe("fix/route");
    expect(
      workspaceTriggerLabel({
        ...base,
        checkoutMissing: true,
        state: { kind: "worktree", path: "/wt/route", branch: "fix/route" },
      }),
    ).toBe("fix/route · missing");
    expect(
      workspaceTriggerLabel({
        ...base,
        creatingWorktree: true,
        activeThreadBranch: "main",
        state: { kind: "newWorktree", base: "main" },
      }),
    ).toBe("New worktree · from main");
  });
});
