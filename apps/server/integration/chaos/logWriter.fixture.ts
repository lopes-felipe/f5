/** Delays the final physical write so the parent can kill the real logging process mid-batch. */
import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { ThreadId } from "@t3tools/contracts";
import { makeEventNdjsonLogger } from "../../src/provider/Layers/EventNdjsonLogger.ts";

const directory = process.argv[2]!;
const originalOpen = fs.open;
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "write")
        return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          const text = Buffer.from(buffer)
            .subarray(offset, offset + length)
            .toString("utf8");
          if (text.includes('"eventId":"partial-completion"')) {
            let written = 0;
            while (written < length - 1) {
              const result = await target.write(
                buffer,
                offset + written,
                length - 1 - written,
                position + written,
              );
              if (!result.bytesWritten) throw new Error("Fixture write made no progress");
              written += result.bytesWritten;
            }
            process.stdout.write('F5_CHAOS:{"type":"partial"}\n');
            return await new Promise<never>(() => {});
          }
          return target.write(buffer, offset, length, position);
        };
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
};
await Effect.runPromise(
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-repair");
    const native = yield* makeEventNdjsonLogger(path.join(directory, "native.ndjson"), {
      stream: "native",
      batchWindowMs: 10_000,
    });
    const canonical = yield* makeEventNdjsonLogger(path.join(directory, "canonical.ndjson"), {
      stream: "canonical",
      batchWindowMs: 10_000,
    });
    if (!native || !canonical) throw new Error("Could not open fixture logs");
    yield* native.write(
      {
        event: {
          createdAt: "2026-10-07T09:38:00.000Z",
          method: "claude/assistant",
          payload: {
            session_id: "session",
            uuid: "target",
            message: {
              id: "message-target",
              role: "assistant",
              content: [{ type: "text", text: "recovered answer" }],
            },
          },
        },
      },
      threadId,
    );
    for (let index = 0; index < 8; index++)
      yield* canonical.write({ type: "content.delta", delta: String(index) }, null);
    yield* canonical.write(
      {
        type: "turn.completed",
        eventId: "partial-completion",
        provider: "codex",
        threadId,
        turnId: "turn-repair",
        createdAt: "2026-08-18T08:00:00.000Z",
        payload: { state: "completed" },
      },
      null,
    );
    throw new Error("Parent should kill the delayed write before it acknowledges completion");
  }),
);
