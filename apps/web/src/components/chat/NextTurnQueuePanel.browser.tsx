import "../../index.css";

import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSlug,
  type NextTurnQueueSnapshot,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { NextTurnQueuePanel } from "./NextTurnQueuePanel";

const nativeApiMocks = vi.hoisted(() => ({ readNativeApi: vi.fn() }));

vi.mock("~/nativeApi", () => ({ readNativeApi: nativeApiMocks.readNativeApi }));

let active: Awaited<ReturnType<typeof render>> | undefined;

afterEach(async () => {
  await active?.unmount();
  active = undefined;
  nativeApiMocks.readNativeApi.mockReset();
});

function queueSnapshot(threadId: ThreadId): NextTurnQueueSnapshot {
  const createdAt = "2026-07-13T10:00:00.000Z";
  return {
    threadId,
    version: 7,
    blocker: null,
    items: [
      {
        itemId: CommandId.makeUnsafe("queue-item"),
        threadId,
        position: 0,
        status: "queued",
        failurePolicy: "stop",
        revision: 3,
        envelopeVersion: 1,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("queue-command"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("queue-message"),
            role: "user",
            text: "",
            attachments: [
              {
                type: "image",
                id: "queue-thread-00000000-0000-0000-0000-000000000001",
                name: "diagram.png",
                mimeType: "image/png",
                sizeBytes: 128,
              },
            ],
          },
          provider: "codex",
          model: "gpt-5.6-sol",
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        },
        blocker: null,
        dispatchStartedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
    ],
  };
}

describe("NextTurnQueuePanel", () => {
  it("shows an enqueueing turn immediately before the server snapshot arrives", async () => {
    nativeApiMocks.readNativeApi.mockReturnValue(null);
    const threadId = ThreadId.makeUnsafe("queue-thread");
    active = await render(
      <NextTurnQueuePanel
        threadId={threadId}
        optimisticItem={{
          itemId: CommandId.makeUnsafe("queue-item"),
          threadId,
          text: "Run the queued follow-up",
          model: "gpt-5.6-sol" as ModelSlug,
          interactionMode: "default",
          runtimeMode: "full-access",
        }}
      />,
    );

    await expect.element(page.getByText("Run the queued follow-up")).toBeInTheDocument();
    await expect.element(page.getByText(/Adding to queue/)).toBeInTheDocument();
    await expect.element(page.getByText("(1)")).toBeInTheDocument();
  });

  it("renders attachment-only items and sends versioned full-editor updates", async () => {
    const threadId = ThreadId.makeUnsafe("queue-thread");
    const initial = queueSnapshot(threadId);
    const update = vi.fn().mockResolvedValue({ ...initial, version: 8 });
    nativeApiMocks.readNativeApi.mockReturnValue({
      nextTurnQueue: {
        list: vi.fn().mockResolvedValue(initial),
        onUpdated: vi.fn(() => () => undefined),
        update,
      },
    });

    active = await render(<NextTurnQueuePanel threadId={threadId} snapshotHint={initial} />);

    await expect.element(page.getByText("Image attachment")).toBeInTheDocument();
    await expect.element(page.getByText(/1 attachment/)).toBeInTheDocument();
    await page.getByRole("button", { name: "Edit queued turn" }).click();
    await expect.element(page.getByRole("button", { name: "Remove diagram.png" })).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();

    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId,
          expectedVersion: 7,
          expectedRevision: 3,
          attachments: initial.items[0]?.command.message.attachments,
          failurePolicy: "stop",
        }),
      ),
    );
  });

  it("continues explicitly after a resumable provider failure", async () => {
    const threadId = ThreadId.makeUnsafe("queue-thread");
    const initial = queueSnapshot(threadId);
    const blocker = {
      code: "provider_error" as const,
      message: "Provider rejected the turn.",
      resumable: true,
    };
    const blocked: NextTurnQueueSnapshot = {
      ...initial,
      blocker,
      items: initial.items.map((item) => ({ ...item, status: "paused" as const, blocker })),
    };
    const resume = vi.fn().mockResolvedValue({ ...blocked, version: 8 });
    nativeApiMocks.readNativeApi.mockReturnValue({
      nextTurnQueue: {
        list: vi.fn().mockResolvedValue(blocked),
        onUpdated: vi.fn(() => () => undefined),
        resume,
      },
    });

    active = await render(<NextTurnQueuePanel threadId={threadId} snapshotHint={blocked} />);
    await page.getByRole("button", { name: "Continue queue anyway" }).click();

    await vi.waitFor(() =>
      expect(resume).toHaveBeenCalledWith({
        itemId: blocked.items[0]?.itemId,
        threadId,
        expectedVersion: 7,
        failurePolicy: "continue",
      }),
    );
  });
});
