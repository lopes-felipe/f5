import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Thread } from "../../types";
import { HomeThreadRow } from "./HomeThreadRow";

function makePlanReadyThread(): Thread {
  return {
    id: "thread-plan-ready" as never,
    codexThreadId: null,
    projectId: "project-1" as never,
    title: "Home Page UX Improvements",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "plan",
    session: {
      provider: "codex",
      status: "ready",
      activeTurnId: "turn-1" as never,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "ready",
    },
    messages: [],
    commandExecutions: [],
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
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-03-09T10:05:00.000Z",
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: {
      turnId: "turn-1" as never,
      state: "completed",
      assistantMessageId: null,
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: "2026-03-09T10:05:00.000Z",
    },
    branch: "main",
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
  };
}

describe("HomeThreadRow", () => {
  it("uses the warning accent for plan-ready urgency rows", () => {
    const markup = renderToStaticMarkup(
      <HomeThreadRow
        thread={makePlanReadyThread()}
        project={undefined}
        onSelect={() => {}}
        urgencyStatus="plan-ready"
      />,
    );

    expect(markup).toContain("before:bg-warning/80");
    expect(markup).not.toContain("before:bg-violet-500/80");
    expect(markup).toContain(">Plan Ready<");
  });
});
