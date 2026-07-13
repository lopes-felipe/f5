import "../../index.css";

import { CommandId, ThreadId, type ModelSlug } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { NextTurnQueuePanel } from "./NextTurnQueuePanel";

vi.mock("~/nativeApi", () => ({ readNativeApi: () => null }));

let active: Awaited<ReturnType<typeof render>> | undefined;

afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

describe("NextTurnQueuePanel", () => {
  it("shows an enqueueing turn immediately before the server snapshot arrives", async () => {
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
});
