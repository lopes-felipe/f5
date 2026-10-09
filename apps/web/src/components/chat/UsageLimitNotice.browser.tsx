import "../../index.css";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationUsageLimit,
  type NextTurnQueueItem,
  type NextTurnQueueSnapshot,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { UsageLimitNotice } from "./UsageLimitNotice";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";

const mocks = vi.hoisted(() => ({
  automatic: false,
  projectOverride: null as boolean | null,
  list: vi.fn(),
  schedule: vi.fn(),
  refresh: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
  promote: vi.fn(),
  cancel: vi.fn(),
  dismiss: vi.fn(),
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
  useSettings: (selector: (settings: unknown) => unknown) =>
    selector({
      autoResumeUsageLimitedThreads: mocks.automatic,
      projectSettingsOverrides: {
        project: { autoResumeUsageLimitedThreads: mocks.projectOverride },
      },
    }),
  useUpdateSettings: () => ({ updateSettings: mocks.update }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
const threadId = ThreadId.makeUnsafe("usage-resume-thread");
const limitKey = "instance:claude:turn:failed-turn";
const limit: OrchestrationUsageLimit = {
  windows: [{ id: "five_hour", label: "5-hour", resetsAt: "2026-10-08T12:00:00.000Z" }],
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
function resumeItem(status: NextTurnQueueItem["status"]): NextTurnQueueItem {
  return {
    itemId: CommandId.makeUnsafe("resume"),
    threadId,
    submissionId: CommandId.makeUnsafe("submission"),
    position: 0,
    status,
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
  } as NextTurnQueueItem;
}
function scheduledSnapshot(
  status: NextTurnQueueItem["status"],
  paused = false,
): NextTurnQueueSnapshot {
  return {
    ...snapshot,
    paused,
    usageLimitResume: {
      limitKey,
      resetsAt: limit.resetsAt,
      source: "manual",
      state: "scheduled",
      itemId: CommandId.makeUnsafe("resume"),
    },
    items: [resumeItem(status)],
  };
}
function renderNotice(overrides: Partial<OrchestrationUsageLimit> = {}) {
  return render(
    <UsageLimitNotice
      threadId={threadId}
      limit={{ ...limit, ...overrides }}
      providerLabel="Claude"
      onDismiss={mocks.dismiss}
    />,
  );
}
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.automatic = false;
  mocks.projectOverride = null;
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
describe("UsageLimitNotice", () => {
  it("names the paused limit and schedules the correlated failure", async () => {
    active = await renderNotice();
    await expect
      .element(page.getByText("Paused: Claude 5-hour limit", { exact: true }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: /^Continue at/ }).click();
    expect(mocks.schedule).toHaveBeenCalledWith({ threadId, expectedLimitKey: limitKey });
  });

  it("shows the reset time with a countdown", async () => {
    const resetsAt = new Date(Date.now() + 99 * 60_000 + 30_000).toISOString();
    active = await renderNotice({ resetsAt });
    await expect.element(page.getByText(/^Resets .* · in 1h 39m$/)).toBeInTheDocument();
  });

  it("says the limit has reset once the reset time has passed", async () => {
    active = await renderNotice({ resetsAt: new Date(Date.now() - 60_000).toISOString() });
    await expect.element(page.getByText(/^Limit reset at /)).toBeInTheDocument();
    await expect.element(page.getByText(/^Resets /)).not.toBeInTheDocument();
  });

  it("toggles the global auto-continue default from the overflow menu", async () => {
    active = await renderNotice();
    await page.getByRole("button", { name: "Usage limit options" }).click();
    await expect
      .element(page.getByText("Global default. Project settings can override it."))
      .toBeInTheDocument();
    await page.getByRole("menuitemcheckbox", { name: "Always continue automatically" }).click();
    expect(mocks.update).toHaveBeenCalledWith({ autoResumeUsageLimitedThreads: true });
  });

  for (const global of [false, true]) {
    it(`reflects the global default in the menu even when a project overrides it: ${global}`, async () => {
      mocks.automatic = global;
      mocks.projectOverride = !global;
      active = await renderNotice();
      await page.getByRole("button", { name: "Usage limit options" }).click();
      const checkbox = page.getByRole("menuitemcheckbox", {
        name: "Always continue automatically",
      });
      if (global) await expect.element(checkbox).toBeChecked();
      else await expect.element(checkbox).not.toBeChecked();
    });
  }

  it("calls the dismiss handler", async () => {
    active = await renderNotice();
    await page.getByRole("button", { name: "Dismiss usage limit notice" }).click();
    expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  });

  it("offers check again and a time picker for an unknown reset", async () => {
    active = await renderNotice({ resetsAt: null });
    await expect
      .element(page.getByText("Claude didn't say when the limit resets", { exact: true }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Check again", exact: true }).click();
    expect(mocks.refresh).toHaveBeenCalledWith({ threadId, expectedLimitKey: limitKey });
    await page.getByRole("button", { name: "Schedule continue…" }).click();
    await expect.element(page.getByText("Custom", { exact: true })).toBeInTheDocument();
  });

  it("shows the scheduled continue with continue now, change time and don't continue", async () => {
    const scheduled = scheduledSnapshot("queued");
    mocks.list.mockResolvedValue(scheduled);
    mocks.promote.mockResolvedValue(scheduled);
    active = await renderNotice();
    await expect.element(page.getByText(/^Continues automatically at/)).toBeInTheDocument();
    await expect
      .element(page.getByText("Resume the queue so this can send."))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Continue now" }).click();
    expect(mocks.promote).toHaveBeenCalledWith({
      itemId: "resume",
      interruptActive: false,
      expectedRevision: 1,
    });
    await page.getByRole("button", { name: "Change time" }).click();
    await expect.element(page.getByText("Custom", { exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Don't continue" }).click();
    expect(mocks.cancel).toHaveBeenCalledWith({ threadId, itemId: "resume", expectedRevision: 1 });
  });

  it("asks to resume a paused queue before the scheduled continue can send", async () => {
    mocks.list.mockResolvedValue(scheduledSnapshot("queued", true));
    active = await renderNotice();
    await expect.element(page.getByText("Resume the queue so this can send.")).toBeInTheDocument();
  });

  it("shows sending without controls", async () => {
    mocks.list.mockResolvedValue(scheduledSnapshot("dispatching"));
    active = await renderNotice();
    await expect.element(page.getByText("Continuing…", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Continue now" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Usage limit options" }))
      .not.toBeInTheDocument();
  });

  it("shows a failed queued continue without claiming it was sent", async () => {
    mocks.list.mockResolvedValue(scheduledSnapshot("failed"));
    active = await renderNotice();
    await expect
      .element(page.getByText("Continue could not be sent. Review the queued turn."))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Pick time…" })).toBeEnabled();
  });

  it("renders nothing once the continue has been sent", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      usageLimitResume: {
        limitKey,
        resetsAt: limit.resetsAt,
        source: "auto",
        state: "completed",
        itemId: null,
      },
    });
    active = await renderNotice();
    await expect.element(page.getByText(/^Paused:/)).not.toBeInTheDocument();
  });

  it("keeps manual scheduling available after the loop guard gives up", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      usageLimitResume: {
        limitKey,
        resetsAt: limit.resetsAt,
        source: "auto",
        state: "gave_up",
        itemId: null,
      },
    });
    active = await renderNotice();
    await expect
      .element(page.getByText("Automatic continue stopped after repeated limit errors."))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Continue at/ })).toBeEnabled();
  });

  it("returns to manual scheduling after a cancel without extra copy", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      usageLimitResume: {
        limitKey,
        resetsAt: limit.resetsAt,
        source: "auto",
        state: "cancelled",
        itemId: null,
      },
    });
    active = await renderNotice();
    await expect.element(page.getByRole("button", { name: /^Continue at/ })).toBeEnabled();
    await expect.element(page.getByText(/cancelled/i)).not.toBeInTheDocument();
  });

  it("keeps a definitely-unsent rejection on the original-message retry path", async () => {
    active = await renderNotice({ turnId: null, deliveryId: "delivery" });
    await expect.element(page.getByText(/^Paused:/)).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^Continue at/ }))
      .not.toBeInTheDocument();
  });

  it("explains a scheduled continue rejected before starting", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      items: [{ scheduleReason: "usage_limit_reset", status: "failed" }],
    });
    active = await renderNotice({ turnId: null, deliveryId: "delivery" });
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
      active = await renderNotice();
      await expect.element(page.getByRole("button", { name: /^Continue at/ })).toBeEnabled();
      await expect.element(page.getByText(/^Automatic continue stopped/)).not.toBeInTheDocument();
    });
  }

  it("uses a fresh default when the picker opens after an hour", async () => {
    active = await renderNotice();
    const now = Date.now() + 7_200_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await page.getByRole("button", { name: "Pick time…" }).click();
      await page.getByRole("button", { name: "Schedule continue", exact: true }).click();
      expect(mocks.schedule).toHaveBeenCalledWith({
        threadId,
        expectedLimitKey: limitKey,
        notBefore: new Date(now + 3_600_000).toISOString(),
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("surfaces a stale failure as a toast", async () => {
    mocks.schedule.mockRejectedValue(new Error("This usage limit has changed."));
    active = await renderNotice();
    await page.getByRole("button", { name: /^Continue at/ }).click();
    await expect.poll(() => mocks.toast.mock.calls.length).toBe(1);
  });
});
