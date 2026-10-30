import {
  CommandId,
  ThreadId,
  type NextTurnQueueItem,
  type NextTurnQueueSnapshot,
} from "@t3tools/contracts";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerSendText";
import { describe, expect, it } from "vitest";

import {
  buildQueueRowDisplay,
  describeQueueBlockedState,
  isFoldedUsageLimitItem,
  mergeVisibleOrder,
  rebuildEditedText,
} from "./NextTurnQueuePanel.logic";

describe("isFoldedUsageLimitItem", () => {
  const folded = CommandId.makeUnsafe("folded");
  const item = (
    scheduleReason: NextTurnQueueItem["scheduleReason"],
    status: NextTurnQueueItem["status"],
    itemId = folded,
  ) => ({ itemId, scheduleReason, status }) as NextTurnQueueItem;

  it("folds only the pending continue the card shows", () => {
    expect(isFoldedUsageLimitItem(item("usage_limit_reset", "queued"), folded)).toBe(true);
    expect(isFoldedUsageLimitItem(item("usage_limit_reset", "dispatching"), folded)).toBe(true);
    expect(isFoldedUsageLimitItem(item("usage_limit_reset", "queued"), null)).toBe(false);
    expect(
      isFoldedUsageLimitItem(
        item("usage_limit_reset", "queued", CommandId.makeUnsafe("leftover")),
        folded,
      ),
    ).toBe(false);
  });

  it("keeps failed continues and ordinary turns visible", () => {
    expect(isFoldedUsageLimitItem(item("usage_limit_reset", "failed"), folded)).toBe(false);
    expect(isFoldedUsageLimitItem(item(undefined, "queued"), folded)).toBe(false);
  });
});

describe("mergeVisibleOrder", () => {
  const [a, b, c, hidden] = ["a", "b", "c", "hidden"].map((id) => CommandId.makeUnsafe(id)) as [
    CommandId,
    CommandId,
    CommandId,
    CommandId,
  ];
  const hiddenIds = new Set([hidden]);

  it.each([
    ["front", [hidden, a, b, c], [hidden, c, a, b]],
    ["middle", [a, hidden, b, c], [c, hidden, a, b]],
    ["end", [a, b, c, hidden], [c, a, b, hidden]],
  ] as const)("keeps a hidden item at the %s", (_position, fullOrder, expected) => {
    expect(mergeVisibleOrder(fullOrder, hiddenIds, [c, a, b])).toEqual(expected);
  });
});

describe("describeQueueBlockedState", () => {
  it.each([
    ["usage_limit_reset", "Waiting for the usage limit to reset."],
    ["usage_limit_context_changed", "Provider changed since the limit; review before continuing."],
  ] as const)("describes %s", (reasonCode, message) => {
    expect(
      describeQueueBlockedState({
        threadId: ThreadId.makeUnsafe("limited"),
        items: [],
        revision: 1,
        paused: false,
        blockedKind: "waiting",
        reasonCode,
        reasonDetail: null,
        maxItems: 20,
        quarantinedCount: 0,
      }),
    ).toBe(message);
  });

  it("directs previously paused queues to Resume without promising delivery recovery", () => {
    const snapshot: NextTurnQueueSnapshot = {
      threadId: ThreadId.makeUnsafe("previously-paused"),
      items: [],
      revision: 1,
      paused: true,
      blockedKind: "error",
      reasonCode: "turn_never_started",
      reasonDetail: null,
      maxItems: 10,
      quarantinedCount: 0,
    };
    expect(describeQueueBlockedState(snapshot)).toBe(
      "Resume to recheck the previous message. If the queue pauses again, its delivery is still unconfirmed.",
    );
  });

  it("points a workspace pause at the banner instead of repeating its details", () => {
    const snapshot: NextTurnQueueSnapshot = {
      threadId: ThreadId.makeUnsafe("drifted"),
      items: [],
      revision: 1,
      paused: true,
      blockedKind: "error",
      reasonCode: "worktree_missing",
      reasonDetail: "The recorded worktree does not match this repository and branch.",
      maxItems: 10,
      quarantinedCount: 0,
    };
    expect(describeQueueBlockedState(snapshot, { workspaceBannerShown: true })).toBe(
      "Queue paused: workspace needs attention (see above).",
    );
    // Without a recorded worktree no banner renders, so keep the server's detail.
    expect(describeQueueBlockedState(snapshot)).toBe(snapshot.reasonDetail);
  });
});

describe("buildQueueRowDisplay", () => {
  const item = (commandId: string, text: string) =>
    ({
      command: {
        commandId: CommandId.makeUnsafe(commandId),
        message: { text, attachments: [] },
      },
    }) as unknown as NextTurnQueueItem;

  it("renders message-mode answers instead of their JSON payload", () => {
    expect(
      buildQueueRowDisplay(
        item("answer-delivery:1", JSON.stringify({ 0: { answers: ["Connected successfully"] } })),
      ).label,
    ).toBe("Answer · Connected successfully");
  });

  it("keeps the raw text for malformed answers and ordinary turns", () => {
    expect(buildQueueRowDisplay(item("answer-delivery:2", "not json")).label).toBe("not json");
    const ordinary = JSON.stringify({ 0: { answers: ["x"] } });
    expect(buildQueueRowDisplay(item("plain", ordinary)).label).toBe(ordinary);
  });

  it("labels an image-only turn instead of showing its hidden prompt", () => {
    const display = buildQueueRowDisplay(imageOnlyItem());
    expect(display.label).toBe("Image-only turn");
    expect(display.visibleText).toBe("");
    expect(display.copyText).toBe("");
  });
});

const imageOnlyItem = (text = IMAGE_ONLY_BOOTSTRAP_PROMPT) =>
  ({
    command: {
      commandId: CommandId.makeUnsafe("image-only"),
      message: {
        text,
        attachments: [{ type: "image", id: "image-1", name: "shot.png" }],
      },
    },
  }) as unknown as NextTurnQueueItem;

describe("rebuildEditedText", () => {
  it("keeps the hidden prompt when an image-only turn is saved without words", () => {
    expect(rebuildEditedText(imageOnlyItem(), "")).toBe(IMAGE_ONLY_BOOTSTRAP_PROMPT);
    expect(rebuildEditedText(imageOnlyItem(), "  ")).toBe(IMAGE_ONLY_BOOTSTRAP_PROMPT);
  });

  it("replaces the hidden prompt with words added while editing", () => {
    expect(rebuildEditedText(imageOnlyItem(), " What is this? ")).toBe("What is this?");
  });

  it("keeps send-time context after edited words", () => {
    const text = "Fix it\n\n<attached_files>\n- /repo/a.ts\n</attached_files>";
    expect(rebuildEditedText(imageOnlyItem(text), "Fix this")).toBe(
      "Fix this\n\n<attached_files>\n- /repo/a.ts\n</attached_files>",
    );
  });
});
