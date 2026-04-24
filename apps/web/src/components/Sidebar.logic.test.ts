import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildRenderedProjectThreadIds,
  getVisibleSidebarThreadIds,
  reconcileFrozenOrder,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveWorkflowThreadListExpanded,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  toggleWorkflowThreadListExpansion,
  threadBucketExpansionKey,
} from "./Sidebar.logic";

function makeLatestTurn() {
  return {
    turnId: "turn-1" as never,
    state: "completed" as const,
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
  };
}

function itemIds(ids: readonly string[]) {
  return ids.map((id) => ({ id }));
}

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("workflow thread list helpers", () => {
  it("collapses workflow threads by default when the setting is off", () => {
    expect(
      resolveWorkflowThreadListExpanded({
        expandByDefault: false,
        activeThreadId: null,
        workflowThreadIds: [ThreadId.makeUnsafe("thread-a")],
      }),
    ).toBe(false);
  });

  it("reveals the active workflow thread when there is no explicit override", () => {
    expect(
      resolveWorkflowThreadListExpanded({
        expandByDefault: false,
        activeThreadId: ThreadId.makeUnsafe("thread-a"),
        workflowThreadIds: [ThreadId.makeUnsafe("thread-a")],
      }),
    ).toBe(true);
  });

  it("prefers the explicit override over the default and active-thread fallback", () => {
    expect(
      resolveWorkflowThreadListExpanded({
        overrideExpanded: false,
        expandByDefault: true,
        activeThreadId: ThreadId.makeUnsafe("thread-a"),
        workflowThreadIds: [ThreadId.makeUnsafe("thread-a")],
      }),
    ).toBe(false);
  });

  it("drops redundant overrides when toggling back to the default state", () => {
    expect(
      toggleWorkflowThreadListExpansion({
        workflowId: "workflow-1",
        workflowExpandedById: {
          "workflow-1": true,
        },
        fallbackExpanded: false,
      }),
    ).toEqual({});
  });

  it("stores a workflow-specific override when toggling away from the default state", () => {
    expect(
      toggleWorkflowThreadListExpansion({
        workflowId: "workflow-1",
        workflowExpandedById: {},
        fallbackExpanded: false,
      }),
    ).toEqual({
      "workflow-1": true,
    });
  });
});

describe("sidebar thread bucket helpers", () => {
  it("builds stable expansion keys per project bucket", () => {
    expect(threadBucketExpansionKey(ProjectId.makeUnsafe("project-1"), "active")).toBe(
      "project-1:active",
    );
    expect(threadBucketExpansionKey(ProjectId.makeUnsafe("project-1"), "archived")).toBe(
      "project-1:archived",
    );
  });

  it("applies the preview limit independently per bucket", () => {
    const activeThreadIds = [
      ThreadId.makeUnsafe("thread-a"),
      ThreadId.makeUnsafe("thread-b"),
      ThreadId.makeUnsafe("thread-c"),
    ] as const;
    const archivedThreadIds = [
      ThreadId.makeUnsafe("thread-d"),
      ThreadId.makeUnsafe("thread-e"),
      ThreadId.makeUnsafe("thread-f"),
    ] as const;

    expect(
      getVisibleSidebarThreadIds(activeThreadIds, false, 2).map((threadId) => threadId),
    ).toEqual([ThreadId.makeUnsafe("thread-a"), ThreadId.makeUnsafe("thread-b")]);

    expect(
      buildRenderedProjectThreadIds({
        activeThreadIds,
        archivedThreadIds,
        activeExpanded: false,
        archivedExpanded: true,
        previewLimit: 2,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-a"),
      ThreadId.makeUnsafe("thread-b"),
      ThreadId.makeUnsafe("thread-d"),
      ThreadId.makeUnsafe("thread-e"),
      ThreadId.makeUnsafe("thread-f"),
    ]);
  });
});

describe("reconcileFrozenOrder", () => {
  it("preserves the frozen order for existing items", () => {
    expect(
      reconcileFrozenOrder({
        items: itemIds(["thread-a", "thread-b", "thread-c"]),
        getKey: (item) => item.id,
        frozenOrder: ["thread-b", "thread-a", "thread-c"],
      }).map((item) => item.id),
    ).toEqual(["thread-b", "thread-a", "thread-c"]);
  });

  it("drops items that disappeared since the frozen snapshot", () => {
    expect(
      reconcileFrozenOrder({
        items: itemIds(["thread-b", "thread-c"]),
        getKey: (item) => item.id,
        frozenOrder: ["thread-a", "thread-b", "thread-c"],
      }).map((item) => item.id),
    ).toEqual(["thread-b", "thread-c"]);
  });

  it("prepends an unseen pinned draft and appends other unseen live items", () => {
    expect(
      reconcileFrozenOrder({
        items: itemIds(["draft-1", "thread-b", "thread-a", "thread-c"]),
        getKey: (item) => item.id,
        frozenOrder: ["thread-b", "thread-a"],
        prependUnseenKeys: ["draft-1"],
      }).map((item) => item.id),
    ).toEqual(["draft-1", "thread-b", "thread-a", "thread-c"]);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    proposedPlans: [],
    tasks: [],
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
              implementedAt: null,
              implementationThreadId: null,
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not show plan ready after the proposed plan was implemented elsewhere", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
              implementedAt: "2026-03-09T10:06:00.000Z",
              implementationThreadId: "thread-implement" as never,
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the darker selected palette when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-primary/22");
    expect(className).toContain("hover:bg-primary/26");
    expect(className).toContain("dark:bg-primary/30");
    expect(className).not.toContain("bg-accent/85");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-primary/15");
    expect(className).toContain("hover:bg-primary/19");
    expect(className).toContain("dark:bg-primary/22");
    expect(className).not.toContain("hover:bg-accent");
  });

  it("keeps the accent palette for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-accent/85");
    expect(className).toContain("hover:bg-accent");
  });
});
