import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import { providerLogWriterInventory } from "../logWriterRegistry.ts";

import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

function parseLogLine(line: string) {
  const match = /^\[([^\]]+)\] ([A-Z]+): (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match) {
    throw new Error(`invalid log line: ${line}`);
  }
  const observedAt = match[1];
  const stream = match[2];
  const payload = match[3];
  if (!observedAt || !stream || payload === undefined) {
    throw new Error(`invalid log line: ${line}`);
  }
  return {
    observedAt,
    stream,
    payload,
  };
}

describe("EventNdjsonLogger", () => {
  it.effect(
    "serializes native and canonical streams through one writer and flushes admitted deltas on close",
    () =>
      Effect.gen(function* () {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-shared-log-"));
        try {
          const native = (yield* makeEventNdjsonLogger(path.join(directory, "native.ndjson"), {
            stream: "native",
            batchWindowMs: 60_000,
          }))!;
          const canonical = (yield* makeEventNdjsonLogger(
            path.join(directory, "canonical.ndjson"),
            { stream: "canonical", batchWindowMs: 60_000 },
          ))!;
          const thread = ThreadId.makeUnsafe("same-thread");
          for (let i = 0; i < 30; i++) {
            yield* native.write({ type: "content.delta", index: i }, thread);
            yield* canonical.write({ type: "content.delta", index: i }, thread);
          }
          assert.equal(providerLogWriterInventory().writers, 1);
          yield* native.close();
          yield* canonical.close();
          const lines = fs
            .readFileSync(path.join(directory, "same-thread.log"), "utf8")
            .trim()
            .split("\n")
            .map(parseLogLine);
          assert.equal(lines.length, 60);
          for (let i = 0; i < 30; i++) {
            assert.equal(lines[i * 2]!.stream, "NTIVE");
            assert.equal(lines[i * 2 + 1]!.stream, "CANON");
            assert.equal(JSON.parse(lines[i * 2]!.payload).index, i);
          }
          assert.equal(providerLogWriterInventory().entries, 0);
          assert.equal(providerLogWriterInventory().writers, 0);
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }),
  );

  it.effect("batches ACP content chunks but awaits append for plan and tool boundaries", () =>
    Effect.gen(function* () {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-acp-log-"));
      const opened = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const open = fs.promises.open.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        opened.resolve();
        await release.promise;
        return open(...args);
      });
      try {
        const logger = (yield* makeEventNdjsonLogger(path.join(directory, "native.ndjson"), {
          stream: "native",
          batchWindowMs: 60_000,
        }))!;
        const threadId = ThreadId.makeUnsafe("thread");
        const event = (sessionUpdate: string) => ({
          event: {
            method: "session/update",
            payload: { update: { sessionUpdate, content: { type: "text", text: "token" } } },
          },
        });
        for (const kind of ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"])
          yield* logger.write(event(kind), threadId);
        assert.equal(spy.mock.calls.length, 0);
        let acknowledged = false;
        const boundary = Effect.runPromise(logger.write(event("tool_call"), threadId)).then(() => {
          acknowledged = true;
        });
        yield* Effect.promise(() => opened.promise);
        assert.isFalse(acknowledged);
        release.resolve();
        yield* Effect.promise(() => boundary);
        yield* logger.write(event("plan"), threadId);
        yield* logger.close();
        const records = fs
          .readFileSync(path.join(directory, "thread.log"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);
        assert.equal(records.length, 5);
        assert.equal(
          JSON.parse(records[3]!.payload).event.payload.update.sessionUpdate,
          "tool_call",
        );
      } finally {
        release.resolve();
        spy.mockRestore();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("close waits for a record admitted before serialization yields", () =>
    Effect.gen(function* () {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-log-admission-"));
      try {
        const logger = (yield* makeEventNdjsonLogger(path.join(directory, "native.ndjson"), {
          stream: "native",
        }))!;
        let closing: Promise<void> | undefined;
        yield* logger.write(
          {
            toJSON() {
              closing = Effect.runPromise(logger.close());
              return { type: "turn.completed" };
            },
          },
          ThreadId.makeUnsafe("thread"),
        );
        yield* Effect.promise(() => closing!);
        assert.equal(
          JSON.parse(
            parseLogLine(fs.readFileSync(path.join(directory, "thread.log"), "utf8").trim())
              .payload,
          ).type,
          "turn.completed",
        );
        assert.equal(providerLogWriterInventory().writers, 0);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("recovers a transient open failure and removes a crashed partial final record", () =>
    Effect.gen(function* () {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-retry-log-"));
      const filePath = path.join(directory, "thread.log");
      fs.writeFileSync(
        filePath,
        '[2026-10-19T00:00:00.000Z] NTIVE: {"type":"assistant"}\n[partial completion',
      );
      const open = fs.promises.open.bind(fs.promises);
      const spy = vi
        .spyOn(fs.promises, "open")
        .mockRejectedValueOnce(new Error("temporary disk failure"))
        .mockImplementation(open);
      try {
        const logger = (yield* makeEventNdjsonLogger(path.join(directory, "native.ndjson"), {
          stream: "native",
        }))!;
        yield* logger.write({ type: "turn.completed" }, ThreadId.makeUnsafe("thread"));
        yield* logger.close();
        const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").map(parseLogLine);
        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[1]!.payload).type, "turn.completed");
        assert.equal(spy.mock.calls.length, 2);
      } finally {
        spy.mockRestore();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("rolls back a short partial append before retrying a complete record", () =>
    Effect.gen(function* () {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-partial-log-"));
      const filePath = path.join(directory, "thread.log");
      const prefix = '[2026-10-19T00:00:00.000Z] NTIVE: {"type":"assistant"}\n';
      fs.writeFileSync(filePath, prefix);
      const open = fs.promises.open.bind(fs.promises);
      let writes = 0;
      const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        return new Proxy(handle, {
          get(target, property) {
            if (property === "write")
              return async (
                buffer: Uint8Array,
                offset: number,
                length: number,
                position: number,
              ) => {
                writes++;
                if (writes === 1)
                  return target.write(buffer, offset, Math.min(length, 3), position);
                if (writes === 2) throw new Error("transient write failure");
                return target.write(buffer, offset, length, position);
              };
            const member = Reflect.get(target, property, target);
            return typeof member === "function" ? member.bind(target) : member;
          },
        });
      });
      try {
        const logger = (yield* makeEventNdjsonLogger(path.join(directory, "native.ndjson"), {
          stream: "native",
        }))!;
        yield* logger.write(
          { type: "turn.completed", text: "final🙂" },
          ThreadId.makeUnsafe("thread"),
        );
        yield* logger.close();
        const text = fs.readFileSync(filePath, "utf8");
        assert.isTrue(text.startsWith(prefix));
        const lines = text.trim().split("\n");
        assert.equal(lines.length, 2);
        assert.deepStrictEqual(JSON.parse(parseLogLine(lines[1]!).payload), {
          type: "turn.completed",
          text: "final🙂",
        });
      } finally {
        spy.mockRestore();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("writes effect-style lines to thread-scoped files", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write(
          { threadId: "provider-thread-1", id: "evt-1" },
          ThreadId.makeUnsafe("thread-1"),
        );
        yield* logger.write(
          { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
          ThreadId.makeUnsafe("thread-2"),
        );
        yield* logger.close();

        const threadOnePath = path.join(tempDir, "thread-1.log");
        const threadTwoPath = path.join(tempDir, "thread-2.log");
        assert.equal(fs.existsSync(threadOnePath), true);
        assert.equal(fs.existsSync(threadTwoPath), true);

        const first = parseLogLine(fs.readFileSync(threadOnePath, "utf8").trim());
        const second = parseLogLine(fs.readFileSync(threadTwoPath, "utf8").trim());

        assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
        assert.equal(first.stream, "NTIVE");
        assert.equal(first.payload, '{"threadId":"provider-thread-1","id":"evt-1"}');

        assert.equal(Number.isNaN(Date.parse(second.observedAt)), false);
        assert.equal(second.stream, "NTIVE");
        assert.equal(
          second.payload,
          '{"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
        const basePath = path.join(tempDir, "provider-canonical.ndjson");

        try {
          const logger = yield* makeEventNdjsonLogger(basePath, { stream: "orchestration" });
          assert.notEqual(logger, undefined);
          if (!logger) {
            return;
          }

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as unknown as ThreadId);
          yield* logger.close();

          const globalPath = path.join(tempDir, "_global.log");
          assert.equal(fs.existsSync(globalPath), true);
          const lines = fs
            .readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));
          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "CANON");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "CANON");
          assert.equal(lines[1]?.payload, '{"id":"evt-invalid-thread"}');
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("rotates per-thread files when max size is exceeded", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          maxBytes: 120,
          maxFiles: 2,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        for (let index = 0; index < 10; index += 1) {
          yield* logger.write(
            {
              threadId: "provider-thread-rotate",
              id: `evt-${index}`,
              payload: "x".repeat(40),
            },
            ThreadId.makeUnsafe("thread-rotate"),
          );
        }
        yield* logger.close();

        const fileStem = "thread-rotate.log";
        const matchingFiles = fs
          .readdirSync(tempDir)
          .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
          .toSorted();

        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.1`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.3`),
          false,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
