import "../../index.css";

import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { Thread } from "../../types";
import { WorkflowPageLayout } from "./WorkflowPageLayout";
import type { WorkflowTimelinePhase } from "./workflowTimelineTypes";

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({
      to: _to,
      params: _params,
      children,
      ...rest
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: unknown; params?: unknown }) => (
      <a href="#" {...rest}>
        {children}
      </a>
    ),
  };
});

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: `Thread ${id}`,
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "ready",
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:10.000Z",
      orchestrationStatus: "ready",
    },
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    error: null,
    createdAt: "2026-04-24T12:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-04-24T12:00:10.000Z",
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    sessionNotes: null,
    threadReferences: [],
    ...overrides,
  };
}

describe("Workflow telemetry UI", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders summary telemetry bar and per-step duration, tokens, and bottleneck badge", async () => {
    const fastThread = makeThread("thread-fast", {
      estimatedContextTokens: 8_500,
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-fast"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:08.000Z",
        assistantMessageId: null,
      },
    });
    const slowThread = makeThread("thread-slow", {
      estimatedContextTokens: 24_000,
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-slow"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:45.000Z",
        assistantMessageId: null,
      },
    });

    const phases: WorkflowTimelinePhase[] = [
      {
        id: "drafting",
        label: "Drafting",
        state: "completed",
        steps: [
          {
            key: "branch-a",
            label: "Branch A",
            threadId: fastThread.id,
            state: "completed",
            modelSlot: null,
          },
          {
            key: "branch-b",
            label: "Branch B",
            threadId: slowThread.id,
            state: "completed",
            modelSlot: null,
          },
        ],
      },
    ];

    const screen = await render(
      <WorkflowPageLayout
        projectId={ProjectId.makeUnsafe("project-1")}
        workflowType="planning"
        typeLabel="Feature"
        title="Telemetry demo"
        statusLabel="Completed"
        overallState="completed"
        totalCostUsd={0.42}
        createdAt="2026-04-24T12:00:00.000Z"
        updatedAt="2026-04-24T12:00:45.000Z"
        phases={phases}
        threadById={
          new Map([
            [fastThread.id, fastThread],
            [slowThread.id, slowThread],
          ])
        }
        view="board"
      >
        <div>Body</div>
      </WorkflowPageLayout>,
    );

    try {
      await expect.element(page.getByText("2/2 steps")).toBeInTheDocument();
      await expect.element(page.getByText("Elapsed 45s")).toBeInTheDocument();
      await expect.element(page.getByText("~32.5k tok context")).toBeInTheDocument();
      await expect.element(page.getByText("24.0k tok")).toBeInTheDocument();
      expect(document.querySelector('[data-slot="workflow-step-bottleneck"]')?.textContent).toBe(
        "Slowest",
      );
      expect(
        document.querySelector('[data-slot="workflow-telemetry-bottleneck"]')?.textContent,
      ).toContain("Branch B");
    } finally {
      await screen.unmount();
    }
  });
});
