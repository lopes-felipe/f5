import "../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  ThreadId,
  ProviderInstanceId,
  type NativeHistoryRecovery,
  type NativeOperationRecord,
  type ThreadBackgroundWorkEntry,
} from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";
import { toastManager } from "../ui/toast";
import { NativeRuntimeTray } from "./NativeRuntimeTray";

const mocks = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<readonly NativeOperationRecord[]> => []),
  snapshot: vi.fn(async () => ({ entries: [] as ThreadBackgroundWorkEntry[] })),
  resolve: vi.fn(),
  execute: vi.fn(),
  inspect: vi.fn(),
  historyRecovery: vi.fn(async (): Promise<NativeHistoryRecovery | null> => null),
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    nativeOperations: {
      list: mocks.list,
      resolve: mocks.resolve,
      execute: mocks.execute,
      inspect: mocks.inspect,
      historyRecovery: mocks.historyRecovery,
    },
    agents: { getSnapshot: mocks.snapshot },
  }),
}));

const at = "2020-01-01T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread");
const record = (
  state: NativeOperationRecord["state"],
  overrides: Partial<NativeOperationRecord> = {},
): NativeOperationRecord => ({
  operationId: "operation",
  threadId,
  generation: 1,
  state,
  command: { kind: "compact" },
  createdAt: at,
  updatedAt: at,
  ...overrides,
});
const props = {
  threadId,
  capabilities: { generation: 1, discovery: "discovered" as const, checkedAt: at, actions: [] },
  activities: [],
  prompt: "",
  onSuggestion: () => {},
};
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const taskProps = {
  ...props,
  capabilities: {
    ...props.capabilities,
    actions: [
      { action: "childTaskInspection" as const, supported: true },
      { action: "childTaskStop" as const, supported: true },
    ],
  },
};
const shellTask = (
  taskId: string,
  description: string,
  startedSecondsAgo: number,
): ThreadBackgroundWorkEntry => {
  const startedAt = new Date(Date.now() - startedSecondsAgo * 1000).toISOString();
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
};

