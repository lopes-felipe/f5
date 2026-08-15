import "../index.css";

import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { AgentsPanelEntry, AgentsPanelModel } from "../lib/agentsModel";
import { AgentsPanelView } from "./AgentsPanel";

const THREAD_ID = ThreadId.makeUnsafe("thread-agents");

function entry(overrides: Partial<AgentsPanelEntry> = {}): AgentsPanelEntry {
  return {
    id: "work-1",
    workItemIds: ["provider-work-1"],
    threadId: THREAD_ID,
    threadTitle: "Investigate pagination",
    projectName: "f5",
    turnId: null,
    focusActivityId: "activity-parent",
    ownership: "direct-subagent",
    classification: "working",
    status: "running",
    active: true,
    provider: "codex",
    model: "gpt-5.4",
    phase: "explore",
    title: "Review pagination",
    detail: "Inspecting activity cursors",
    outputTruncated: false,
    startedAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:05.000Z",
    completedAt: null,
    ...overrides,
  };
}

function model(overrides: Partial<AgentsPanelModel> = {}): AgentsPanelModel {
  return {
    directEntries: [entry()],
    workflowEntries: [
      entry({
        id: "workflow-1",
        workItemIds: ["workflow-1"],
        ownership: "workflow",
        classification: "monitoring",
        status: "completed",
        active: false,
        title: "Verify repository",
        detail: "All checks passed",
        completedAt: "2026-08-15T10:00:12.000Z",
      }),
    ],
    liveCount: 1,
    settledCount: 1,
    coverageWindowLimited: true,
    generatedAt: "2026-08-15T10:00:12.000Z",
    ...overrides,
  };
}

describe("AgentsPanelView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("groups workflow and direct work and navigates from a source row", async () => {
    const onNavigate = vi.fn();
    const screen = await render(
      <div className="h-[600px] w-[420px]">
        <AgentsPanelView
          model={model()}
          loading={false}
          error={false}
          fetching={false}
          now={Date.parse("2026-08-15T10:00:15.000Z")}
          onRetry={() => {}}
          onNavigate={onNavigate}
        />
      </div>,
    );

    try {
      await expect.element(page.getByRole("region", { name: "Workflow work" })).toBeVisible();
      await expect.element(page.getByRole("region", { name: "Direct subagents" })).toBeVisible();
      await expect.element(page.getByText("1 working · 1 settled", { exact: true })).toBeVisible();
      await expect
        .element(
          page.getByText(
            "Durable status is complete; activity detail reflects the loaded history window.",
            { exact: true },
          ),
        )
        .toBeVisible();

      await page
        .getByRole("button", { name: "Open Review pagination in Investigate pagination" })
        .click();
      expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: "work-1" }));
    } finally {
      await screen.unmount();
    }
  });

  it("offers retry when the durable snapshot is unavailable", async () => {
    const onRetry = vi.fn();
    const screen = await render(
      <AgentsPanelView
        model={model({ directEntries: [], workflowEntries: [], liveCount: 0, settledCount: 0 })}
        loading={false}
        error={true}
        fetching={false}
        now={0}
        onRetry={onRetry}
        onNavigate={() => {}}
      />,
    );

    try {
      await page.getByRole("button", { name: "Retry" }).click();
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
