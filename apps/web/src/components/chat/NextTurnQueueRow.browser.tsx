import "../../index.css";
import {
  CommandId,
  MessageId,
  ThreadId,
  type NextTurnQueueItem,
  type NextTurnQueueSnapshot,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { NextTurnQueueRow } from "./NextTurnQueueRow";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
    attributes: {},
    listeners: {},
  }),
}));
const threadId = ThreadId.makeUnsafe("scheduled-row");
function item(overrides: Partial<NextTurnQueueItem> = {}): NextTurnQueueItem {
  return {
    itemId: CommandId.makeUnsafe("recovery"),
    threadId,
    submissionId: CommandId.makeUnsafe("recovery-submission"),
    position: 0,
    status: "queued",
    command: {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("recovery-command"),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe("recovery-message"),
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
    notBefore: new Date(Date.now() + 172_800_000).toISOString(),
    scheduleReason: "usage_limit_reset",
    dispatchStartedAt: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T12:00:00.000Z",
    ...overrides,
  };
}
const snapshot: NextTurnQueueSnapshot = {
  threadId,
  items: [],
  revision: 1,
  paused: false,
  blockedKind: null,
  reasonCode: "usage_limit_reset",
  reasonDetail: null,
  maxItems: 20,
  quarantinedCount: 0,
};
const props = {
  index: 0,
  snapshot,
  busy: false,
  onMove: () => {},
  onUpdate: async () => {},
  onCancel: async () => {},
  onRetry: async () => {},
  onDuplicate: async () => {},
  onMoveToTop: async () => {},
  onRunNow: async () => {},
  canRunNow: true,
};
let active: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  vi.restoreAllMocks();
});
describe("NextTurnQueueRow usage limit timing", () => {
  it("uses an absolute date and one deadline timer instead of an interval", async () => {
    const interval = vi.spyOn(window, "setInterval");
    const timeout = vi.spyOn(window, "setTimeout");
    active = await render(<NextTurnQueueRow {...props} item={item()} />);
    await expect.element(page.getByText(/^Continues after usage limit resets/)).toBeInTheDocument();
    expect(interval).not.toHaveBeenCalled();
    expect(timeout.mock.calls.some((call) => call[1] === 86_400_000)).toBe(true);
    await expect.element(page.getByRole("button", { name: "Cancel queued turn" })).toBeEnabled();
  });
  it("keeps the second-by-second countdown for a delivery retry", async () => {
    const interval = vi.spyOn(window, "setInterval");
    active = await render(
      <NextTurnQueueRow
        {...props}
        item={item({ attemptCount: 1, notBefore: new Date(Date.now() + 60_000).toISOString() })}
      />,
    );
    await expect.element(page.getByText(/^Retrying in/)).toBeInTheDocument();
    expect(interval.mock.calls.some((call) => call[1] === 1_000)).toBe(true);
  });
  it("stops the retry interval when its deadline passes", async () => {
    const interval = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");
    const deadline = Date.now() + 60_000;
    active = await render(
      <NextTurnQueueRow
        {...props}
        item={item({ attemptCount: 1, notBefore: new Date(deadline).toISOString() })}
      />,
    );
    const timerIndex = interval.mock.calls.findIndex((call) => call[1] === 1_000);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    vi.spyOn(Date, "now").mockReturnValue(deadline);
    (interval.mock.calls[timerIndex]![0] as () => void)();
    expect(clear).toHaveBeenCalledWith(interval.mock.results[timerIndex]!.value);
    await expect.element(page.getByText(/^Up next/)).toBeInTheDocument();
  });
});
