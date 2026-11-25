import "../../index.css";

import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { isNowTickerRunning, setNowTickerClockForTests } from "../../lib/nowTicker";
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
    setNowTickerClockForTests(null);
    document.body.innerHTML = "";
  });

  it("renders summary telemetry bar and per-step duration, tokens, and bottleneck badge without duplicating cost or elapsed", async () => {
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
        parallel: true,
        steps: [
          {
            key: "branch-a",
            label: "Branch A",
            threadId: fastThread.id,
            turnId: "turn-fast",
            state: "completed",
            modelSlot: null,
          },
          {
            key: "branch-b",
            label: "Branch B",
            threadId: slowThread.id,
            turnId: "turn-slow",
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
        updatedAt="2026-04-24T12:05:00.000Z"
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
      await expect
        .element(page.getByText("~32.5K context in use across 2 threads"))
        .toBeInTheDocument();
      await expect.element(page.getByText("24K")).toBeInTheDocument();
      expect(document.querySelector('[data-slot="workflow-step-bottleneck"]')?.textContent).toBe(
        "Slowest",
      );
      expect(
        document.querySelector('[data-slot="workflow-telemetry-bottleneck"]')?.textContent,
      ).toContain("Branch B");
      // Cost appears once in the header meta, not duplicated inside the telemetry bar.
      expect(document.querySelector('[data-slot="workflow-meta"]')?.textContent).toContain("$0.42");
      expect(
        document.querySelector('[data-slot="workflow-telemetry-bar"]')?.textContent,
      ).not.toContain("$0.42");
      // Ticker stays stopped for a settled run.
      expect(isNowTickerRunning()).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("advances live timers when a branch is active even alongside a failed sibling, and stops the ticker once settled", async () => {
    let clockMs = Date.parse("2026-04-24T12:00:15.000Z");
    setNowTickerClockForTests(() => clockMs);

    const failedThread = makeThread("thread-err", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-err"),
        state: "error",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:06.000Z",
        assistantMessageId: null,
      },
    });
    const activeThread = makeThread("thread-live", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-live"),
        state: "running",
        requestedAt: "2026-04-24T12:00:05.000Z",
        startedAt: "2026-04-24T12:00:05.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });

    const activePhases: WorkflowTimelinePhase[] = [
      {
        id: "authoring",
        label: "Authoring",
        state: "error",
        parallel: true,
        steps: [
          {
            key: "branch-a",
            label: "Branch A",
            threadId: failedThread.id,
            turnId: "turn-err",
            state: "error",
            modelSlot: null,
          },
          {
            key: "branch-b",
            label: "Branch B",
            threadId: activeThread.id,
            turnId: "turn-live",
            state: "active",
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
        title="Live partial error"
        statusLabel="Error"
        overallState="error"
        createdAt="2026-04-24T12:00:00.000Z"
        updatedAt="2026-04-24T12:00:06.000Z"
        phases={activePhases}
        threadById={
          new Map([
            [failedThread.id, failedThread],
            [activeThread.id, activeThread],
          ])
        }
        view="board"
      >
        <div>Body</div>
      </WorkflowPageLayout>,
    );

    try {
      expect(isNowTickerRunning()).toBe(true);
      await expect.element(page.getByText("Elapsed 15s")).toBeInTheDocument();
      await expect.element(page.getByText("10s")).toBeInTheDocument();

      clockMs = Date.parse("2026-04-24T12:00:25.000Z");
      setNowTickerClockForTests(() => clockMs);

      await expect.element(page.getByText("Elapsed 25s")).toBeInTheDocument();
      await expect.element(page.getByText("20s")).toBeInTheDocument();

      // Settle the active branch and verify the ticker stops.
      const settledThread = makeThread("thread-live", {
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-live"),
          state: "completed",
          requestedAt: "2026-04-24T12:00:05.000Z",
          startedAt: "2026-04-24T12:00:05.000Z",
          completedAt: "2026-04-24T12:00:25.000Z",
          assistantMessageId: null,
        },
      });
      await screen.rerender(
        <WorkflowPageLayout
          projectId={ProjectId.makeUnsafe("project-1")}
          workflowType="planning"
          typeLabel="Feature"
          title="Live partial error"
          statusLabel="Error"
          overallState="error"
          createdAt="2026-04-24T12:00:00.000Z"
          updatedAt="2026-04-24T12:00:25.000Z"
          phases={[
            {
              ...activePhases[0]!,
              steps: [
                activePhases[0]!.steps[0]!,
                { ...activePhases[0]!.steps[1]!, state: "completed" },
              ],
            },
          ]}
          threadById={
            new Map([
              [failedThread.id, failedThread],
              [settledThread.id, settledThread],
            ])
          }
          view="board"
        >
          <div>Body</div>
        </WorkflowPageLayout>,
      );

      expect(isNowTickerRunning()).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("renders the telemetry bar in list view while keeping list rows compact", async () => {
    const doneThread = makeThread("thread-list", {
      estimatedContextTokens: 15_000,
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-list"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:12.000Z",
        assistantMessageId: null,
      },
    });
    const screen = await render(
      <WorkflowPageLayout
        projectId={ProjectId.makeUnsafe("project-1")}
        workflowType="planning"
        typeLabel="Feature"
        title="List view demo"
        statusLabel="Completed"
        overallState="completed"
        createdAt="2026-04-24T12:00:00.000Z"
        updatedAt="2026-04-24T12:00:12.000Z"
        phases={[
          {
            id: "merge",
            label: "Merge",
            state: "completed",
            steps: [
              {
                key: "merge",
                label: "Merge",
                threadId: doneThread.id,
                turnId: "turn-list",
                state: "completed",
                modelSlot: null,
              },
            ],
          },
        ]}
        threadById={new Map([[doneThread.id, doneThread]])}
        view="list"
      >
        <div>Body</div>
      </WorkflowPageLayout>,
    );

    try {
      await expect.element(page.getByText("1/1 steps")).toBeInTheDocument();
      await expect.element(page.getByText("Elapsed 12s")).toBeInTheDocument();
      expect(document.querySelector('[data-slot="workflow-step-telemetry"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
