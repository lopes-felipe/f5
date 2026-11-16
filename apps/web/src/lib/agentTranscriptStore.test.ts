import { describe, expect, it } from "vitest";
import type { AgentTranscriptItem, AgentTranscriptPage } from "@t3tools/contracts";
import {
  deriveTranscriptRows,
  mergeAgentTranscriptPage,
  newTranscriptState,
} from "./agentTranscriptStore";
const message = (id: number): AgentTranscriptItem => ({
  id: String(id),
  createdAt: null,
  kind: "message",
  role: "assistant",
  text: String(id),
  truncated: false,
  position: { offset: id, index: 0 },
  earlierCursor: id > 0 ? "before:" + id : null,
});
const page = (items: AgentTranscriptItem[]): AgentTranscriptPage => ({
  availability: "ok",
  items,
  nextCursor: null,
  earlierCursor: "earlier",
  tailCursor: "tail",
  pendingTail: false,
  reset: false,
});
describe("transcript merge", () => {
  it("keeps native order and eviction counts when a floor rereads dropped history", () => {
    const initial = mergeAgentTranscriptPage(
      newTranscriptState(),
      page(Array.from({ length: 2100 }, (_, i) => message(i))),
      "append",
    );
    expect(initial.droppedCount).toBe(100);
    const reread = mergeAgentTranscriptPage(
      initial,
      page(Array.from({ length: 50 }, (_, i) => message(i))),
      "append",
    );
    expect(reread.items.map((item) => item.id)).toEqual(initial.items.map((item) => item.id));
    expect(reread.droppedCount).toBe(100);
    expect(reread.earlierCursor).toBe("before:100");
    const appended = mergeAgentTranscriptPage(reread, page([message(2100)]), "append");
    expect(appended.droppedCount).toBe(101);
    expect(appended.earlierCursor).toBe("before:101");
    const earlier = mergeAgentTranscriptPage(
      appended,
      page([message(99), message(100)]),
      "prepend",
    );
    expect(earlier.items[0]?.id).toBe("99");
    expect(earlier.detachedFromLatest).toBe(true);
  });
  it("preserves navigation checkpoints through unavailable responses", () => {
    const initial = mergeAgentTranscriptPage(
      newTranscriptState(),
      { ...page([message(100)]), nextCursor: "catch-up" },
      "append",
    );
    const unavailable = mergeAgentTranscriptPage(
      initial,
      {
        ...page([]),
        availability: "unavailable",
        reason: "session-not-running",
        nextCursor: null,
        earlierCursor: null,
        tailCursor: null,
      },
      "append",
    );
    expect(unavailable.items).toEqual(initial.items);
    expect(unavailable.nextCursor).toBe("catch-up");
    expect(unavailable.tailCursor).toBe("tail");
    expect(unavailable.earlierCursor).toBe("before:100");
  });
  it("upserts in order", () => {
    const first = mergeAgentTranscriptPage(
      newTranscriptState(),
      page([message(1), message(2)]),
      "append",
    );
    expect(
      mergeAgentTranscriptPage(first, page([message(2), message(3)]), "append").items.map(
        (item) => item.id,
      ),
    ).toEqual(["1", "2", "3"]);
  });
  it("bounds append and prepend windows", () => {
    const full = mergeAgentTranscriptPage(
      newTranscriptState(),
      page(Array.from({ length: 2000 }, (_, i) => message(i))),
      "append",
    );
    const appended = mergeAgentTranscriptPage(full, page([message(2000)]), "append");
    expect(appended.droppedCount).toBe(1);
    expect(appended.items[0]?.id).toBe("1");
    const prepended = mergeAgentTranscriptPage(appended, page([message(0)]), "prepend");
    expect(prepended.detachedFromLatest).toBe(true);
    expect(prepended.items).toHaveLength(2000);
  });
  it("folds results that arrive before a call and settles unmatched calls", () => {
    const result: AgentTranscriptItem = {
      id: "r",
      createdAt: null,
      kind: "tool-result",
      toolCallId: "t",
      isError: false,
      output: "ok",
      outputTruncated: false,
    };
    const call: AgentTranscriptItem = {
      id: "c",
      createdAt: null,
      kind: "tool-call",
      toolCallId: "t",
      toolName: "Bash",
      itemType: "command_execution",
      title: "Command",
      detail: "pwd",
      status: "running",
      output: "",
      outputTruncated: false,
    };
    const state = mergeAgentTranscriptPage(newTranscriptState(), page([result, call]), "append");
    expect(deriveTranscriptRows(state, false)).toMatchObject([
      { id: "c", status: "completed", output: "ok" },
    ]);
    expect(deriveTranscriptRows({ ...state, items: [call] }, true)).toMatchObject([
      { output: "No result" },
    ]);
    expect(mergeAgentTranscriptPage(state, { ...page([]), reset: true }, "append").loaded).toBe(
      false,
    );
  });
});
