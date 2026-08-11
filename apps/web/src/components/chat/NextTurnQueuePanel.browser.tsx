import "../../index.css";

import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

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

  it("can run the queue head now while keeping move-to-top disabled for only the head", async () => {
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
    const promote = vi.fn(async () => snapshot);
    const reorder = vi.fn(async () => snapshot);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    nativeApiMock.current = { nextTurnQueue: { promote, reorder } };
    useNextTurnQueueStore.getState().applySnapshot(snapshot);
    active = await render(<NextTurnQueuePanel threadId={threadId} />);

    const runNowButtons = page.getByRole("button", { name: "Run queued turn now" });
    const moveToTopButtons = page.getByRole("button", { name: "Move queued turn to top" });
    await expect.element(runNowButtons.nth(0)).toBeEnabled();
    await expect.element(runNowButtons.nth(1)).toBeEnabled();
    await expect.element(moveToTopButtons.nth(0)).toBeDisabled();
    await expect.element(moveToTopButtons.nth(1)).toBeEnabled();

    await runNowButtons.nth(0).click();
    expect(promote).toHaveBeenCalledWith({
      itemId: firstItemId,
      interruptActive: true,
      expectedRevision: snapshot.revision,
    });

    await moveToTopButtons.nth(1).click();
    expect(reorder).toHaveBeenCalledWith({
      threadId,
      orderedItemIds: [secondItemId, firstItemId],
      expectedRevision: snapshot.revision,
    });
  });
});
