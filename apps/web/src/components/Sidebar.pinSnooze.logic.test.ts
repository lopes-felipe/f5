import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../types";
import { orderActiveSidebarThreads, projectSnoozedThreads } from "./Sidebar.pinSnooze.logic";

function thread(input: {
  id: string;
  projectId?: string;
  pinOrderKey?: number | null;
  snoozedUntil?: string | null;
}): Thread {
  const now = "2026-08-15T10:00:00.000Z";
  return {
    id: ThreadId.makeUnsafe(input.id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe(input.projectId ?? "project-1"),
    title: input.id,
    model: "gpt-5-codex",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: now,
    archivedAt: null,
    pinnedAt: input.pinOrderKey == null ? null : now,
    pinOrderKey: input.pinOrderKey ?? null,
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedUntil == null ? null : now,
    lastInteractionAt: now,
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
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
  };
}

describe("sidebar pin and snooze presentation", () => {
  it("keeps a draft first, then orders server pins before active threads", () => {
    const result = orderActiveSidebarThreads({
      threads: [
        thread({ id: "recent" }),
        thread({ id: "pin-second", pinOrderKey: 1 }),
        thread({ id: "draft" }),
        thread({ id: "pin-first", pinOrderKey: 0 }),
      ],
      draftThreadId: ThreadId.makeUnsafe("draft"),
    });
    expect(result.map((entry) => entry.id)).toEqual(["draft", "pin-first", "pin-second", "recent"]);
  });

  it("moves future snoozes into their project section", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = projectSnoozedThreads(
      [
        thread({ id: "snoozed", snoozedUntil: future }),
        thread({ id: "active" }),
        thread({ id: "other", projectId: "project-2", snoozedUntil: future }),
      ],
      ProjectId.makeUnsafe("project-1"),
    );
    expect(result.map((entry) => entry.id)).toEqual(["snoozed"]);
  });
});
