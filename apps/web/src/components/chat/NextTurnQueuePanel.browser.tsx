import "../../index.css";

import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ComposerTray } from "./composer/ComposerTray";
import { NextTurnQueuePanel } from "./NextTurnQueuePanel";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";

const nativeApiMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => nativeApiMock.current }));

let active: Awaited<ReturnType<typeof render>> | undefined;

afterEach(async () => {
  await active?.unmount();
  active = undefined;
  nativeApiMock.current = null;
  useNextTurnQueueStore.setState({ byThreadId: {}, summary: { threads: [] } });
  vi.restoreAllMocks();
});

describe("NextTurnQueuePanel", () => {
  it("shows a queued turn from the durable snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("queue-thread");
    const itemId = CommandId.makeUnsafe("queue-item");
    useNextTurnQueueStore.getState().applySnapshot({
      threadId,
      revision: 1,
      paused: false,
      blockedKind: null,
      reasonCode: null,
      reasonDetail: null,
      maxItems: 20,
      quarantinedCount: 0,
      items: [
        {
          itemId,
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
              text: "Run the queued follow-up",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-08-07T12:00:00.000Z",
          },
          attemptCount: 0,
          notBefore: null,
          dispatchStartedAt: null,
          lastErrorCode: null,
          lastErrorDetail: null,
          createdAt: "2026-08-07T12:00:00.000Z",
          updatedAt: "2026-08-07T12:00:00.000Z",
        },
      ],
    });
    active = await render(<NextTurnQueuePanel threadId={threadId} />);

    await expect.element(page.getByText("Run the queued follow-up")).toBeInTheDocument();
    await expect.element(page.getByText("Up next")).toBeInTheDocument();
    await expect.element(page.getByText("Next turns (1)")).toBeInTheDocument();
  });

  it("folds the usage-limit auto-continue into the card and shows it again when unfolded", async () => {
    const threadId = ThreadId.makeUnsafe("queue-thread-usage-limit");
    useNextTurnQueueStore.getState().applySnapshot({
      threadId,
      revision: 1,
      paused: false,
      blockedKind: "waiting",
      reasonCode: "usage_limit_reset",
      reasonDetail: null,
      maxItems: 20,
      quarantinedCount: 0,
      items: [
        {
          itemId: CommandId.makeUnsafe("usage-resume"),
          threadId,
          submissionId: CommandId.makeUnsafe("usage-submission"),
          position: 0,
          status: "queued",
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("usage-command"),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe("usage-message"),
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
          notBefore: "2099-10-08T12:01:00.000Z",
          scheduleReason: "usage_limit_reset",
          dispatchStartedAt: null,
          lastErrorCode: null,
          lastErrorDetail: null,
          createdAt: "2026-10-08T12:00:00.000Z",
          updatedAt: "2026-10-08T12:00:00.000Z",
        },
      ],
    });
    active = await render(
      <NextTurnQueuePanel
        threadId={threadId}
        foldedItemId={CommandId.makeUnsafe("usage-resume")}
      />,
    );
    await expect.element(page.getByLabelText("Queued turns")).not.toBeInTheDocument();

    await active.rerender(<NextTurnQueuePanel threadId={threadId} foldedItemId={null} />);
    await expect.element(page.getByText("Next turns (1)")).toBeInTheDocument();
    await expect.element(page.getByText(/^Continues after usage limit resets/)).toBeInTheDocument();
  });

  it("keeps a folded usage-limit continue in place on move to top and clear", async () => {
    const threadId = ThreadId.makeUnsafe("queue-thread-usage-limit-clear");
    const item = (id: string, text: string, scheduleReason?: "usage_limit_reset") => ({
      itemId: CommandId.makeUnsafe(id),
      threadId,
      submissionId: CommandId.makeUnsafe(`${id}-submission`),
      position: 0,
      status: "queued" as const,
      command: {
        type: "thread.turn.start" as const,
        commandId: CommandId.makeUnsafe(`${id}-command`),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(`${id}-message`),
          role: "user" as const,
          text,
          attachments: [],
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: "2026-10-08T12:00:00.000Z",
      },
      attemptCount: 0,
      notBefore: scheduleReason ? "2099-10-08T12:01:00.000Z" : null,
      ...(scheduleReason ? { scheduleReason } : {}),
      dispatchStartedAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    const snapshot = {
      threadId,
      revision: 3,
      paused: false,
      blockedKind: null,
      reasonCode: null,
      reasonDetail: null,
      maxItems: 20,
      quarantinedCount: 0,
      items: [
        item("usage-resume", "continue", "usage_limit_reset"),
        item("follow-up", "Run the follow-up"),
        item("second", "Run the second turn"),
      ],
    };
    const clear = vi.fn().mockResolvedValue({ snapshot, removed: [] });
    const reorder = vi.fn().mockResolvedValue(snapshot);
    nativeApiMock.current = { nextTurnQueue: { clear, reorder } };
    useNextTurnQueueStore.getState().applySnapshot(snapshot);
    active = await render(
      <NextTurnQueuePanel
        threadId={threadId}
        foldedItemId={CommandId.makeUnsafe("usage-resume")}
      />,
    );

    await expect.element(page.getByText("Next turns (2)")).toBeInTheDocument();
    await page.getByRole("button", { name: "Move queued turn to top" }).nth(1).click();
    expect(reorder).toHaveBeenCalledWith({
      threadId,
      orderedItemIds: ["usage-resume", "second", "follow-up"],
      expectedRevision: 3,
    });

    await page.getByRole("button", { name: "Clear", exact: true }).click();
    expect(clear).toHaveBeenCalledWith({
      threadId,
      scope: "all",
      expectedRevision: 3,
      keepItemIds: ["usage-resume"],
    });
  });

  it("keeps the composer on screen with a full 20-item queue in the tray", async () => {
    const threadId = ThreadId.makeUnsafe("queue-thread-full");
    useNextTurnQueueStore.getState().applySnapshot({
      threadId,
      revision: 1,
      paused: false,
      blockedKind: null,
      reasonCode: null,
      reasonDetail: null,
      maxItems: 20,
      quarantinedCount: 0,
      items: Array.from({ length: 20 }, (_, index) => ({
        itemId: CommandId.makeUnsafe(`queue-item-${index}`),
        threadId,
        submissionId: CommandId.makeUnsafe(`submission-${index}`),
        position: index,
        status: "queued" as const,
        command: {
          type: "thread.turn.start" as const,
          commandId: CommandId.makeUnsafe(`command-${index}`),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe(`message-${index}`),
            role: "user" as const,
            text: `Queued follow-up number ${index + 1}`,
            attachments: [],
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdAt: "2026-08-07T12:00:00.000Z",
        },
        attemptCount: 0,
        notBefore: null,
        dispatchStartedAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        createdAt: "2026-08-07T12:00:00.000Z",
        updatedAt: "2026-08-07T12:00:00.000Z",
      })),
    });
    active = await render(
      <div style={{ height: 700, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0 }} />
        <ComposerTray>
          <NextTurnQueuePanel variant="tray" threadId={threadId} />
        </ComposerTray>
        <div data-testid="composer-stub" style={{ height: 140, flexShrink: 0 }} />
      </div>,
    );

    await expect.element(page.getByText("Next turns (20)")).toBeInTheDocument();
    const stub = document.querySelector<HTMLElement>('[data-testid="composer-stub"]')!;
    const container = stub.parentElement!;
    expect(stub.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      container.getBoundingClientRect().bottom + 1,
    );
    expect(
      document.querySelector<HTMLElement>('[data-slot="composer-tray"]')!.getBoundingClientRect()
        .height,
    ).toBeLessThan(700 - 140);
  });

  it("requires explicit recovery for an ambiguous provider delivery", async () => {
    const threadId = ThreadId.makeUnsafe("ambiguous-queue-thread");
    const itemId = CommandId.makeUnsafe("ambiguous-queue-item");
    const snapshot = {
      threadId,
      revision: 3,
      paused: true,
      blockedKind: "error" as const,
      reasonCode: "delivery_ambiguous" as const,
      reasonDetail: "The provider delivery outcome is unknown.",
      maxItems: 20,
      quarantinedCount: 0,
      unresolvedDelivery: {
        deliveryId: CommandId.makeUnsafe("ambiguous-command"),
        state: "ambiguous" as const,
      },
      items: [
        {
          itemId,
          threadId,
          submissionId: CommandId.makeUnsafe("ambiguous-submission"),
          position: 0,
          status: "failed" as const,
          command: {
            type: "thread.turn.start" as const,
            commandId: CommandId.makeUnsafe("ambiguous-command"),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe("ambiguous-message"),
              role: "user" as const,
              text: "Possibly delivered",
              attachments: [],
            },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            createdAt: "2026-08-07T12:00:00.000Z",
          },
          attemptCount: 1,
          notBefore: null,
          dispatchStartedAt: "2026-08-07T12:00:01.000Z",
          lastErrorCode: "delivery_ambiguous",
          lastErrorDetail: "The provider delivery outcome is unknown.",
          createdAt: "2026-08-07T12:00:00.000Z",
          updatedAt: "2026-08-07T12:00:02.000Z",
        },
      ],
    };
    const recheckDelivery = vi.fn(async () => snapshot);
    nativeApiMock.current = { nextTurnQueue: { recheckDelivery } };
    useNextTurnQueueStore.getState().applySnapshot(snapshot);
    active = await render(<NextTurnQueuePanel threadId={threadId} />);

    await expect.element(page.getByRole("button", { name: "Resume queue" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Recheck" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Retry", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Recheck" }).click();
    expect(recheckDelivery).toHaveBeenCalledWith({ threadId });
  });

  it("keeps resume available when a delivery pause has nothing left to recover", async () => {
    const threadId = ThreadId.makeUnsafe("stale-delivery-pause-thread");
    const snapshot = {
      threadId,
      revision: 5,
      paused: true,
      blockedKind: "error" as const,
      reasonCode: "delivery_ambiguous" as const,
      reasonDetail: "The provider delivery outcome is unknown.",
      maxItems: 20,
      quarantinedCount: 0,
      unresolvedDelivery: null,
      items: [],
    };
    const recheckDelivery = vi.fn(async () => ({
      ...snapshot,
      revision: 6,
      paused: false,
      blockedKind: null,
      reasonCode: null,
      reasonDetail: null,
    }));
    nativeApiMock.current = { nextTurnQueue: { recheckDelivery } };
    useNextTurnQueueStore.getState().applySnapshot(snapshot);
    active = await render(<NextTurnQueuePanel threadId={threadId} />);

    await expect.element(page.getByRole("button", { name: "Resume queue" })).toBeEnabled();
    await expect.element(page.getByRole("button", { name: "Recheck" })).toBeInTheDocument();
    expect(page.getByRole("button", { name: "Retry", exact: true }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Discard" }).elements()).toHaveLength(0);
    await page.getByRole("button", { name: "Recheck" }).click();
    expect(recheckDelivery).toHaveBeenCalledWith({ threadId });
  });

  it("hides run now during an active turn and allows it when the queue is paused and idle", async () => {
    const threadId = ThreadId.makeUnsafe("run-now-queue-thread");
    const firstItemId = CommandId.makeUnsafe("run-now-first-item");
    const secondItemId = CommandId.makeUnsafe("run-now-second-item");
    const makeItem = (itemId: CommandId, position: number, text: string) => ({
      itemId,
      threadId,
      submissionId: CommandId.makeUnsafe(`submission-${position}`),
      position,
      status: "queued" as const,
      command: {
        type: "thread.turn.start" as const,
        commandId: CommandId.makeUnsafe(`command-${position}`),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(`message-${position}`),
          role: "user" as const,
          text,
          attachments: [],
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: "2026-08-07T12:00:00.000Z",
      },
      attemptCount: 0,
      notBefore: null,
      dispatchStartedAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    });
    const snapshot = {
      threadId,
      revision: 4,
      paused: false,
      blockedKind: "waiting" as const,
      reasonCode: "active_turn" as const,
      reasonDetail: null,
      maxItems: 20,
      quarantinedCount: 0,
      items: [makeItem(firstItemId, 0, "First"), makeItem(secondItemId, 1, "Second")],
    };
    const promote = vi.fn(async () => idleSnapshot);
    const reorder = vi.fn(async () => snapshot);
    nativeApiMock.current = { nextTurnQueue: { promote, reorder } };
    useNextTurnQueueStore.getState().applySnapshot(snapshot);
    active = await render(<NextTurnQueuePanel threadId={threadId} />);

    const runNowButtons = page.getByRole("button", { name: "Run queued turn now" });
    const moveToTopButtons = page.getByRole("button", { name: "Move queued turn to top" });
    await expect.element(runNowButtons).not.toBeInTheDocument();
    expect(promote).not.toHaveBeenCalled();

    const idleSnapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      paused: true,
      blockedKind: "paused" as const,
      reasonCode: "manual_pause" as const,
    };
    useNextTurnQueueStore.getState().applySnapshot(idleSnapshot);

    await expect.element(runNowButtons.nth(0)).toBeEnabled();
    await expect.element(runNowButtons.nth(1)).toBeEnabled();
    await expect.element(moveToTopButtons.nth(0)).toBeDisabled();
    await expect.element(moveToTopButtons.nth(1)).toBeEnabled();

    await runNowButtons.nth(0).click();
    expect(promote).toHaveBeenCalledWith({
      itemId: firstItemId,
      interruptActive: false,
      expectedRevision: idleSnapshot.revision,
    });

    await moveToTopButtons.nth(1).click();
    expect(reorder).toHaveBeenCalledWith({
      threadId,
      orderedItemIds: [secondItemId, firstItemId],
      expectedRevision: idleSnapshot.revision,
    });
  });
});
