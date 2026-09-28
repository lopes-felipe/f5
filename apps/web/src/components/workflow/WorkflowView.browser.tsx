import type { Thread } from "../../types";
import "../../index.css";

import { PlanningWorkflowId, ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useStore } from "../../store";
import { toastManager } from "../ui/toast";
import { createPlanningWorkflow, createDocumentReaderPass } from "../../test/workflowFixtures";

const nativeApiMocks = vi.hoisted(() => ({
  retryWorkflow: vi.fn(),
  skipDocumentReaderPass: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      retryWorkflow: nativeApiMocks.retryWorkflow,
      skipDocumentReaderPass: nativeApiMocks.skipDocumentReaderPass,
    },
  }),
}));

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("./WorkflowRunInspector", () => ({ WorkflowRunInspector: () => null }));
vi.mock("./WorkflowImplementDialog", () => ({ WorkflowImplementDialog: () => null }));
vi.mock("./WorkflowTimelinePhaseList", () => ({ WorkflowTimelinePhaseList: () => null }));

import { WorkflowView } from "./WorkflowView";

const workflowId = PlanningWorkflowId.makeUnsafe("retry-workflow");

describe("WorkflowView retry", () => {
  beforeEach(() => {
    nativeApiMocks.retryWorkflow.mockReset();
    nativeApiMocks.skipDocumentReaderPass.mockReset();
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

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    useStore.setState({ threads: [], planningWorkflows: [] });
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
    const screen = await render(<WorkflowView workflowId={workflowId} />);
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
    const screen = await render(<WorkflowView workflowId={workflowId} />);
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
      const screen = await render(<WorkflowView workflowId={workflowId} />);
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
    const screen = await render(<WorkflowView workflowId={workflowId} />);

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
    const screen = await render(<WorkflowView workflowId={workflowId} />);

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
