import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Project, Thread } from "../types";
import { buildSidebarThreadSearchItems } from "./Sidebar.search.logic";

const PROJECT_A_ID = ProjectId.makeUnsafe("project-a");
const PROJECT_B_ID = ProjectId.makeUnsafe("project-b");

function makeProject(id: ProjectId, name: string): Project {
  return {
    id,
    name,
    cwd: `/repo/${id}`,
    model: "gpt-5",
    createdAt: "2026-03-01T00:00:00.000Z",
    expanded: true,
    scripts: [],
    memories: [],
  };
}

function makeThread(id: string, projectId: ProjectId, title: string): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId,
    title,
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

describe("buildSidebarThreadSearchItems", () => {
  const projects = [makeProject(PROJECT_A_ID, "Web"), makeProject(PROJECT_B_ID, "Server")];
  const threads = [
    makeThread("thread-a", PROJECT_A_ID, "Reconnect the websocket"),
    makeThread("thread-b", PROJECT_B_ID, "Retry provider startup"),
  ];

  it("matches thread titles immediately through the command-palette ranking path", () => {
    expect(
      buildSidebarThreadSearchItems({
        query: "retry",
        projects,
        threads,
        icon: null,
        runThread: async () => undefined,
      }).map((item) => item.value),
    ).toEqual(["thread:thread-b"]);
  });

  it("applies project tokens without treating them as title text", () => {
    expect(
      buildSidebarThreadSearchItems({
        query: "project:web",
        projects,
        threads,
        icon: null,
        runThread: async () => undefined,
      }).map((item) => item.value),
    ).toEqual(["thread:thread-a"]);
  });

  it("returns no local results for an unknown project token", () => {
    expect(
      buildSidebarThreadSearchItems({
        query: "retry project:missing",
        projects,
        threads,
        icon: null,
        runThread: async () => undefined,
      }),
    ).toEqual([]);
  });
});
