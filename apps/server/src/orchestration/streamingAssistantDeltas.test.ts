import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeStreamingAssistantDeltas,
  type AssistantDeltaCommand,
} from "./streamingAssistantDeltas.ts";

const threadId = ThreadId.makeUnsafe("stream-thread");
const messageId = MessageId.makeUnsafe("stream-message");
const command = (id: string, delta: string, reasoningDelta?: string): AssistantDeltaCommand => ({
  type: "thread.message.assistant.delta",
  threadId,
  messageId,
  commandId: CommandId.makeUnsafe(id),
  delta,
  ...(reasoningDelta ? { reasoningDelta } : {}),
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("streaming delta batches", () => {
  it("keeps delta/tool/delta ordering and combines assistant and reasoning text", async () => {
    const order: string[] = [];
    const buffer = makeStreamingAssistantDeltas(
      (batch) =>
        Effect.sync(() => {
          order.push(`${batch.delta}:${batch.reasoningDelta ?? ""}`);
        }),
      () => {},
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* buffer.append(command("first", "a"));
        yield* buffer.append(command("second", "b", "reason"));
        yield* buffer.flushThread(threadId);
        order.push("tool");
        yield* buffer.append(command("third", "c"));
        yield* buffer.flushAll();
      }),
    );
    expect(order).toEqual(["ab:reason", "tool", "c:"]);
  });

  it("retries exactly the frozen payload/id, then accepts a distinct following batch", async () => {
    const seen: AssistantDeltaCommand[] = [];
    const buffer = makeStreamingAssistantDeltas(
      (batch) =>
        Effect.suspend(() => {
          seen.push(batch);
          return seen.length < 3 ? Effect.fail("transient") : Effect.void;
        }),
      () => {},
    );
    await Effect.runPromise(buffer.append(command("first", "hello")));
    await Effect.runPromise(buffer.flushThread(threadId));
    await Effect.runPromise(buffer.append(command("next", "world")));
    await Effect.runPromise(buffer.flushAll());
    expect(seen.slice(0, 3).every((batch) => batch === seen[0])).toBe(true);
    expect(seen.map((batch) => [batch.commandId, batch.delta])).toEqual([
      ["first", "hello"],
      ["first", "hello"],
      ["first", "hello"],
      ["next", "world"],
    ]);
  });

  it("drops exhausted batches and suppresses later suffixes until authoritative completion", async () => {
    let attempts = 0;
    const buffer = makeStreamingAssistantDeltas(
      () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail("offline");
        }),
      () => {},
    );
    await Effect.runPromise(buffer.append(command("first", "hello")));
    await Effect.runPromise(buffer.flushAll());
    await Effect.runPromise(buffer.append(command("later", "world")));
    await Effect.runPromise(buffer.flushThread(threadId));
    expect(attempts).toBe(3);
    buffer.forgetMessage(threadId, messageId);
    await Effect.runPromise(buffer.append(command("after-completion", "new message")));
    await Effect.runPromise(buffer.flushAll());
    expect(attempts).toBe(6);
  });

  it("flushes at 2 KiB of UTF-8 and ignores a stale timer after completion/interrupt", async () => {
    const jobs: Array<() => Effect.Effect<void>> = [];
    const seen: AssistantDeltaCommand[] = [];
    const buffer = makeStreamingAssistantDeltas(
      (batch) =>
        Effect.sync(() => {
          seen.push(batch);
        }),
      (thread, message, id) => {
        jobs.push(() => buffer.flush(thread, message, id));
      },
    );
    await Effect.runPromise(buffer.append(command("size", "é".repeat(1024))));
    expect(seen).toHaveLength(1);
    await Effect.runPromise(buffer.append(command("timer", "a")));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(jobs).toHaveLength(1);
    await Effect.runPromise(buffer.flushThread(threadId));
    await Effect.runPromise(buffer.append(command("new", "b")));
    await Effect.runPromise(jobs[0]!());
    expect(seen).toHaveLength(2);
    await Effect.runPromise(buffer.flushAll());
    expect(seen[2]?.delta).toBe("b");
  });
});

it("does not retry permanent rejections and flushes other threads after one fails", async () => {
  const seen: string[] = [];
  const buffer = makeStreamingAssistantDeltas(
    (batch) =>
      Effect.suspend(() => {
        seen.push(batch.delta);
        return batch.threadId === threadId ? Effect.fail("permanent") : Effect.void;
      }),
    () => {},
    () => true,
  );
  await Effect.runPromise(buffer.append(command("bad", "bad")));
  await Effect.runPromise(
    buffer.append({ ...command("good", "good"), threadId: ThreadId.makeUnsafe("other") }),
  );
  await Effect.runPromise(buffer.flushAll());
  expect(seen).toEqual(["bad", "good"]);
  await Effect.runPromise(buffer.flushThread(threadId));
  expect(seen).toHaveLength(2);
});