describe("NativeRuntimeTray", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mocks.list.mockResolvedValue([]);
    mocks.historyRecovery.mockResolvedValue(null);
    mocks.snapshot.mockResolvedValue({ entries: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("requires confirmation before accepting incomplete non-text history and sends its exact fence", async () => {
    const expected = {
      instanceId: ProviderInstanceId.make("codex"),
      generation: 4,
      eventId: "missing-reasoning-tools-images",
    };
    mocks.historyRecovery.mockResolvedValue(expected);
    const screen = await render(<NativeRuntimeTray {...props} prompt="unsent draft" />);
    try {
      await expect.element(page.getByText("Provider history is incomplete")).toBeVisible();
      expect(mocks.historyRecovery).toHaveBeenCalledWith({ threadId, action: "inspect" });
      await page.getByRole("button", { name: "Review recovery", exact: true }).click();
      await expect.element(page.getByText(/including reasoning, tools or images/)).toBeVisible();
      expect(mocks.historyRecovery).toHaveBeenCalledTimes(1);
      mocks.historyRecovery.mockResolvedValue(null);
      await page
        .getByRole("button", { name: "Stop provider and accept incomplete history", exact: true })
        .click();
      await expect.poll(() => mocks.historyRecovery.mock.calls.length).toBe(2);
      expect(mocks.historyRecovery).toHaveBeenLastCalledWith({
        threadId,
        action: "acknowledge",
        expected,
      });
      await expect
        .element(page.getByText("Provider history is incomplete"))
        .not.toBeInTheDocument();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the recovery warning when a stale acknowledgement fails", async () => {
    const marker = {
      instanceId: ProviderInstanceId.make("codex"),
      generation: 3,
      eventId: "old-marker",
    };
    mocks.historyRecovery.mockResolvedValue(marker);
    const screen = await render(<NativeRuntimeTray {...props} prompt="keep draft" />);
    const errors = vi.spyOn(toastManager, "add");
    try {
      await page.getByRole("button", { name: "Review recovery", exact: true }).click();
      mocks.historyRecovery.mockRejectedValue(new Error("The provider session changed."));
      await page
        .getByRole("button", { name: "Stop provider and accept incomplete history", exact: true })
        .click();
      await expect.poll(() => errors.mock.calls.length).toBe(1);
      await expect.element(page.getByText("Provider history is incomplete")).toBeVisible();
      await expect.element(page.getByRole("alertdialog")).toBeVisible();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await screen.unmount();
    }
  });

  it("renders nothing for an idle thread", async () => {
    const screen = await render(<NativeRuntimeTray {...props} />);
    try {
      await nextFrame();
      expect(screen.container.childElementCount).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("does not let an older poll restore a resolved recovery row", async () => {
    mocks.list.mockResolvedValue([record("indeterminate")]);
    const screen = await render(<NativeRuntimeTray {...props} />);
    try {
      await expect
        .element(page.getByText("Compaction outcome is uncertain", { exact: true }))
        .toBeVisible();
      let finish!: (records: readonly NativeOperationRecord[]) => void;
      mocks.list.mockReturnValue(
        new Promise<readonly NativeOperationRecord[]>((resolve) => {
          finish = resolve;
        }),
      );
      vi.advanceTimersByTime(5000);
      expect(mocks.list).toHaveBeenCalledTimes(2);
      mocks.resolve.mockResolvedValue(record("completed"));
      await page.getByRole("button", { name: "Recheck outcome" }).click();
      await expect
        .element(page.getByText("Compaction outcome is uncertain", { exact: true }))
        .not.toBeInTheDocument();
      finish([record("indeterminate")]);
      await nextFrame();
      await nextFrame();
      expect(page.getByText("Compaction outcome is uncertain", { exact: true }).query()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("reports an operation that fails after it was admitted, once", async () => {
    const add = vi.spyOn(toastManager, "add");
    mocks.list.mockResolvedValue([record("running")]);
    const screen = await render(<NativeRuntimeTray {...props} />);
    try {
      await expect.element(page.getByText("Compaction running…")).toBeVisible();
      mocks.list.mockResolvedValue([record("failed", { error: "Provider refused." })]);
      vi.advanceTimersByTime(5000);
      await expect.element(page.getByText("Compaction running…")).not.toBeInTheDocument();
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Compaction failed", description: "Provider refused." }),
      );
      vi.advanceTimersByTime(5000);
      await nextFrame();
      expect(add).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore();
      await screen.unmount();
    }
  });

  describe("background tasks", () => {
    it("names a single shell by its description and stops it", async () => {
      mocks.snapshot.mockResolvedValue({
        entries: [shellTask("b1", "Run full browser suite", 192)],
      });
      mocks.execute.mockResolvedValue(
        record("completed", { command: { kind: "stopTask", taskId: "b1" } }),
      );
      const screen = await render(<NativeRuntimeTray {...taskProps} />);
      try {
        await expect.element(page.getByText("Run full browser suite")).toBeVisible();
        await expect.element(page.getByText(/^Shell · 3m/)).toBeVisible();
        expect(screen.container.textContent).not.toContain("local_bash");
        expect(screen.container.textContent).not.toContain("monitoring");
        await page.getByRole("button", { name: "Stop Run full browser suite" }).click();
        expect(mocks.execute).toHaveBeenCalledWith(
          expect.objectContaining({ command: { kind: "stopTask", taskId: "b1" } }),
        );
      } finally {
        await screen.unmount();
      }
    });

    it("collapses several tasks into one expandable row", async () => {
      mocks.snapshot.mockResolvedValue({
        entries: [
          shellTask("b1", "Watch typecheck", 340),
          shellTask("b2", "Run full browser suite", 192),
          shellTask("b3", "Run unit tests", 30),
        ],
      });
      const screen = await render(<NativeRuntimeTray {...taskProps} />);
      try {
        const toggle = page.getByRole("button", { name: /3 background tasks/ });
        await expect
          .element(toggle)
          .toHaveTextContent("3 background tasks · Run unit tests, +2 more");
        await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
        expect(page.getByRole("button", { name: /^View output/ }).all()).toHaveLength(0);

        await toggle.click();
        await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
        await expect.element(page.getByRole("button", { name: "Stop all" })).toBeVisible();
        expect(page.getByRole("button", { name: /^View output/ }).all()).toHaveLength(3);
        await expect.element(page.getByText("Watch typecheck")).toBeVisible();
      } finally {
        await screen.unmount();
      }
    });

    it("stops every task, waiting for each stop to settle before the next", async () => {
      mocks.snapshot.mockResolvedValue({
        entries: [
          shellTask("b1", "Watch typecheck", 340),
          shellTask("b2", "Run full browser suite", 192),
          shellTask("b3", "Run unit tests", 30),
        ],
      });
      // The server admits a stop as `requested` and holds the thread's
      // reservation until the provider confirms it.
      let listed: NativeOperationRecord[] = [];
      mocks.list.mockImplementation(async () => listed);
      mocks.execute.mockImplementation(
        async (input: Pick<NativeOperationRecord, "operationId" | "command">) => {
          const admitted = record("requested", {
            operationId: input.operationId,
            command: input.command,
          });
          listed = [admitted, ...listed];
          return admitted;
        },
      );
      const settleAll = () => {
        listed = listed.map((entry) => ({ ...entry, state: "completed" }));
      };
      const stoppedTaskIds = () =>
        mocks.execute.mock.calls.map(([input]) => (input as NativeOperationRecord).command);
      const screen = await render(<NativeRuntimeTray {...taskProps} />);
      try {
        await page.getByRole("button", { name: /3 background tasks/ }).click();
        const stopAll = page.getByRole("button", { name: "Stop all" });
        await stopAll.click();
        await expect.poll(() => mocks.execute.mock.calls.length).toBe(1);
        await expect.element(stopAll).toBeDisabled();
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(mocks.execute).toHaveBeenCalledTimes(1);

        settleAll();
        await expect.poll(() => mocks.execute.mock.calls.length).toBe(2);
        settleAll();
        await expect.poll(() => mocks.execute.mock.calls.length).toBe(3);
        expect(stoppedTaskIds()).toEqual([
          { kind: "stopTask", taskId: "b1" },
          { kind: "stopTask", taskId: "b2" },
          { kind: "stopTask", taskId: "b3" },
        ]);
        settleAll();
        await expect.element(stopAll).toBeEnabled();
      } finally {
        await screen.unmount();
      }
    });

    it("links running tasks to the Agents panel until it is open", async () => {
      mocks.snapshot.mockResolvedValue({
        entries: [shellTask("b1", "Watch typecheck", 30), shellTask("b2", "Run unit tests", 10)],
      });
      const onViewAgents = vi.fn(() => useRightPanelStore.getState().open(threadId, "agents"));
      const screen = await render(<NativeRuntimeTray {...taskProps} onViewAgents={onViewAgents} />);
      try {
        await page.getByRole("button", { name: "View agents" }).click();
        expect(onViewAgents).toHaveBeenCalledOnce();
        await expect
          .poll(() => page.getByRole("button", { name: "View agents" }).all())
          .toHaveLength(0);
      } finally {
        await screen.unmount();
        useRightPanelStore.getState().closeSurface(threadId, "agents");
      }
    });

    it("shows shell output as text with its truncation", async () => {
      mocks.snapshot.mockResolvedValue({
        entries: [shellTask("b1", "Run full browser suite", 192)],
      });
      mocks.inspect.mockResolvedValue({
        entries: [
          { output: "✓ ChatView.browser.tsx (88 tests)\n", totalBytes: 41_873, omitted: true },
        ],
        nextCursor: null,
      });
      const screen = await render(<NativeRuntimeTray {...taskProps} />);
      try {
        await page.getByRole("button", { name: "View output: Run full browser suite" }).click();
        const dialog = page.getByRole("dialog");
        await expect.element(dialog.getByText("✓ ChatView.browser.tsx (88 tests)")).toBeVisible();
        await expect
          .element(dialog.getByText(/Shell · running 3m.* · last 36 B of 41 KB/))
          .toBeVisible();
        expect(dialog.element().textContent).not.toContain('"entries"');
        await expect.element(dialog.getByRole("button", { name: "Refresh" })).toBeVisible();
        await expect.element(dialog.getByRole("button", { name: "Copy" })).toBeVisible();
      } finally {
        await screen.unmount();
      }
    });
  });
});
