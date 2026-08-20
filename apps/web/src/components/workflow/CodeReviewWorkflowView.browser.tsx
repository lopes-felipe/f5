import "../../index.css";

import {
  CodeReviewWorkflowId,
  ProjectId,
  ThreadId,
  type CodeReviewWorkflow,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useStore } from "../../store";
import { toastManager } from "../ui/toast";

const nativeApiMocks = vi.hoisted(() => ({
  connected: true,
  retryCodeReviewWorkflow: vi.fn(),
  deleteCodeReviewWorkflow: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () =>
    nativeApiMocks.connected
      ? {
          orchestration: {
            retryCodeReviewWorkflow: nativeApiMocks.retryCodeReviewWorkflow,
            deleteCodeReviewWorkflow: nativeApiMocks.deleteCodeReviewWorkflow,
          },
        }
      : null,
}));

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../../lib/orchestrationReactQuery", () => ({ useThreadDetail: () => undefined }));
vi.mock("./WorkflowRunInspector", () => ({ WorkflowRunInspector: () => null }));
vi.mock("./WorkflowTimelinePhaseList", () => ({ WorkflowTimelinePhaseList: () => null }));

import { CodeReviewWorkflowView } from "./CodeReviewWorkflowView";

const NOW = "2026-08-20T12:00:00.000Z";
const workflowId = CodeReviewWorkflowId.makeUnsafe("code-review-retry");

function makeWorkflow(): CodeReviewWorkflow {
  return {
    id: workflowId,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Review Pedregal",
    slug: "review-pedregal",
    reviewPrompt: "Review the pull request",
    branch: null,
    reviewerA: {
      label: "Reviewer A",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      status: "error",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: "Reviewer A provider disconnected",
      updatedAt: NOW,
    },
    reviewerB: {
      label: "Reviewer B",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      status: "completed",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    consolidation: {
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
  };
}

describe("CodeReviewWorkflowView recovery", () => {
  beforeEach(() => {
    nativeApiMocks.connected = true;
    nativeApiMocks.retryCodeReviewWorkflow.mockReset();
    nativeApiMocks.deleteCodeReviewWorkflow.mockReset();
    useStore.setState({ threads: [], codeReviewWorkflows: [makeWorkflow()] });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    useStore.setState({ threads: [], codeReviewWorkflows: [] });
  });

  it("shows the exact failed stage and reports retry failures", async () => {
    nativeApiMocks.retryCodeReviewWorkflow.mockRejectedValue(new Error("Provider is unavailable"));
    const toastSpy = vi.spyOn(toastManager, "add");
    const screen = await render(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await expect.element(page.getByText("Reviewer A provider disconnected")).toBeVisible();
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

  it("confirms ambiguous delivery risk with the same retry scope", async () => {
    nativeApiMocks.retryCodeReviewWorkflow
      .mockResolvedValueOnce({ status: "confirmation_required", threadIds: ["reviewer-a"] })
      .mockResolvedValueOnce({ status: "started" });
    const screen = await render(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await page.getByRole("button", { name: "Retry failed" }).click();
      await page.getByRole("button", { name: "Retry anyway" }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.retryCodeReviewWorkflow).toHaveBeenLastCalledWith({
          workflowId,
          scope: "failed",
          allowPossibleDuplicate: true,
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("reports that retry is unavailable while disconnected", async () => {
    nativeApiMocks.connected = false;
    const toastSpy = vi.spyOn(toastManager, "add");
    const screen = await render(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await page.getByRole("button", { name: "Retry failed" }).click();
      expect(toastSpy).toHaveBeenCalledWith({
        type: "error",
        title: "Code-review retry is unavailable while disconnected.",
      });
      expect(nativeApiMocks.retryCodeReviewWorkflow).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
