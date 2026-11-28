import { OrchestrationEvent } from "@t3tools/contracts";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { makeMobileBatches } from "./liveBatches";

const date = "2026-11-28T00:00:00.000Z";
const decode = Schema.decodeUnknownSync(OrchestrationEvent);
function frame(sequence: number, threadId: string, text: string, replace = false) {
  return decode({
    type: "thread.message-sent",
    sequence,
    eventId: "event-" + sequence,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: date,
    commandId: null,
    correlationId: null,
    causationEventId: null,
    metadata: {},
    payload: {
      threadId,
      messageId: "message",
      text,
      role: "assistant",
      reasoningText: "private reasoning",
      createdAt: date,
      updatedAt: date,
      turnId: "turn",
      streaming: true,
      ...(replace ? { replace: true } : {}),
    },
  });
}

it("advances across filtered events while sending only selected message patches", () => {
  const batches = makeMobileBatches(0, "viewed", [
    frame(1, "other", "off-thread text"),
    frame(2, "viewed", "visible text"),
    frame(3, "viewed", "updated text", true),
    frame(4, "different", "unseen text"),
  ]);
  expect(batches).toHaveLength(1);
  expect(batches[0]).toMatchObject({
    afterSequence: 0,
    throughSequence: 4,
    threadIds: [],
    messages: [
      { sequence: 2, mode: "append", text: "visible text" },
      { sequence: 3, mode: "replace", text: "updated text" },
    ],
  });
  expect(JSON.stringify(batches)).not.toMatch(/off-thread text|private reasoning|unseen text/);
});

it("splits at event boundaries and invalidates an oversized selected transcript", () => {
  const batches = makeMobileBatches(20, "viewed", [
    frame(21, "viewed", "a".repeat(150_000)),
    frame(22, "viewed", "b".repeat(150_000)),
    frame(23, "viewed", "oversized".repeat(60_000)),
  ]);
  expect(
    batches.map((item) => [item.afterSequence, item.throughSequence, item.tailInvalidated]),
  ).toEqual([
    [20, 21, false],
    [21, 23, true],
  ]);
  for (const body of batches)
    expect(Buffer.byteLength(JSON.stringify({ channel: "mobile.batch", body }))).toBeLessThan(
      256 * 1024,
    );
});
