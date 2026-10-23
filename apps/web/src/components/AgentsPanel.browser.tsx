import "../index.css";

import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { AgentsPanelScope } from "../agentsPanelStore";
import {
  buildAgentsPanelModel,
  EMPTY_AGENTS_PANEL_MODEL,
  type AgentsPanelEntry,
  type AgentsPanelModel,
  type AgentsStatusFilter,
} from "../lib/agentsModel";
import { AgentsPanelView, type AgentsPanelViewProps } from "./AgentsPanel";

const THREAD_ID = ThreadId.makeUnsafe("thread-agents");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-other");
const NOW = Date.parse("2026-08-15T10:00:15.000Z");

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
    kind: "agent",
    classification: "working",
    status: "running",
    active: true,
    live: true,
    provider: "claudeAgent",
    model: "claude-sonnet",
    effort: "high",
    phase: "Explore",
    title: "Review pagination",
    prompt: "Find every cursor bug in the pagination code.",
    lastTool: "Read",
    detail: "Inspecting activity cursors",
    outputTruncated: false,
    nativeWorkItemId: "provider-work-1",
    startedAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:05.000Z",
    completedAt: null,
    ...overrides,
  };
}

const settledAgent = entry({
  id: "work-2",
  workItemIds: ["provider-work-2"],
  nativeWorkItemId: "provider-work-2",
  status: "completed",
  active: false,
  live: false,
  title: "Summarize findings",
  prompt: null,
  lastTool: null,
  detail: "All checks passed",
  completedAt: "2026-08-15T10:00:12.000Z",
});

const shell = entry({
  id: "shell-1",
  workItemIds: ["shell-1"],
  nativeWorkItemId: "shell-1",
  kind: "shell",
  classification: "monitoring",
  status: "monitoring",
  phase: "local_bash",
  title: "Run browser suite",
  prompt: null,
  lastTool: null,
  detail: null,
});

const otherThreadAgent = entry({
  id: "other-1",
  workItemIds: ["other-1"],
  nativeWorkItemId: "other-1",
  threadId: OTHER_THREAD_ID,
  threadTitle: "Refactor sidebar",
  status: "completed",
  active: false,
  live: false,
  title: "Audit sidebar",
  completedAt: "2026-08-15T10:00:10.000Z",
});

const threadModel = buildAgentsPanelModel([entry(), settledAgent, shell], null);
const allModel = buildAgentsPanelModel([entry(), settledAgent, shell, otherThreadAgent], null);

type HarnessProps = Partial<AgentsPanelViewProps> & {
  readonly models?: Readonly<Record<AgentsPanelScope, AgentsPanelModel>>;
};

function Harness(props: HarnessProps) {
  const { models = { thread: threadModel, all: allModel }, ...overrides } = props;
  const [scope, setScope] = useState<AgentsPanelScope>("thread");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AgentsStatusFilter>("all");
  const [backgroundTasksExpanded, setBackgroundTasksExpanded] = useState(false);
  return (
    <div className="h-[700px] w-[480px]">
      <AgentsPanelView
        model={models[scope]}
        scope={scope}
        liveCounts={{ thread: models.thread.liveCount, all: models.all.liveCount }}
        loading={false}
        error={false}
        fetching={false}
        now={NOW}
        query={query}
        statusFilter={statusFilter}
        backgroundTasksExpanded={backgroundTasksExpanded}
        stoppingIds={new Set()}
        canStop={() => false}
        canInspect={() => false}
        onScopeChange={setScope}
        onQueryChange={setQuery}
        onStatusFilterChange={setStatusFilter}
        onBackgroundTasksExpandedChange={setBackgroundTasksExpanded}
        onRetry={() => {}}
        onNavigate={() => {}}
        onOpenThread={() => {}}
        onStop={() => {}}
        onStopAll={() => {}}
        onDismiss={() => {}}
        onClearFinished={() => {}}
        onInspect={async () => null}
        onLoadPrompt={async () => null}
        {...overrides}
      />
    </div>
  );
}

