import "../../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { HardDriveIcon } from "lucide-react";
import {
  ThreadId,
  type NativeOperationRecord,
  type ThreadBackgroundWorkEntry,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import type { TaskItem } from "~/types";
import { NativeRuntimeTray } from "../NativeRuntimeTray";
import { WorktreeSetupCard } from "../WorktreeSetupCard";
import { makeWorktreeSetupSnapshot } from "../worktreeSetupFixtures";
import {
  ComposerStatusStrip,
  ComposerStatusStripHostProvider,
  ComposerStatusStripSlot,
} from "./ComposerStatusStrip";
import {
  NoticeStatusChip,
  QueueStatusChip,
  TasksStatusChip,
  WorktreeStatusChip,
} from "./StatusStripChips";

const mocks = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<readonly NativeOperationRecord[]> => []),
  snapshot: vi.fn(async () => ({ entries: [] as ThreadBackgroundWorkEntry[] })),
  execute: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  readNativeApi: () => ({
    nativeOperations: {
      list: mocks.list,
      execute: mocks.execute,
      inspect: mocks.inspect,
      resolve: vi.fn(),
      historyRecovery: vi.fn(async () => null),
    },
    agents: { getSnapshot: mocks.snapshot },
  }),
}));

const threadId = ThreadId.makeUnsafe("strip-thread");
const at = "2020-01-01T00:00:00.000Z";

const tasks: TaskItem[] = [
  { id: "1", content: "Map the dock", activeForm: "Mapping the dock", status: "completed" },
  { id: "2", content: "Build the strip", activeForm: "Building the strip", status: "in_progress" },
  { id: "3", content: "Run the tests", activeForm: "Running the tests", status: "pending" },
] as TaskItem[];

function shellTask(taskId: string, description: string): ThreadBackgroundWorkEntry {
  const startedAt = new Date(Date.now() - 192_000).toISOString();
  return {
    threadId,
    workItemId: taskId,
    provider: "claudeAgent",
    providerInstanceId: null,
    providerSessionIdentity: null,
    turnId: null,
    classification: "monitoring",
    ownership: "direct-subagent",
    status: "monitoring",
    active: true,
    model: null,
    phase: "local_bash",
    latestOutput: description,
    outputTruncated: false,
    startedAt,
    updatedAt: startedAt,
    lastSeenAt: startedAt,
    completedAt: null,
  } as ThreadBackgroundWorkEntry;
}

const taskCapabilities = {
  generation: 1,
  discovery: "discovered" as const,
  checkedAt: at,
  actions: [
    { action: "childTaskInspection" as const, supported: true },
    { action: "childTaskStop" as const, supported: true },
  ],
};

function Harness(props: { chips?: ReactNode; tray?: ReactNode }) {
  return (
    <ComposerStatusStripHostProvider>
      <ComposerStatusStrip>
        {props.chips}
        <ComposerStatusStripSlot />
      </ComposerStatusStrip>
      <div data-testid="tray">{props.tray}</div>
    </ComposerStatusStripHostProvider>
  );
}

const strip = () => document.querySelector<HTMLElement>('[data-slot="composer-status-strip"]')!;

