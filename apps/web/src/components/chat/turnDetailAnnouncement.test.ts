import { describe, expect, it } from "vitest";
import { MessageId, TurnId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";
import { nextTurnDetailAnnouncement, turnDetail, type TurnDetail } from "./turnDetailAnnouncement";

const turnId = TurnId.make("turn");
const message = (id: string, streaming = false): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: "2026-11-17T00:00:00Z",
  message: {
    id: MessageId.make(id),
    turnId,
    role: "assistant",
    text: "**Ready**",
    streaming,
    createdAt: "2026-11-17T00:00:00Z",
  },
});
const work = (id: string, thinking = false): TimelineEntry => ({
  id,
  kind: "work",
  createdAt: "2026-11-17T00:00:01Z",
  entry: {
    id,
    turnId,
    createdAt: "2026-11-17T00:00:01Z",
    tone: thinking ? "thinking" : "tool",
    label: thinking ? "Private reasoning" : "Reading source",
    status: "inProgress",
  },
});
const empty: TurnDetail = { entryIds: ["user"], tailId: "user", messages: [], activity: null };

describe("turn detail announcements", () => {
  it("does not announce an older tool after the newest tool failed", () => {
    const failed = work("failed");
    if (failed.kind === "work") failed.entry.status = "failed";
    expect(turnDetail([work("previous"), failed], turnId).activity).toBeNull();
    expect(turnDetail([work("previous"), message("answer", true)], turnId).activity).toBeNull();
  });
  it("speaks settled intermediate messages once, never streaming tokens or the closing reply", () => {
    let previous = nextTurnDetailAnnouncement(
      null,
      turnDetail([message("a", true)], turnId),
      "messages",
      true,
    ).memory;
    let next = nextTurnDetailAnnouncement(
      previous,
      turnDetail([message("a")], turnId),
      "messages",
      true,
    );
    expect(next.messages).toEqual([]);
    previous = next.memory;
    next = nextTurnDetailAnnouncement(
      previous,
      turnDetail([message("a"), work("tool")], turnId),
      "messages",
      true,
    );
    expect(next.messages).toEqual(["F5: Ready"]);
    expect(next.activity).toBeNull();
    expect(
      nextTurnDetailAnnouncement(
        next.memory,
        turnDetail([message("a"), work("tool")], turnId),
        "messages",
        true,
      ).messages,
    ).toEqual([]);
  });
  it("silently establishes baselines on open, level changes and inactive history", () => {
    const detail = turnDetail([message("a"), work("tool")], turnId);
    const baseline = nextTurnDetailAnnouncement(null, detail, "everything", true);
    expect(baseline.messages).toEqual([]);
    expect(baseline.activity).toBeNull();
    expect(nextTurnDetailAnnouncement(baseline.memory, detail, "messages", true).messages).toEqual(
      [],
    );
    expect(
      nextTurnDetailAnnouncement(baseline.memory, detail, "everything", false).messages,
    ).toEqual([]);
    expect(
      nextTurnDetailAnnouncement({ ...baseline.memory, level: "status" }, detail, "status", true)
        .messages,
    ).toEqual([]);
  });
  it("announces newly appended complete messages but not prepended history", () => {
    const baseline = nextTurnDetailAnnouncement(null, empty, "messages", true).memory;
    const fresh: TurnDetail = {
      entryIds: ["user", "a", "tool"],
      tailId: "tool",
      activity: "Read",
      messages: [{ id: "a", text: "New", finished: true }],
    };
    expect(nextTurnDetailAnnouncement(baseline, fresh, "messages", true).messages).toEqual([
      "F5: New",
    ]);
    const history = { ...fresh, entryIds: ["a", "user", "tool"] };
    expect(nextTurnDetailAnnouncement(baseline, history, "messages", true).messages).toEqual([]);
    expect(
      nextTurnDetailAnnouncement(baseline, { ...fresh, entryIds: ["a", "tool"] }, "messages", true)
        .messages,
    ).toEqual([]);
  });
  it("speaks steps only at everything and never reads reasoning content", () => {
    const baseline = nextTurnDetailAnnouncement(null, empty, "everything", true).memory;
    const thought = turnDetail([work("thinking", true)], turnId);
    expect(thought.activity).toBe("Thinking");
    expect(JSON.stringify(thought)).not.toContain("Private reasoning");
    expect(nextTurnDetailAnnouncement(baseline, thought, "everything", true).activity).toBe(
      "Thinking",
    );
    expect(
      nextTurnDetailAnnouncement({ ...baseline, level: "messages" }, thought, "messages", true)
        .activity,
    ).toBeNull();
    expect(
      nextTurnDetailAnnouncement(baseline, thought, "everything", true, false).activity,
    ).toBeNull();
  });
});
