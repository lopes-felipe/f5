import { describe, expect, it } from "vitest";

import { describeMissingWorktree, heldQueueItem } from "./WorkspaceStatusCard.logic";

describe("heldQueueItem", () => {
  it("is the first message that has not failed, as the server decides it", () => {
    const items = [
      { itemId: "failed-earlier", status: "failed" },
      { itemId: "waiting", status: "queued" },
      { itemId: "later", status: "queued" },
    ];
    expect(heldQueueItem(items)?.itemId).toBe("waiting");
    expect(heldQueueItem([{ itemId: "only-failed", status: "failed" }])).toBeUndefined();
    expect(heldQueueItem([])).toBeUndefined();
  });
});

describe("describeMissingWorktree", () => {
  const dormant = { kind: "dormant", path: "/worktrees/topic", branch: "topic" } as const;

  it("promises a restore only when the server says the next message brings one", () => {
    expect(describeMissingWorktree(dormant, false).label).toBe("Worktree restores on send");
  });

  it.each([
    {
      kind: "attention",
      reason: "branch_in_use",
      message: "topic is checked out in the project folder.",
      actions: ["attach", "newWorktree"],
    },
    {
      kind: "attention",
      reason: "restore_failed",
      message: "The worktree could not be restored.",
      actions: ["retry", "useProjectFolder"],
    },
  ] as const)("only names the fact while the user has to decide: $reason", (status) => {
    const described = describeMissingWorktree(status, false);
    expect(described.label).toBe("Worktree not on disk");
    expect(described.title).toContain("Choose how to continue");
  });

  it("does not promise before the status is known, and says when a restore is running", () => {
    expect(describeMissingWorktree(undefined, false).label).toBe("Worktree not on disk");
    expect(
      describeMissingWorktree({ kind: "working", activity: "restoring", cancellable: false }, false)
        .label,
    ).toBe("Restoring worktree…");
  });

  it("says an archived thread's worktree was removed, whatever the status", () => {
    expect(describeMissingWorktree(dormant, true).label).toBe("Worktree removed");
  });
});
