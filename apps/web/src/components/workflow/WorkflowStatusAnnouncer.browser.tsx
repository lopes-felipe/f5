import { afterEach, describe, expect, it, vi } from "vitest";
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
  const rawRegion = () =>
    host.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "";
  const region = () => rawRegion().replace(/\u00A0$/, "");
  const update = (next: Props) => screen.rerender(<WorkflowStatusAnnouncer {...next} />);
  return { rawRegion, region, update, unmount: () => screen.unmount() };
}

describe("WorkflowStatusAnnouncer", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("stays silent on mount and announces phase changes, within-phase status changes, completion, and failures", async () => {
    const base: Props = {
      workflowKey: "wf-1",
      title: "Refactor auth",
      overallState: "pending",
      statusLabel: "Queued",
      phases: [{ id: "draft", label: "Drafting", state: "pending", steps: [] }],
    };

    const mounted = await mount(base);
    try {
      expect(mounted.region()).toBe("");

      // Pending -> active without an active phase announces "Workflow running: ...".
      await mounted.update({
        ...base,
        overallState: "active",
        statusLabel: "Starting",
        phases: [{ id: "draft", label: "Drafting", state: "pending", steps: [] }],
      });
      expect(mounted.region()).toBe("Workflow running: Starting");

      // Phase transition announces "Workflow phase: ...".
      await mounted.update({
        ...base,
        overallState: "active",
        statusLabel: "Reader reviewing",
        phases: [
          { id: "draft", label: "Drafting", state: "completed", steps: [] },
          { id: "reader-pass", label: "Reader pass", state: "active", steps: [] },
        ],
      });
      expect(mounted.region()).toBe("Workflow phase: Reader pass");

      // Within the same active phase ("Reader pass"), statusLabel change announces "Workflow status: ...".
      await mounted.update({
        ...base,
        overallState: "active",
        statusLabel: "Polishing",
        phases: [
          { id: "draft", label: "Drafting", state: "completed", steps: [] },
          { id: "reader-pass", label: "Reader pass", state: "active", steps: [] },
        ],
      });
      expect(mounted.region()).toBe("Workflow status: Polishing");

      // Active workflow with only an error phase (no active phase) must NOT announce the failed phase as progress.
      await mounted.update({
        ...base,
        overallState: "active",
        statusLabel: "Polishing",
        phases: [
          { id: "draft", label: "Drafting", state: "completed", steps: [] },
          { id: "reader-pass", label: "Reader pass", state: "error", steps: [] },
        ],
      });
      expect(mounted.region()).toBe("Workflow status: Polishing");

      await mounted.update({
        ...base,
        overallState: "completed",
        statusLabel: "Completed",
        phases: [
          { id: "draft", label: "Drafting", state: "completed", steps: [] },
          { id: "reader-pass", label: "Reader pass", state: "completed", steps: [] },
        ],
      });
      expect(mounted.region()).toBe("Workflow completed: Refactor auth");

      // Route/workflow switch resets silently.
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

  it("toggles a trailing NBSP on repeated identical announcements and clears after 7 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const base: Props = {
      workflowKey: "wf-repeat",
      title: "Repeat test",
      overallState: "active",
      statusLabel: "Drafting",
      phases: [{ id: "draft", label: "Drafting", state: "active", steps: [] }],
    };

    const mounted = await mount(base);
    try {
      await mounted.update({
        ...base,
        overallState: "error",
        statusLabel: "Timed out",
        phases: [{ id: "draft", label: "Drafting", state: "error", steps: [] }],
      });
      const firstRaw = mounted.rawRegion();
      expect(firstRaw).toBe("Workflow failed: Timed out\u00A0");

      // Move through pending (silent) and fail again with the exact same message; trailing NBSP toggles.
      await mounted.update({
        ...base,
        overallState: "pending",
        statusLabel: "Queued",
        phases: [{ id: "draft", label: "Drafting", state: "pending", steps: [] }],
      });
      await mounted.update({
        ...base,
        overallState: "error",
        statusLabel: "Timed out",
        phases: [{ id: "draft", label: "Drafting", state: "error", steps: [] }],
      });
      const secondRaw = mounted.rawRegion();
      expect(secondRaw).toBe("Workflow failed: Timed out");
      expect(secondRaw).not.toBe(firstRaw);

      // Advancing 7 seconds clears the live region so returning from a dialog does not replay stale status.
      vi.advanceTimersByTime(7_000);
      await vi.waitFor(() => {
        expect(mounted.rawRegion()).toBe("");
      });
    } finally {
      await mounted.unmount();
    }
  });
});
