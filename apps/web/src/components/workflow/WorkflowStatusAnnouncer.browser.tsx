import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { WorkflowStatusAnnouncer } from "./WorkflowStatusAnnouncer";
import type { WorkflowOverallState, WorkflowTimelinePhase } from "./workflowTimelineTypes";

interface Props {
  workflowKey: string;
  title: string;
  overallState: WorkflowOverallState;
  statusLabel: string;
  phases: ReadonlyArray<WorkflowTimelinePhase>;
}

async function mount(initial: Props) {
  const host = document.body.appendChild(document.createElement("div"));
  const screen = await render(<WorkflowStatusAnnouncer {...initial} />, { container: host });
  const region = () =>
    (host.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "").replace(
      /\u00A0$/,
      "",
    );
  const update = (next: Props) => screen.rerender(<WorkflowStatusAnnouncer {...next} />);
  return { region, update, unmount: () => screen.unmount() };
}

describe("WorkflowStatusAnnouncer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays silent on mount and announces phase changes, completion, and failures", async () => {
    const base: Props = {
      workflowKey: "wf-1",
      title: "Refactor auth",
      overallState: "active",
      statusLabel: "Drafting",
      phases: [{ id: "draft", label: "Drafting", state: "active", steps: [] }],
    };

    const mounted = await mount(base);
    try {
      expect(mounted.region()).toBe("");

      await mounted.update({
        ...base,
        statusLabel: "Cross-review",
        phases: [
          { id: "draft", label: "Drafting", state: "completed", steps: [] },
          { id: "review", label: "Cross-review", state: "active", steps: [] },
        ],
      });
      expect(mounted.region()).toBe("Workflow phase: Cross-review");

      await mounted.update({
        ...base,
        overallState: "completed",
        statusLabel: "Completed",
        phases: [
          { id: "draft", label: "Drafting", state: "completed", steps: [] },
          { id: "review", label: "Cross-review", state: "completed", steps: [] },
        ],
      });
      expect(mounted.region()).toBe("Workflow completed: Refactor auth");

      await mounted.update({
        ...base,
        workflowKey: "wf-2",
        title: "Second run",
        overallState: "active",
        statusLabel: "Running",
        phases: [{ id: "draft", label: "Drafting", state: "active", steps: [] }],
      });
      expect(mounted.region()).toBe("");

      await mounted.update({
        ...base,
        workflowKey: "wf-2",
        title: "Second run",
        overallState: "error",
        statusLabel: "Reviewer failed",
        phases: [{ id: "draft", label: "Drafting", state: "error", steps: [] }],
      });
      expect(mounted.region()).toBe("Workflow failed: Reviewer failed");
    } finally {
      await mounted.unmount();
    }
  });
});
