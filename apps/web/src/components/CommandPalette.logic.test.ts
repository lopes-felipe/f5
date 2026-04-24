import { describe, expect, it, vi } from "vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "../types";
import {
  buildThreadActionItems,
  filterCommandPaletteGroups,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Thread",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-03-01T00:00:00.000Z",
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: false,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    ...overrides,
  };
}

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("thread-older"),
            title: "Older thread",
            lastInteractionAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.makeUnsafe("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            lastInteractionAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:thread-older",
        "thread:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-context-match"),
          title: "Fix navbar spacing",
          lastInteractionAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          lastInteractionAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          lastInteractionAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          lastInteractionAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });
});