describe("ComposerStatusStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
    mocks.snapshot.mockResolvedValue({ entries: [] });
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays hidden until it holds a chip", async () => {
    const screen = await render(<Harness />);
    try {
      expect(getComputedStyle(strip()).display).toBe("none");
      await screen.rerender(
        <Harness chips={<TasksStatusChip tasks={tasks} summary="1 active · 1 done" />} />,
      );
      await expect.poll(() => getComputedStyle(strip()).display).toBe("flex");
    } finally {
      await screen.unmount();
    }
  });

  it("shows task progress and opens the full list in a popover", async () => {
    const screen = await render(
      <Harness chips={<TasksStatusChip tasks={tasks} summary="1 active · 1 pending · 1 done" />} />,
    );
    try {
      const chip = page.getByRole("button", { name: /^Tasks: 1 active/ });
      await expect.element(chip).toHaveTextContent("Tasks1/3");
      await chip.click();
      const popover = page.getByRole("dialog", { name: "Task list" });
      await expect.element(popover.getByText("Building the strip")).toBeVisible();
      // The popover already toggles the list, so it has no expand button of its own.
      expect(popover.getByRole("button").all()).toHaveLength(0);
      await userEvent.keyboard("{Escape}");
      await expect.element(popover).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a tall task popover anchored to its chip", async () => {
    const manyTasks = Array.from({ length: 20 }, (_, index) => ({
      id: String(index + 1),
      content: `Task ${index + 1}`,
      activeForm: `Working on task ${index + 1}`,
      status: index === 19 ? "in_progress" : "completed",
    })) as TaskItem[];
    const screen = await render(
      <div style={{ position: "fixed", bottom: 16, left: 16 }}>
        <Harness chips={<TasksStatusChip tasks={manyTasks} summary="1 active · 19 done" />} />
      </div>,
    );
    try {
      await page.getByRole("button", { name: /^Tasks: 1 active/ }).click();
      await expect
        .element(
          page
            .getByRole("dialog", { name: "Task list" })
            .getByText("Working on task 1", { exact: true }),
        )
        .toBeVisible();
      // Measure after the open scale animation, which shrinks the popup's rect.
      const popupElement = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
      await Promise.all(popupElement.getAnimations().map((animation) => animation.finished));
      const chip = document.querySelector('[data-status-chip="tasks"]')!.getBoundingClientRect();
      const popup = popupElement.getBoundingClientRect();
      const positioner = document
        .querySelector('[data-slot="popover-positioner"]')!
        .getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      expect(popup.height).toBeLessThanOrEqual(26 * rem + 2);
      expect(Math.abs(positioner.height - popup.height)).toBeLessThanOrEqual(2);
      expect(chip.top - popup.bottom).toBeGreaterThanOrEqual(0);
      expect(chip.top - popup.bottom).toBeLessThanOrEqual(12);
    } finally {
      await screen.unmount();
    }
  });

  it("shows a non-critical notice as a warning chip with the notice in its popover", async () => {
    const screen = await render(
      <Harness
        chips={
          <NoticeStatusChip
            notice={{
              id: "low-disk-space",
              content: <p>8.95 GB free on the volume holding F5 data.</p>,
              chip: {
                icon: HardDriveIcon,
                tone: "warning",
                label: "8.9 GB free",
                ariaLabel: "Low disk space: 8.9 GB free",
              },
            }}
          />
        }
      />,
    );
    try {
      const chip = page.getByRole("button", { name: "Low disk space: 8.9 GB free" });
      await expect.element(chip).toHaveTextContent("8.9 GB free");
      expect(chip.element().className).toContain("text-warning-foreground");
      await chip.click();
      await expect
        .element(page.getByText("8.95 GB free on the volume holding F5 data."))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("opens a warnings-only worktree setup expanded from its chip", async () => {
    const base = makeWorktreeSetupSnapshot();
    const snapshot = makeWorktreeSetupSnapshot({
      phase: "done",
      endedAt: "2026-10-01T10:00:04.000Z",
      stages: base.stages.map((stage, index) => ({
        ...stage,
        status: index === 0 ? ("warning" as const) : ("done" as const),
        detail: index === 0 ? "main is not on the remote; using the local branch" : null,
      })),
    });
    const screen = await render(
      <Harness
        chips={
          <WorktreeStatusChip snapshot={snapshot}>
            <WorktreeSetupCard
              variant="tray"
              defaultExpanded
              snapshot={snapshot}
              busy={false}
              onCancel={null}
              onRetry={null}
              onWorkLocally={null}
            />
          </WorktreeStatusChip>
        }
      />,
    );
    try {
      const chip = page.getByRole("button", { name: /^Worktree ready, f5\/feature, 1 warning/ });
      await expect.element(chip).toHaveTextContent("Worktree · 1 warning");
      await chip.click();
      await expect
        .element(page.getByText("main is not on the remote; using the local branch"))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "Hide setup details" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("labels the queue chip and opens its panel", async () => {
    const screen = await render(
      <Harness
        chips={
          <QueueStatusChip
            summary={{ count: 2, preview: "great, now open the PR", paused: true, warning: true }}
          >
            <p>Queued turns panel</p>
          </QueueStatusChip>
        }
      />,
    );
    try {
      const chip = page.getByRole("button", {
        name: "2 queued, paused, next: great, now open the PR",
      });
      await expect.element(chip).toBeVisible();
      await expect.element(chip.getByText("PAUSED")).toBeVisible();
      expect(chip.element().className).toContain("text-warning-foreground");
      await chip.click();
      await expect.element(page.getByText("Queued turns panel")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  describe("background work", () => {
    it("moves a background shell from the tray into a chip with Output and Stop", async () => {
      mocks.snapshot.mockResolvedValue({ entries: [shellTask("b1", "Run full browser suite")] });
      mocks.execute.mockResolvedValue({
        operationId: "operation",
        threadId,
        generation: 1,
        state: "completed",
        command: { kind: "stopTask", taskId: "b1" },
        createdAt: at,
        updatedAt: at,
      });
      mocks.inspect.mockResolvedValue({
        entries: [{ output: "✓ all green\n", totalBytes: 12, omitted: false }],
        nextCursor: null,
      });
      const screen = await render(
        <Harness
          tray={
            <NativeRuntimeTray
              threadId={threadId}
              capabilities={taskCapabilities}
              activities={[]}
              prompt=""
              onSuggestion={() => {}}
              backgroundTasksPresentation="chip"
            />
          }
        />,
      );
      try {
        const chip = page.getByRole("button", { name: /^Background work: 1 shell · 3m/ });
        await expect.element(chip).toBeVisible();
        expect(page.getByTestId("tray").element().textContent).not.toContain(
          "Run full browser suite",
        );

        await chip.click();
        await page.getByRole("button", { name: "Stop Run full browser suite" }).click();
        expect(mocks.execute).toHaveBeenCalledWith(
          expect.objectContaining({ command: { kind: "stopTask", taskId: "b1" } }),
        );

        await page.getByRole("button", { name: "View output: Run full browser suite" }).click();
        await expect.element(page.getByRole("dialog").getByText("✓ all green")).toBeVisible();
      } finally {
        await screen.unmount();
      }
    });

    it("keeps background shells as tray rows without the chip presentation", async () => {
      mocks.snapshot.mockResolvedValue({ entries: [shellTask("b1", "Run full browser suite")] });
      const screen = await render(
        <Harness
          tray={
            <NativeRuntimeTray
              threadId={threadId}
              capabilities={taskCapabilities}
              activities={[]}
              prompt=""
              onSuggestion={() => {}}
            />
          }
        />,
      );
      try {
        await expect
          .element(page.getByTestId("tray").getByText("Run full browser suite"))
          .toBeVisible();
        expect(getComputedStyle(strip()).display).toBe("none");
      } finally {
        await screen.unmount();
      }
    });
  });
});
