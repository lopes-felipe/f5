import { summarizePlanningWorkflow } from "@t3tools/shared/workflowSummary";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Thread } from "../../types";
import "../../index.css";

import { PlanningWorkflowId, ThreadId, TurnId } from "@t3tools/contracts";
import type { WorkflowBenchmarkChanged, WorkflowBenchmarkInput } from "@t3tools/contracts";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { TooltipProvider } from "../ui/tooltip";
const renderView = (view: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider delay={0}>{view}</TooltipProvider>
    </QueryClientProvider>,
  );

import { useStore } from "../../store";
import {
  noteWsConnectionClosed,
  noteWsConnectionOpened,
  noteWsSynchronized,
  resetWsConnectionStateForTests,
} from "../../wsConnectionState";
import { toastManager } from "../ui/toast";
import { createPlanningWorkflow, createDocumentReaderPass } from "../../test/workflowFixtures";

const nativeApiMocks = vi.hoisted(() => ({
  inspectRun: vi.fn(),
  getBenchmark: vi.fn(),
  onBenchmarkChanged: vi.fn(),
  retryWorkflow: vi.fn(),
  skipDocumentReaderPass: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => {
    return {
      workflowPlatform: {
        inspectRun: nativeApiMocks.inspectRun,
        getBenchmark: nativeApiMocks.getBenchmark,
      },
    };
  },
  readNativeApi: () => ({
    workflowPlatform: { onBenchmarkChanged: nativeApiMocks.onBenchmarkChanged },
    orchestration: {
      retryWorkflow: nativeApiMocks.retryWorkflow,
      skipDocumentReaderPass: nativeApiMocks.skipDocumentReaderPass,
    },
  }),
}));

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    // Step cards link to their threads; no router is mounted here.
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

const threadPreloadMocks = vi.hoisted(() => ({ warmThreadBundle: vi.fn() }));

vi.mock("../../lib/threadPreload", async () => ({
  ...(await vi.importActual<typeof import("../../lib/threadPreload")>("../../lib/threadPreload")),
  warmThreadBundle: threadPreloadMocks.warmThreadBundle,
}));

vi.mock("./WorkflowRunInspector", () => ({ WorkflowRunInspector: () => null }));
vi.mock("./WorkflowImplementDialog", () => ({ WorkflowImplementDialog: () => null }));

import { WorkflowView } from "./WorkflowView";

const workflowId = PlanningWorkflowId.makeUnsafe("retry-workflow");

