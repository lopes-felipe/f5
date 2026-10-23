import {
  CommandId,
  ThreadId,
  type NextTurnQueueItem,
  type NextTurnQueueSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { describeBackgroundWorkChip } from "../NativeRuntimeTray.logic";
import { makeWorktreeSetupSnapshot } from "../worktreeSetupFixtures";
import {
  isWorktreeSetupChip,
  summarizeQueueChip,
  summarizeTaskChip,
  truncateChipText,
} from "./ComposerStatusStrip.logic";

const queueItem = (id: string, text: string, overrides: Partial<NextTurnQueueItem> = {}) =>
  ({
    itemId: CommandId.makeUnsafe(id),
    status: "queued",
    command: {
      commandId: CommandId.makeUnsafe(`cmd-${id}`),
      message: { text, attachments: [] },
    },
    ...overrides,
  }) as unknown as NextTurnQueueItem;

const queueSnapshot = (overrides: Partial<NextTurnQueueSnapshot> = {}): NextTurnQueueSnapshot => ({
  threadId: ThreadId.makeUnsafe("queue-thread"),
  items: [queueItem("a", "great, now open the PR")],
  revision: 1,
  paused: false,
  blockedKind: "waiting",
  reasonCode: "active_turn",
  reasonDetail: null,
  maxItems: 20,
  quarantinedCount: 0,
  unresolvedDelivery: null,
  ...overrides,
});

const summarize = (
  snapshot: NextTurnQueueSnapshot | null,
  extra: Partial<Parameters<typeof summarizeQueueChip>[0]> = {},
) =>
  summarizeQueueChip({ snapshot, optimistic: [], syncError: null, foldedItemId: null, ...extra });

describe("summarizeQueueChip", () => {
  it("counts queued turns and previews the next one", () => {
    expect(summarize(queueSnapshot())).toEqual({
      count: 1,
      preview: "great, now open the PR",
      paused: false,
      warning: false,
    });
  });

  it("truncates a long preview", () => {
    const preview = summarize(
      queueSnapshot({ items: [queueItem("a", "Refactor the whole composer dock and its tray")] }),
    )?.preview;
    expect(preview).toBe("Refactor the whole composer doc…");
    expect(preview).toHaveLength(32);
  });

  it("counts turns the server has not confirmed yet", () => {
    expect(
      summarize(queueSnapshot({ items: [] }), { optimistic: [{ text: "ship it" }] }),
    ).toMatchObject({ count: 1, preview: "ship it" });
  });

  it("marks a paused queue as a warning", () => {
    expect(
      summarize(queueSnapshot({ paused: true, blockedKind: "paused", reasonCode: "manual_pause" })),
    ).toMatchObject({ paused: true, warning: true });
  });

  it("has no chip when nothing is queued", () => {
    expect(summarize(null)).toBeNull();
    expect(summarize(queueSnapshot({ items: [] }))).toBeNull();
  });

  it("leaves a queue that needs the user inline", () => {
    expect(
      summarize(
        queueSnapshot({
          unresolvedDelivery: { deliveryId: CommandId.makeUnsafe("d"), state: "ambiguous" },
        }),
      ),
    ).toBeNull();
    expect(summarize(queueSnapshot({ reasonCode: "delivery_rejected" }))).toBeNull();
    expect(summarize(queueSnapshot({ quarantinedCount: 1 }))).toBeNull();
    expect(summarize(queueSnapshot({ blockedKind: "error" }))).toBeNull();
    expect(summarize(queueSnapshot(), { syncError: "offline" })).toBeNull();
  });

  it("leaves a queue the server paused inline", () => {
    for (const reasonCode of ["turn_interrupted", "thread_reverted", "thread_compacted"] as const) {
      expect(
        summarize(queueSnapshot({ paused: true, blockedKind: "paused", reasonCode })),
      ).toBeNull();
    }
  });

  it("skips the continue the usage-limit card already shows", () => {
    const folded = queueItem("folded", "continue", { scheduleReason: "usage_limit_reset" });
    expect(
      summarize(queueSnapshot({ items: [folded] }), { foldedItemId: folded.itemId }),
    ).toBeNull();
  });
});

describe("summarizeTaskChip", () => {
  it("counts completed tasks against the total", () => {
    expect(
      summarizeTaskChip([
        { status: "completed" },
        { status: "in_progress" },
        { status: "pending" },
      ]),
    ).toEqual({ done: 1, total: 3 });
  });
});

describe("describeBackgroundWorkChip", () => {
  it("counts by kind, most first, with the oldest task's elapsed time", () => {
    expect(
      describeBackgroundWorkChip([
        { kind: "shell", kindLabel: "Shell", elapsed: "5m" },
        { kind: "agent", kindLabel: "Agent", elapsed: "2m" },
        { kind: "agent", kindLabel: "Agent", elapsed: "1m" },
      ]),
    ).toEqual({ counts: "2 agents · 1 shell", elapsed: "5m" });
  });

  it("names a single shell", () => {
    expect(
      describeBackgroundWorkChip([{ kind: "shell", kindLabel: "Shell", elapsed: null }]),
    ).toEqual({ counts: "1 shell", elapsed: null });
  });
});

describe("isWorktreeSetupChip", () => {
  const stages = makeWorktreeSetupSnapshot().stages;
  const withStatus = (status: "warning" | "failed") =>
    stages.map((stage, index) =>
      index === 0 ? { ...stage, status } : { ...stage, status: "done" as const },
    );

  it("folds a setup that finished with only warnings", () => {
    expect(
      isWorktreeSetupChip(
        makeWorktreeSetupSnapshot({ phase: "done", stages: withStatus("warning") }),
      ),
    ).toBe(true);
  });

  it("keeps running, failed and cancelled setups inline", () => {
    expect(isWorktreeSetupChip(makeWorktreeSetupSnapshot({ phase: "running" }))).toBe(false);
    expect(
      isWorktreeSetupChip(
        makeWorktreeSetupSnapshot({ phase: "done", stages: withStatus("failed") }),
      ),
    ).toBe(false);
    expect(isWorktreeSetupChip(makeWorktreeSetupSnapshot({ phase: "failed", error: "boom" }))).toBe(
      false,
    );
    expect(isWorktreeSetupChip(makeWorktreeSetupSnapshot({ phase: "cancelled" }))).toBe(false);
  });
});

describe("truncateChipText", () => {
  it("collapses whitespace before truncating", () => {
    expect(truncateChipText("  one\n two  ", 32)).toBe("one two");
  });
});
