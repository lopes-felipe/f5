import "../../index.css";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationUsageLimit,
  type NextTurnQueueSnapshot,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { UsageLimitResumeAction } from "./UsageLimitResumeAction";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  schedule: vi.fn(),
  refresh: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
  promote: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    nextTurnQueue: {
      list: mocks.list,
      scheduleUsageLimitResume: mocks.schedule,
      refreshUsageLimitResume: mocks.refresh,
      promote: mocks.promote,
      cancelUsageLimitResume: mocks.cancel,
    },
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => false,
  useUpdateSettings: () => ({ updateSettings: mocks.update }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
const threadId = ThreadId.makeUnsafe("usage-resume-thread");
const limit: OrchestrationUsageLimit = {
  windows: [{ id: "five_hour", label: "5-hour limit", resetsAt: "2026-10-08T12:00:00.000Z" }],
  resetsAt: "2026-10-08T12:00:00.000Z",
  resetSource: "provider",
  evidence: "typed",
  providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
  turnId: TurnId.makeUnsafe("failed-turn"),
  deliveryId: null,
};
const snapshot: NextTurnQueueSnapshot = {
  threadId,
  items: [],
  revision: 1,
  paused: false,
  blockedKind: null,
  reasonCode: null,
  reasonDetail: null,
  maxItems: 20,
  quarantinedCount: 0,
};
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(snapshot);
  mocks.schedule.mockResolvedValue(snapshot);
  mocks.refresh.mockResolvedValue(snapshot);
  mocks.update.mockResolvedValue(undefined);
  mocks.promote.mockResolvedValue(snapshot);
  mocks.cancel.mockResolvedValue({ kind: "cancelled", snapshot });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  useNextTurnQueueStore.setState({ byThreadId: {}, summary: { threads: [] } });
});
describe("UsageLimitResumeAction", () => {
  it("schedules the correlated failure and exposes the opt-in checkbox", async () => {
    active = await render(<UsageLimitResumeAction threadId={threadId} limit={limit} />);
    await page.getByRole("button", { name: /^Continue at/ }).click();
    expect(mocks.schedule).toHaveBeenCalledWith({
      threadId,
      expectedLimitKey: "instance:claude:turn:failed-turn",
    });
    await page.getByText("Options", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Always continue automatically" }).click();
    expect(mocks.update).toHaveBeenCalledWith({ autoResumeUsageLimitedThreads: true });
  });
  it("offers refresh and a time picker for an unknown reset", async () => {
    active = await render(
      <UsageLimitResumeAction threadId={threadId} limit={{ ...limit, resetsAt: null }} />,
    );
    await expect
      .element(page.getByText("Reset time unavailable", { exact: false }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    expect(mocks.refresh).toHaveBeenCalledWith({
      threadId,
      expectedLimitKey: "instance:claude:turn:failed-turn",
    });
    await page.getByRole("button", { name: "Schedule continue…" }).click();
    await expect.element(page.getByText("Custom", { exact: true })).toBeInTheDocument();
  });
  it("shows the scheduled time, send now, cancel, and a manual pause note", async () => {
    const scheduled: NextTurnQueueSnapshot = {
      ...snapshot,
      paused: true,
      usageLimitResume: {
        limitKey: "instance:claude:turn:failed-turn",
        resetsAt: limit.resetsAt,
        source: "manual",
        state: "scheduled",
        itemId: CommandId.makeUnsafe("resume"),
      },
      items: [
        {
          itemId: CommandId.makeUnsafe("resume"),
          threadId,
          submissionId: CommandId.makeUnsafe("submission"),
          position: 0,
          status: "queued",
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("command"),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe("message"),
              role: "user",
              text: "continue",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            presentation: "continuation",
            createdAt: "2026-10-08T12:00:00.000Z",
          },
          attemptCount: 0,
          notBefore: "2026-10-08T12:01:00.000Z",
          scheduleReason: "usage_limit_reset",
          dispatchStartedAt: null,
          lastErrorCode: null,
          lastErrorDetail: null,
          createdAt: "2026-10-08T12:00:00.000Z",
          updatedAt: "2026-10-08T12:00:00.000Z",
        },
      ],
    };
    mocks.list.mockResolvedValue(scheduled);
    mocks.promote.mockResolvedValue(scheduled);
    active = await render(<UsageLimitResumeAction threadId={threadId} limit={limit} />);
    await expect.element(page.getByText(/^Continue scheduled for/)).toBeInTheDocument();
    await expect
      .element(page.getByText("The queue must be resumed before this continue can send."))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Send now" }).click();
    expect(mocks.promote).toHaveBeenCalledWith({
      itemId: "resume",
      interruptActive: false,
      expectedRevision: 1,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(mocks.cancel).toHaveBeenCalledWith({ threadId, itemId: "resume", expectedRevision: 1 });
  });

  it("shows a failed queued continue without claiming it was sent", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      items: [
        {
          itemId: CommandId.makeUnsafe("failed-resume"),
          threadId,
          submissionId: CommandId.makeUnsafe("failed-submission"),
          position: 0,
          status: "failed",
          command: {},
          attemptCount: 3,
          notBefore: null,
          scheduleReason: "usage_limit_reset",
          dispatchStartedAt: null,
          lastErrorCode: "dispatch_rejected",
          lastErrorDetail: "Provider unavailable",
          createdAt: limit.resetsAt,
          updatedAt: limit.resetsAt,
        },
      ],
      usageLimitResume: {
        limitKey: "instance:claude:turn:failed-turn",
        resetsAt: limit.resetsAt,
        source: "auto",
        state: "scheduled",
        itemId: CommandId.makeUnsafe("failed-resume"),
      },
    });
    active = await render(<UsageLimitResumeAction threadId={threadId} limit={limit} />);
    await expect
      .element(page.getByText("Continue could not be sent. Review the queued turn."))
      .toBeInTheDocument();
    await expect.element(page.getByText("Continued", { exact: true })).not.toBeInTheDocument();
  });

  it("shows Continued for a completed recovery without claiming task completion", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      usageLimitResume: {
        limitKey: "instance:claude:turn:failed-turn",
        resetsAt: limit.resetsAt,
        source: "auto",
        state: "completed",
        itemId: null,
      },
    });
    active = await render(<UsageLimitResumeAction threadId={threadId} limit={limit} />);
    await expect.element(page.getByText("Continued", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^Continue at/ }))
      .not.toBeInTheDocument();
  });

  it("keeps manual scheduling available after the loop guard gives up", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      usageLimitResume: {
        limitKey: "instance:claude:turn:failed-turn",
        resetsAt: limit.resetsAt,
        source: "auto",
        state: "gave_up",
        itemId: null,
      },
    });
    active = await render(<UsageLimitResumeAction threadId={threadId} limit={limit} />);
    await expect.element(page.getByText(/^Automatic continue stopped/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Continue at/ })).toBeEnabled();
  });

  it("keeps a definitely-unsent rejection on the original-message retry path", async () => {
    active = await render(
      <UsageLimitResumeAction
        threadId={threadId}
        limit={{ ...limit, turnId: null, deliveryId: "delivery" }}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: /^Continue at/ }))
      .not.toBeInTheDocument();
  });

  it("explains cancellation and keeps manual scheduling available", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      usageLimitResume: {
        limitKey: "instance:claude:turn:failed-turn",
        resetsAt: limit.resetsAt,
        source: "auto",
        state: "cancelled",
        itemId: null,
      },
    });
    active = await render(<UsageLimitResumeAction threadId={threadId} limit={limit} />);
    await expect
      .element(page.getByText("Scheduled continue cancelled.", { exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Continue at/ })).toBeEnabled();
  });

  it("explains a scheduled continue rejected before starting", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      items: [{ scheduleReason: "usage_limit_reset", status: "failed" }],
    });
    active = await render(
      <UsageLimitResumeAction
        threadId={threadId}
        limit={{ ...limit, turnId: null, deliveryId: "delivery" }}
      />,
    );
    await expect
      .element(
        page.getByText(
          "Scheduled continue was rejected before starting. Retry the queued turn after the reset.",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^Continue at/ }))
      .not.toBeInTheDocument();
  });

  for (const state of ["completed", "gave_up"] as const) {
    it(`ignores ${state} from a previous failure`, async () => {
      mocks.list.mockResolvedValue({
        ...snapshot,
        usageLimitResume: {
          limitKey: "instance:claude:turn:previous-turn",
          resetsAt: limit.resetsAt,
          source: "auto",
          state,
          itemId: null,
        },
      });
      active = await render(<UsageLimitResumeAction threadId={threadId} limit={limit} />);
      await expect.element(page.getByRole("button", { name: /^Continue at/ })).toBeEnabled();
      await expect.element(page.getByText("Continued", { exact: true })).not.toBeInTheDocument();
      await expect.element(page.getByText(/^Automatic continue stopped/)).not.toBeInTheDocument();
    });
  }

  it("surfaces a stale failure as a toast", async () => {
    mocks.schedule.mockRejectedValue(new Error("This usage limit has changed."));
    active = await render(<UsageLimitResumeAction threadId={threadId} limit={limit} />);
    await page.getByRole("button", { name: /^Continue at/ }).click();
    await expect.poll(() => mocks.toast.mock.calls.length).toBe(1);
  });
});