describe("WorkflowView retry", () => {
  beforeEach(() => {
    nativeApiMocks.inspectRun.mockReset();
    nativeApiMocks.retryWorkflow.mockReset();
    nativeApiMocks.skipDocumentReaderPass.mockReset();
    nativeApiMocks.onBenchmarkChanged.mockReset();
    nativeApiMocks.getBenchmark.mockReset();
    nativeApiMocks.getBenchmark.mockResolvedValue({
      kind: "summary",
      models: [{ id: "gpt", label: "GPT-6.2 Sol" }],
      total: {
        tokens: 200,
        costUsd: 0.01,
        estimated: false,
        missingTokens: 0,
        missingCost: 0,
        pending: 0,
      },
      phases: [],
      modelTotals: [],
      findings: 2,
      historicalPartial: false,
      ambiguous: 0,
      evaluationsIncomplete: 0,
      coverage: [],
    });
    useStore.setState({
      threads: [],
      planningWorkflows: [
        createPlanningWorkflow({
          id: workflowId,
          branchA: {
            status: "error",
            error: "Authoring failed",
            errorStage: "authoring",
          },
        }),
      ],
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    useStore.setState({ threads: [], planningWorkflows: [] });
  });

  it("loads the collapsed benchmark and opens it from zero budget spend", async () => {
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);
    const trigger = screen.getByRole("button", { name: /Workflow benchmark.*200 tokens/ });
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    expect(nativeApiMocks.getBenchmark).toHaveBeenCalledExactlyOnceWith({
      runKind: "planning",
      workflowId,
      select: { kind: "summary" },
    });
    await screen
      .getByRole("button", { name: "Budget spend $0.00, open workflow benchmark" })
      .click();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    await expect.element(trigger).toHaveFocus();
    await expect.element(screen.getByRole("columnheader", { name: "GPT-6.2 Sol" })).toBeVisible();
  });

  it("queries a review phase on demand and combines its finding filters", async () => {
    const usage = {
      tokens: 200,
      costUsd: 0.01,
      estimated: false,
      estimatedCodexCredits: 0.47,
      missingTokens: 0,
      missingCost: 0,
      pending: 0,
    };
    const model = { id: "gpt", label: "GPT-6.2 Sol" };
    const reviewerA = { id: "cross-review-a", label: "Review A Cross" };
    const reviewerB = { id: "self-review-b", label: "Review B Self" };
    const push: { listener?: ((change: WorkflowBenchmarkChanged) => void) | undefined } = {};
    nativeApiMocks.onBenchmarkChanged.mockImplementation((callback: typeof push.listener) => {
      push.listener = callback;
      return () => {
        push.listener = undefined;
      };
    });
    let turnStatus = "pending";
    let modelSource = "configured";
    let turnModel = { id: "selected", label: "Selected model" };
    let turnUsage = {
      ...usage,
      tokens: null as number | null,
      costUsd: null as number | null,
      pending: 1,
    };
    nativeApiMocks.getBenchmark.mockImplementation(async ({ select }: WorkflowBenchmarkInput) => {
      if (select.kind === "turns")
        return {
          kind: "turns",
          count: 1,
          items: [
            {
              id: "delivery",
              threadId: ThreadId.make("review"),
              threadTitle: "Review thread",
              turnId: TurnId.make("turn"),
              model: turnModel,
              modelSource,
              role: "Reviewer A",
              attempt: 2,
              durationMs: null,
              status: turnStatus,
              target: null,
              aggregateRerouteUsage: modelSource === "effective",
              reviewer: reviewerA,
              tokenScope: "main-agent",
              costScope: "provider-total",
              subagents: [
                {
                  id: "explorer",
                  label: "Explorer",
                  model,
                  status: "completed",
                  tokens: 123,
                  costUsd: null,
                },
              ],
              usage: turnUsage,
            },
          ],
        };
      if (select.kind === "findings")
        return {
          kind: "findings",
          count: 1,
          counts: {
            confirmed: 1,
            checking: 0,
            dismissed: 0,
            shared: 0,
            exclusive: [{ reviewer: reviewerA, count: 1 }],
          },
          items: [
            {
              id: "a",
              aliases: [],
              severity: "high",
              title: "Unexpected data at boundary",
              description: "The last page contains an extra row",
              location: "file.ts:18",
              evidence: ["Last page"],
              status: "confirmed",
              resolution: null,
              test: null,
              reporters: [
                {
                  model,
                  reviewer: reviewerA,
                  discoveredBy: { id: "explorer", label: "Explorer", evidence: "Child evidence" },
                  origin: {
                    threadId: ThreadId.make("review"),
                    turnId: TurnId.make("turn"),
                    messageId: "message",
                    planId: null,
                  },
                },
              ],
            },
          ],
        };
      return {
        kind: "summary",
        models: [model],
        phases: [
          {
            id: "reviews",
            label: "Reviews",
            cells: [{ model: model.id, usage }],
            total: usage,
            findings: 1,
            review: true,
            reviewers: [reviewerA, reviewerB],
            findingTurns: [
              { threadId: ThreadId.make("review"), turnId: TurnId.make("turn"), count: 1 },
            ],
          },
        ],
        total: usage,
        modelTotals: [{ model: model.id, usage }],
        findings: 1,
        historicalPartial: false,
        ambiguous: 0,
        coverage: [],
        evaluationsIncomplete: 0,
      };
    });
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);
    await screen
      .getByRole("button", { name: "Budget spend $0.00, open workflow benchmark" })
      .click();
    const reviews = screen.getByRole("button", { name: "Reviews", exact: true });
    await expect.element(reviews).toBeVisible();
    await expect.element(page.getByText(/Codex Standard credits/)).not.toBeInTheDocument();
    await screen.getByRole("button", { name: model.label, exact: true }).hover();
    await expect
      .element(page.getByText("≈0.47 Codex Standard credits", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("≈0.47", { exact: true })).toBeVisible();
    const phaseRow = reviews.element().closest("tr")!;
    const closedPhaseBackground = getComputedStyle(phaseRow).backgroundColor;
    const reviewFindings = screen.getByRole("button", { name: "1 finding in Reviews" });
    const turnTable = screen.getByRole("table", { name: "Reviews turns" });
    await expect.element(turnTable).not.toBeInTheDocument();
    await reviewFindings.click();
    await expect.element(turnTable).toBeVisible();
    await expect
      .element(turnTable.getByRole("columnheader", { name: "Role", exact: true }))
      .toBeVisible();
    expect(getComputedStyle(phaseRow).backgroundColor).not.toBe(closedPhaseBackground);
    await expect
      .element(screen.getByText("1 confirmed · 0 in verification · 0 dismissed"))
      .toBeVisible();
    await screen.getByRole("searchbox", { name: "Search findings" }).fill("Last page");
    await screen.getByRole("combobox", { name: "Filter by severity" }).selectOptions("high");
    await screen.getByRole("combobox", { name: "Filter by model" }).selectOptions("gpt");
    await screen.getByRole("combobox", { name: "Filter by status" }).selectOptions("confirmed");
    await expect
      .poll(() => nativeApiMocks.getBenchmark.mock.calls)
      .toContainEqual([
        {
          runKind: "planning",
          workflowId,
          select: {
            kind: "findings",
            phase: "reviews",
            search: "Last page",
            severity: "high",
            model: "gpt",
            status: "confirmed",
            offset: 0,
          },
        },
      ]);
    await screen.getByRole("button", { name: "Unexpected data at boundary" }).click();
    await expect.element(screen.getByRole("link", { name: "Review A Cross source" })).toBeVisible();
    await expect.element(screen.getByText("Child evidence", { exact: true })).toBeVisible();
    await reviews.click();
    await expect.element(turnTable).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("region", { name: "Reviews findings" }))
      .not.toBeInTheDocument();
    await reviews.click();
    await expect.element(turnTable).toBeVisible();
    for (const cell of turnTable.element().querySelectorAll("th, td")) {
      expect(getComputedStyle(cell).textAlign).toBe("center");
    }
    const turnRow = screen.getByRole("row", { name: /^Review thread/ });
    await expect.element(turnRow).toHaveTextContent("pending");
    await screen.getByText("1 subagent", { exact: true }).click();
    await expect.element(turnRow).toHaveTextContent("123 tokens");
    await expect.element(turnRow).toHaveTextContent("Provider total (may include subagents)");
    await screen.getByRole("button", { name: "1 finding from Review A Cross, attempt 2" }).click();
    await expect
      .element(screen.getByRole("heading", { name: "Review A Cross findings · attempt 2" }))
      .toBeVisible();
    await expect
      .poll(() => nativeApiMocks.getBenchmark.mock.calls)
      .toContainEqual([
        {
          runKind: "planning",
          workflowId,
          select: {
            kind: "findings",
            phase: "reviews",
            search: "",
            reviewer: reviewerA.id,
            reviewTurn: { threadId: "review", turnId: "turn" },
          },
        },
      ]);
    await screen.getByRole("combobox", { name: "Filter by reviewer" }).selectOptions(reviewerB.id);
    await expect
      .poll(() => nativeApiMocks.getBenchmark.mock.calls)
      .toContainEqual([
        {
          runKind: "planning",
          workflowId,
          select: {
            kind: "findings",
            phase: "reviews",
            search: "",
            reviewer: reviewerB.id,
            offset: 0,
          },
        },
      ]);
    turnStatus = "running";
    modelSource = "effective";
    turnModel = { id: "effective", label: "Rerouted model" };
    push.listener?.({ runKind: "planning", workflowId });
    await expect.element(turnRow).toHaveTextContent("running");
    await expect.element(turnRow).toHaveTextContent("Rerouted model");
    turnStatus = "Reverted";
    turnUsage = { ...usage, tokens: 398 };
    push.listener?.({ runKind: "planning", workflowId });
    await expect.element(turnRow).toHaveTextContent("Reverted");
    await expect.element(turnRow).toHaveTextContent("398 tokens");
  });

  it("opens a startup summary with lazy full details and actionable retry", async () => {
    const workflow = createPlanningWorkflow({
      id: workflowId,
      requirementPrompt: "Full prompt loaded on demand",
    });
    useStore.setState({ planningWorkflows: [summarizePlanningWorkflow(workflow)] });
    nativeApiMocks.inspectRun.mockRejectedValueOnce(new Error("offline"));
    nativeApiMocks.inspectRun.mockResolvedValue({
      workflowDetails: { runKind: "planning", workflow },
    });
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);
    try {
      await expect
        .element(screen.getByRole("button", { name: "Try again", exact: true }))
        .toBeVisible();
      await screen.getByRole("button", { name: "Try again", exact: true }).click();
      await expect
        .element(screen.getByText("Full prompt loaded on demand", { exact: true }))
        .toBeVisible();
      expect(nativeApiMocks.inspectRun).toHaveBeenLastCalledWith({
        runKind: "planning",
        workflowId,
        includeWorkflow: true,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows the canonical draft during reading and the approved document after polish", async () => {
    const mergeId = ThreadId.makeUnsafe("merge-document");
    const workflow = createPlanningWorkflow({
      id: workflowId,
      templateId: "builtin.document.dual",
      documentType: "rfc",
      readerReviewEnabled: true,
      readerSlot: { provider: "codex", model: "gpt-5" },
      readerPass: createDocumentReaderPass(),
      merge: { threadId: mergeId, status: "merged" },
    });
    const thread: Thread = {
      id: mergeId,
      codexThreadId: null,
      projectId: workflow.projectId,
      title: "Merge",
      model: "gpt-5",
      runtimeMode: "full-access",
      interactionMode: "plan",
      session: null,
      messages: [],
      commandExecutions: [],
      error: null,
      createdAt: workflow.createdAt,
      archivedAt: null,
      lastInteractionAt: workflow.updatedAt,
      estimatedContextTokens: null,
      estimatedThinkingTokens: null,
      modelContextWindowTokens: null,
      latestTurn: null,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
      detailsLoaded: true,
      tasks: [],
      tasksTurnId: null,
      tasksUpdatedAt: null,
      proposedPlans: [
        {
          id: "draft-plan",
          turnId: TurnId.makeUnsafe("merge-turn"),
          planMarkdown: "Here is the draft.\n# Retry proposal\n## Summary\nDraft body",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
        },
        {
          id: "final-plan",
          turnId: TurnId.makeUnsafe("polish-turn"),
          planMarkdown: "# Retry proposal\n## Summary\nPolished body",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
        },
      ],
    };
    useStore.setState({ threads: [thread], planningWorkflows: [workflow] });
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);
    try {
      await expect
        .element(page.getByRole("heading", { name: "Merged draft", exact: true }))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Reader review in progress", { exact: true }))
        .toBeInTheDocument();
      expect(document.body.textContent).toContain("Draft body");
      expect(document.body.textContent).not.toContain("Here is the draft");
      await page.getByRole("button", { name: "Document actions", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Download as markdown" }))
        .toBeInTheDocument();
      useStore.setState({
        planningWorkflows: [
          {
            ...workflow,
            readerPass: createDocumentReaderPass({
              status: "completed",
              pinnedTurnId: "reader-turn",
            }),
            merge: { ...workflow.merge, status: "manual_review", approvedPlanId: "final-plan" },
          },
        ],
      });
      await expect
        .element(page.getByRole("heading", { name: "Final document", exact: true }))
        .toBeInTheDocument();
      expect(document.body.textContent).toContain("Polished body");
      await expect
        .element(page.getByRole("button", { name: "View reader report", exact: true }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  describe("archived merge thread whose plans the startup snapshot omitted", () => {
    const archivedMergeThread = (
      id: ThreadId,
      workflow: ReturnType<typeof createPlanningWorkflow>,
    ) =>
      ({
        id,
        codexThreadId: null,
        projectId: workflow.projectId,
        title: "Merge",
        model: "gpt-5",
        runtimeMode: "full-access",
        interactionMode: "plan",
        session: null,
        messages: [],
        commandExecutions: [],
        error: null,
        createdAt: workflow.createdAt,
        archivedAt: workflow.updatedAt,
        lastInteractionAt: workflow.updatedAt,
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
        proposedPlans: [],
        proposedPlansOmitted: true,
      }) satisfies Thread;
    const mergedPlan = (workflow: ReturnType<typeof createPlanningWorkflow>) => ({
      id: "final-plan",
      turnId: TurnId.makeUnsafe("merge-turn"),
      planMarkdown: "# Archived proposal\n## Summary\nRecovered body",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    });

    beforeEach(() => {
      resetWsConnectionStateForTests();
      noteWsConnectionOpened();
      noteWsSynchronized();
    });
    afterEach(() => {
      threadPreloadMocks.warmThreadBundle.mockReset();
      resetWsConnectionStateForTests();
    });

    it("shows loading while the plans hydrate, then the merged plan", async () => {
      const mergeId = ThreadId.makeUnsafe("archived-merge-loaded");
      const workflow = createPlanningWorkflow({
        id: workflowId,
        merge: { threadId: mergeId, status: "manual_review", approvedPlanId: "final-plan" },
      });
      const thread = archivedMergeThread(mergeId, workflow);
      let finishLoad!: () => void;
      threadPreloadMocks.warmThreadBundle.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishLoad = () => {
              const { proposedPlansOmitted: _omitted, ...loaded } = thread;
              useStore.setState({
                threads: [{ ...loaded, proposedPlans: [mergedPlan(workflow)] }],
              });
              resolve();
            };
          }),
      );
      useStore.setState({ threads: [thread], planningWorkflows: [workflow] });
      const screen = await renderView(<WorkflowView workflowId={workflowId} />);
      try {
        await expect
          .element(page.getByText("Loading the merged plan…", { exact: true }))
          .toBeInTheDocument();
        expect(threadPreloadMocks.warmThreadBundle).toHaveBeenCalledWith(
          expect.anything(),
          mergeId,
          { forceThreadDetails: true },
        );
        finishLoad();
        await expect
          .element(page.getByRole("heading", { name: "Merged plan", exact: true }))
          .toBeInTheDocument();
        expect(document.body.textContent).toContain("Recovered body");
      } finally {
        await screen.unmount();
      }
    });

    it("reports a load that left the plans omitted instead of loading forever", async () => {
      const mergeId = ThreadId.makeUnsafe("archived-merge-still-omitted");
      const workflow = createPlanningWorkflow({
        id: workflowId,
        merge: { threadId: mergeId, status: "manual_review", approvedPlanId: "final-plan" },
      });
      threadPreloadMocks.warmThreadBundle.mockResolvedValue(undefined);
      useStore.setState({
        threads: [archivedMergeThread(mergeId, workflow)],
        planningWorkflows: [workflow],
      });
      const screen = await renderView(<WorkflowView workflowId={workflowId} />);
      try {
        await expect
          .element(page.getByText("The merged plan could not be loaded.", { exact: true }))
          .toBeInTheDocument();
      } finally {
        await screen.unmount();
      }
    });

    it("retries a failed load once the connection synchronizes again", async () => {
      const mergeId = ThreadId.makeUnsafe("archived-merge-retried");
      const workflow = createPlanningWorkflow({
        id: workflowId,
        merge: { threadId: mergeId, status: "manual_review", approvedPlanId: "final-plan" },
      });
      const thread = archivedMergeThread(mergeId, workflow);
      threadPreloadMocks.warmThreadBundle
        .mockRejectedValueOnce(new Error("WebSocket connection closed."))
        .mockImplementationOnce(async () => {
          const { proposedPlansOmitted: _omitted, ...loaded } = thread;
          useStore.setState({ threads: [{ ...loaded, proposedPlans: [mergedPlan(workflow)] }] });
        });
      useStore.setState({ threads: [thread], planningWorkflows: [workflow] });
      const screen = await renderView(<WorkflowView workflowId={workflowId} />);
      try {
        await expect
          .element(page.getByText("The merged plan could not be loaded.", { exact: true }))
          .toBeInTheDocument();
        noteWsConnectionClosed();
        // A real reconnect renders while it opens and synchronizes the new socket.
        await new Promise((resolve) => setTimeout(resolve, 50));
        noteWsConnectionOpened();
        noteWsSynchronized();
        await expect
          .element(page.getByRole("heading", { name: "Merged plan", exact: true }))
          .toBeInTheDocument();
        expect(threadPreloadMocks.warmThreadBundle).toHaveBeenCalledTimes(2);
      } finally {
        await screen.unmount();
      }
    });
  });

  it("confirms finishing without reader review and leaves cancel harmless", async () => {
    nativeApiMocks.skipDocumentReaderPass.mockResolvedValue({ status: "completed" });
    useStore.setState({
      planningWorkflows: [
        createPlanningWorkflow({
          id: workflowId,
          templateId: "builtin.document.dual",
          documentType: "rfc",
          readerReviewEnabled: true,
          readerPass: createDocumentReaderPass({
            status: "error",
            errorStage: "reader",
            error: "Budget exhausted",
          }),
          merge: { status: "merged" },
        }),
      ],
    });
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);
    try {
      await expect.element(page.getByText("Document · RFC", { exact: true })).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Implement", exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Finish without reader review", exact: true }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(nativeApiMocks.skipDocumentReaderPass).not.toHaveBeenCalled();
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Finish without reader review", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Finish without reader review", exact: true })
        .click();
      await vi.waitFor(() =>
        expect(nativeApiMocks.skipDocumentReaderPass).toHaveBeenCalledWith({ workflowId }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it.each([new Error("The reader is still running."), "unavailable"])(
    "shows the appropriate skip failure for %s",
    async (failure) => {
      nativeApiMocks.skipDocumentReaderPass.mockRejectedValue(failure);
      const addToast = vi.spyOn(toastManager, "add");
      useStore.setState({
        planningWorkflows: [
          createPlanningWorkflow({
            id: workflowId,
            templateId: "builtin.document.dual",
            documentType: "rfc",
            readerReviewEnabled: true,
            readerPass: createDocumentReaderPass({
              status: "error",
              errorStage: "reader",
              error: "Reader failed",
            }),
            merge: { status: "merged" },
          }),
        ],
      });
      const screen = await renderView(<WorkflowView workflowId={workflowId} />);
      try {
        await page
          .getByRole("button", { name: "Finish without reader review", exact: true })
          .click();
        await page
          .getByRole("alertdialog")
          .getByRole("button", { name: "Finish without reader review", exact: true })
          .click();
        await vi.waitFor(() =>
          expect(addToast).toHaveBeenCalledWith({
            type: "error",
            title:
              failure instanceof Error
                ? failure.message
                : "Failed to finish without reader review.",
          }),
        );
      } finally {
        await screen.unmount();
      }
    },
  );

  it("shows retry failures instead of swallowing them", async () => {
    nativeApiMocks.retryWorkflow.mockRejectedValue(new Error("Provider is unavailable"));
    const toastSpy = vi.spyOn(toastManager, "add");
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);

    try {
      await page.getByRole("button", { name: "Retry failed" }).click();
      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith({
          type: "error",
          title: "Provider is unavailable",
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("closes duplicate-risk confirmation when the confirmed retry fails", async () => {
    nativeApiMocks.retryWorkflow
      .mockResolvedValueOnce({ status: "confirmation_required", threadIds: ["author-a"] })
      .mockRejectedValueOnce(new Error("Confirmed retry failed"));
    const toastSpy = vi.spyOn(toastManager, "add");
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);

    try {
      await page.getByRole("button", { name: "Retry failed" }).click();
      await page.getByRole("button", { name: "Retry anyway" }).click();
      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith({
          type: "error",
          title: "Confirmed retry failed",
        });
      });
      await expect
        .element(page.getByRole("button", { name: "Retry anyway" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});

describe("WorkflowView steps", () => {
  const branchAThreadId = ThreadId.makeUnsafe("workflow-branch-a");

  function makeBranchAThread(): Thread {
    const workflow = createPlanningWorkflow({ id: workflowId });
    return {
      id: branchAThreadId,
      codexThreadId: null,
      projectId: workflow.projectId,
      title: "A long generated thread title",
      model: "claude-sonnet-4-5",
      runtimeMode: "full-access",
      interactionMode: "plan",
      session: null,
      messages: [],
      commandExecutions: [],
      proposedPlans: [],
      error: null,
      createdAt: workflow.createdAt,
      archivedAt: null,
      lastInteractionAt: workflow.updatedAt,
      estimatedContextTokens: null,
      estimatedThinkingTokens: null,
      modelContextWindowTokens: null,
      latestTurn: null,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
      detailsLoaded: true,
      tasks: [],
      tasksTurnId: null,
      tasksUpdatedAt: null,
    };
  }

  function stepByLabel(label: string): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="workflow-step"]')).find(
      (step) => step.textContent?.includes(label),
    );
  }

  beforeEach(() => {
    useStore.setState({
      threads: [makeBranchAThread()],
      planningWorkflows: [createPlanningWorkflow({ id: workflowId })],
    });
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    useStore.setState({ threads: [], planningWorkflows: [] });
    await page.viewport(1280, 720);
  });

  it("shows phases as board columns on wide screens", async () => {
    await page.viewport(1440, 900);
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);
    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="workflow-board"]')).not.toBeNull();
      });
      expect(document.querySelector('[data-slot="workflow-phase-list"]')).toBeNull();
      expect(document.querySelectorAll('[data-slot="workflow-board-column"]')).toHaveLength(7);
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Workflow status test");
      expect(document.body.textContent).not.toContain("Back to chat");
    } finally {
      await screen.unmount();
    }
  });

  it("falls back to the step list on narrow screens", async () => {
    await page.viewport(760, 900);
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);
    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="workflow-phase-list"]')).not.toBeNull();
      });
      expect(document.querySelector('[data-slot="workflow-board"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("labels steps by role and shows the thread's model, or the slot before it exists", async () => {
    await page.viewport(1440, 900);
    const screen = await renderView(<WorkflowView workflowId={workflowId} />);
    try {
      await vi.waitFor(() => expect(stepByLabel("Branch A")).toBeDefined());
      const branchA = stepByLabel("Branch A")!;
      expect(branchA.textContent).not.toContain("A long generated thread title");
      // The thread exists: its actual model wins over the configured slot.
      expect(branchA.querySelector('[title^="Claude · "]')).not.toBeNull();
      // Merge has no thread yet: the configured slot shows instead.
      const merge = stepByLabel("Merge")!;
      expect(merge.dataset.stepState).toBe("pending");
      expect(merge.querySelector('[title^="Codex · "]')).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