describe("AgentsPanelView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the panel's text font and tabular numbers for agent elapsed time", async () => {
    await render(<Harness />);
    await expect
      .element(page.getByRole("button", { name: "Expand Review pagination" }))
      .toBeVisible();
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="agent-row"]')].find(
      (node) => node.textContent?.includes("Review pagination"),
    )!;
    const spans = [...row.querySelectorAll<HTMLElement>("span")];
    const duration = spans.find((node) => node.textContent === "15s")!;
    const title = spans.find((node) => node.textContent === "Review pagination")!;
    expect(getComputedStyle(duration).fontFamily).toBe(getComputedStyle(title).fontFamily);
    expect(getComputedStyle(duration).fontVariantNumeric).toContain("tabular-nums");
  });

  it("names the configured provider account on each agent card", async () => {
    const work = entry({
      id: "account-work",
      title: "Work agent",
      providerInstanceId: ProviderInstanceId.make("claude_work"),
    });
    const personal = entry({
      id: "account-personal",
      title: "Personal agent",
      providerInstanceId: ProviderInstanceId.make("claude_personal"),
    });
    const model = buildAgentsPanelModel([work, personal], null);
    await render(
      <Harness
        models={{ thread: model, all: model }}
        providerName={(agent) =>
          agent.providerInstanceId === work.providerInstanceId
            ? "Claude · Work"
            : "Claude · Personal"
        }
      />,
    );
    await expect.element(page.getByText("Claude · Work", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Claude · Personal", { exact: true })).toBeVisible();
  });

  it("switches between this thread and all threads", async () => {
    const screen = await render(<Harness />);
    try {
      await expect.element(page.getByText("Review pagination")).toBeVisible();
      await expect.element(page.getByText("Audit sidebar")).not.toBeInTheDocument();

      await page.getByRole("button", { name: "All threads" }).click();
      await expect.element(page.getByText("Audit sidebar")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "f5 · Refactor sidebar", exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps background tasks collapsed until expanded", async () => {
    const screen = await render(<Harness />);
    try {
      const section = page.getByRole("region", { name: "Background tasks" });
      await expect.element(section).toBeVisible();
      await expect.element(page.getByText("Run browser suite")).not.toBeInTheDocument();
      await section.getByRole("button", { name: /Background tasks/ }).click();
      await expect.element(page.getByText("Run browser suite")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("expands a row to show the prompt and metadata", async () => {
    const screen = await render(<Harness />);
    try {
      await page.getByRole("button", { name: "Expand Review pagination" }).click();
      const detail = page.getByTestId("agent-detail");
      await expect
        .element(detail.getByText("Find every cursor bug in the pagination code."))
        .toBeVisible();
      await expect.element(detail.getByText("claude-sonnet")).toBeVisible();
      await expect.element(detail.getByText("Effort", { exact: true })).toBeVisible();
      await expect.element(detail.getByText("high", { exact: true })).toBeVisible();
      await expect.element(detail.getByText("provider-work-1")).toBeVisible();
      await expect.element(detail.getByText("Inspecting activity cursors")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("hides stop without the capability and stops with it", async () => {
    const withoutCapability = await render(<Harness />);
    try {
      await expect
        .element(page.getByRole("button", { name: "Stop Review pagination" }))
        .not.toBeInTheDocument();
    } finally {
      await withoutCapability.unmount();
    }

    const onStop = vi.fn();
    const withCapability = await render(<Harness canStop={(item) => item.live} onStop={onStop} />);
    try {
      await page.getByRole("button", { name: "Expand Review pagination" }).hover();
      await page.getByRole("button", { name: "Stop Review pagination" }).click();
      expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ id: "work-1" }));
    } finally {
      await withCapability.unmount();
    }
  });

  it("confirms before stopping all running work", async () => {
    const onStopAll = vi.fn();
    const screen = await render(<Harness canStop={(item) => item.live} onStopAll={onStopAll} />);
    try {
      await page.getByRole("button", { name: "Agent actions" }).click();
      await page.getByRole("menuitem", { name: "Stop all running" }).click();
      await expect
        .element(page.getByRole("alertdialog").getByText("Stop 2 running tasks?"))
        .toBeVisible();
      expect(onStopAll).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Stop all", exact: true }).click();
      expect(onStopAll).toHaveBeenCalledWith([
        expect.objectContaining({ id: "work-1" }),
        expect.objectContaining({ id: "shell-1" }),
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("dismisses one entry and clears finished work", async () => {
    const onDismiss = vi.fn();
    const onClearFinished = vi.fn();
    const screen = await render(
      <Harness onDismiss={onDismiss} onClearFinished={onClearFinished} />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Dismiss Review pagination" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Expand Summarize findings" }).hover();
      await page.getByRole("button", { name: "Dismiss Summarize findings" }).click();
      expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: "work-2" }));

      await page.getByRole("button", { name: "Clear finished" }).click();
      expect(onClearFinished).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("confirms before clearing finished work in every thread", async () => {
    const onClearFinished = vi.fn();
    const screen = await render(<Harness onClearFinished={onClearFinished} />);
    try {
      await page.getByRole("button", { name: "All threads" }).click();
      await page.getByRole("button", { name: "Clear finished" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect.element(dialog.getByText("Clear finished work in every thread?")).toBeVisible();
      expect(onClearFinished).not.toHaveBeenCalled();
      await dialog.getByRole("button", { name: "Clear finished" }).click();
      expect(onClearFinished).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("loads a missing prompt and appends output pages", async () => {
    const onLoadPrompt = vi.fn(async () => "Loaded prompt from the thread snapshot.");
    const onInspect = vi.fn(async (_entry: AgentsPanelEntry, cursor?: string) =>
      cursor
        ? { page: { entries: ["second page"] }, nextCursor: null }
        : { page: { entries: ["first page"] }, nextCursor: "cursor-2" },
    );
    const models = {
      thread: buildAgentsPanelModel([entry({ prompt: null })], null),
      all: allModel,
    };
    const screen = await render(
      <Harness
        models={models}
        canInspect={() => true}
        onInspect={onInspect}
        onLoadPrompt={onLoadPrompt}
      />,
    );
    try {
      await page.getByRole("button", { name: "Expand Review pagination" }).click();
      const detail = page.getByTestId("agent-detail");
      await expect
        .element(detail.getByText("Loaded prompt from the thread snapshot."))
        .toBeVisible();

      await detail.getByRole("button", { name: "Inspect output" }).click();
      await expect.element(detail.getByText(/first page/)).toBeVisible();
      await detail.getByRole("button", { name: "Load more" }).click();
      await expect.element(detail.getByText(/second page/)).toBeVisible();
      await expect.element(detail.getByText(/first page/)).toBeVisible();
      expect(onInspect).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "work-1" }),
        "cursor-2",
      );
      await expect.element(detail.getByRole("button", { name: "Refresh output" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("narrows rows by search and status", async () => {
    const screen = await render(<Harness />);
    try {
      await page.getByRole("searchbox", { name: "Search agents" }).fill("summarize");
      await expect.element(page.getByText("Summarize findings")).toBeVisible();
      await expect.element(page.getByText("Review pagination")).not.toBeInTheDocument();

      await page.getByRole("button", { name: "Clear search" }).click();
      await page.getByRole("radio", { name: /Running/ }).click();
      await expect.element(page.getByText("Review pagination")).toBeVisible();
      await expect.element(page.getByText("Summarize findings")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows a per-scope empty state that can switch to all threads", async () => {
    const onlyOther = buildAgentsPanelModel([otherThreadAgent], null);
    const screen = await render(
      <Harness models={{ thread: EMPTY_AGENTS_PANEL_MODEL, all: onlyOther }} />,
    );
    try {
      await expect.element(page.getByText("No agents in this thread yet")).toBeVisible();
      await page.getByRole("button", { name: "Show all threads" }).click();
      await expect.element(page.getByText("Audit sidebar")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("offers retry when the snapshot is unavailable", async () => {
    const onRetry = vi.fn();
    const screen = await render(<Harness error={true} onRetry={onRetry} />);
    try {
      await page.getByRole("button", { name: "Retry" }).click();
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
