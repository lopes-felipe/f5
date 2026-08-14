import "../../index.css";

import { PlanningWorkflowId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useStore } from "../../store";
import { toastManager } from "../ui/toast";
import { createPlanningWorkflow } from "../../test/workflowFixtures";

const nativeApiMocks = vi.hoisted(() => ({
  retryWorkflow: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { retryWorkflow: nativeApiMocks.retryWorkflow },
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
