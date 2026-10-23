import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import { runProcess } from "../processRunner.ts";

import type { TraceRecord } from "./TraceRecord.ts";
import { makeTraceSink, TRACE_BUFFER_MAX_BYTES, TRACE_BUFFER_MAX_RECORDS } from "./TraceSink.ts";

const makeRecord = (name: string, suffix = ""): TraceRecord => ({
  type: "effect-span",
  name,
  traceId: `trace-${name}-${suffix}`,
  spanId: `span-${name}-${suffix}`,
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: {
    payload: suffix,
  },
  events: [],
  links: [],
  exit: {
    _tag: "Success",
  },
});

describe("TraceSink", () => {
  it.effect("flushes buffered records on close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("alpha"));
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);

          assert.equal(lines.length, 2);
          assert.equal(lines[0]?.name, "alpha");
          assert.equal(lines[1]?.name, "beta");
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("rotates the trace file when the configured max size is exceeded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 180,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 8; index += 1) {
            sink.push(makeRecord("rotate", `${index}-${"x".repeat(48)}`));
            yield* sink.flush;
          }
          yield* sink.close();

          const matchingFiles = fs
            .readdirSync(tempDir)
            .filter(
              (entry) =>
                entry === "server.trace.ndjson" || entry.startsWith("server.trace.ndjson."),
            )
            .toSorted();

          assert.equal(
            matchingFiles.some((entry) => entry === "server.trace.ndjson.1"),
            true,
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );
});

describe("bounded asynchronous trace sink", () => {
  it.effect("drops the oldest records at the count limit", () =>
    Effect.gen(function* () {
      const written: TraceRecord[] = [];
      const sink = yield* makeTraceSink({
        filePath: "/unused",
        maxBytes: 1024,
        maxFiles: 2,
        batchWindowMs: 10000,
        writer: {
          write: async (records) => {
            written.push(
              ...records.map(
                (record) => JSON.parse(new TextDecoder().decode(record)) as TraceRecord,
              ),
            );
          },
          close: async () => {},
        },
      });
      for (let i = 0; i < 5000; i++) sink.push(makeRecord(`record-${i}`));
      assert.equal(sink.statistics().bufferedRecords, TRACE_BUFFER_MAX_RECORDS);
      assert.equal(sink.statistics().droppedRecords, 5000 - TRACE_BUFFER_MAX_RECORDS);
      yield* sink.flush;
      assert.equal(written.length, TRACE_BUFFER_MAX_RECORDS);
      assert.equal(written[0]?.name, `record-${5000 - TRACE_BUFFER_MAX_RECORDS}`);
      assert.equal(written.at(-1)?.name, "record-4999");
      yield* sink.close();
    }).pipe(Effect.scoped),
  );

  it.effect("bounds UTF-8 bytes and drops any individually oversized record", () =>
    Effect.gen(function* () {
      const sink = yield* makeTraceSink({
        filePath: "/unused",
        maxBytes: 1024,
        maxFiles: 2,
        batchWindowMs: 10000,
        writer: { write: async () => {}, close: async () => {} },
      });
      sink.push(makeRecord("too-large", "x".repeat(TRACE_BUFFER_MAX_BYTES)));
      assert.equal(sink.statistics().bufferedRecords, 0);
      assert.equal(sink.statistics().droppedRecords, 1);
      for (let i = 0; i < 5; i++)
        sink.push({ ...makeRecord(`unicode-${i}`), attributes: { payload: "🦊".repeat(300000) } });
      assert.ok(sink.statistics().bufferedBytes <= TRACE_BUFFER_MAX_BYTES);
      assert.equal(sink.statistics().bufferedRecords, 3);
      assert.equal(sink.statistics().droppedRecords, 3);
      yield* sink.close();
    }).pipe(Effect.scoped),
  );

  it.effect("counts in-flight data toward both limits and permits one write at a time", () =>
    Effect.gen(function* () {
      let release!: () => void;
      let calls = 0;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sink = yield* makeTraceSink({
        filePath: "/unused",
        maxBytes: 1024,
        maxFiles: 2,
        batchWindowMs: 10000,
        writer: {
          write: () => (++calls === 1 ? blocked : Promise.resolve()),
          close: async () => {},
        },
      });
      for (let i = 0; i < 32; i++) sink.push(makeRecord(`flight-${i}`));
      const first = Effect.runPromise(sink.flush);
      const second = Effect.runPromise(sink.flush);
      assert.equal(calls, 1);
      for (let i = 0; i < 5000; i++) sink.push(makeRecord(`queued-${i}`));
      const stats = sink.statistics();
      assert.equal(stats.inFlightRecords, 32);
      assert.equal(stats.bufferedRecords + stats.inFlightRecords, TRACE_BUFFER_MAX_RECORDS);
      assert.ok(stats.bufferedBytes + stats.inFlightBytes <= TRACE_BUFFER_MAX_BYTES);
      assert.equal(calls, 1);
      release();
      yield* Effect.promise(() => Promise.all([first, second]));
      yield* sink.close();
    }).pipe(Effect.scoped),
  );

  it.effect("backs off and records write failures without retaining a failed batch", () =>
    Effect.gen(function* () {
      let calls = 0;
      const sink = yield* makeTraceSink({
        filePath: "/unused",
        maxBytes: 1024,
        maxFiles: 2,
        batchWindowMs: 10000,
        writer: {
          write: async () => {
            calls++;
            throw new Error("disk full");
          },
          close: async () => {},
        },
      });
      for (let i = 0; i < 64; i++) sink.push(makeRecord(`failed-${i}`));
      yield* sink.flush;
      assert.equal(calls, 1);
      assert.equal(sink.statistics().writeFailures, 1);
      assert.equal(sink.statistics().droppedRecords, 32);
      yield* sink.flush;
      assert.equal(calls, 1);
      for (let i = 0; i < 5000; i++) sink.push(makeRecord(`new-${i}`));
      assert.ok(sink.statistics().bufferedRecords <= TRACE_BUFFER_MAX_RECORDS);
      yield* sink.close();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "performs trace writes in the worker rather than synchronous main-thread filesystem calls",
    () =>
      Effect.gen(function* () {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-trace-off-thread-"));
        const tracePath = path.join(directory, "traces.ndjson");
        const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
          throw new Error("Main-thread append");
        });
        const write = vi.spyOn(fs, "writevSync").mockImplementation(() => {
          throw new Error("Main-thread write");
        });
        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10000,
          });
          sink.push(makeRecord("worker-owned-write"));
          yield* sink.flush;
          yield* sink.close();
          assert.equal(sink.statistics().writeFailures, 0);
          assert.equal(JSON.parse(fs.readFileSync(tracePath, "utf8")).name, "worker-owned-write");
          assert.equal(append.mock.calls.length, 0);
          assert.equal(write.mock.calls.length, 0);
        } finally {
          append.mockRestore();
          write.mockRestore();
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }).pipe(Effect.scoped),
  );

  it.effect("an inaccessible trace destination does not fail the server scope", () =>
    Effect.gen(function* () {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-trace-failure-"));
      try {
        const parent = path.join(directory, "file-instead-of-directory");
        fs.writeFileSync(parent, "occupied");
        const sink = yield* makeTraceSink({
          filePath: path.join(parent, "traces.ndjson"),
          maxBytes: 1024,
          maxFiles: 2,
          batchWindowMs: 10000,
        });
        sink.push(makeRecord("disk-failure"));
        yield* sink.flush;
        assert.equal(sink.statistics().writeFailures, 1);
        assert.equal(sink.statistics().droppedRecords, 1);
        yield* sink.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }).pipe(Effect.scoped),
  );

  it("bounds shutdown with a hung write and stops accepting new records", async () => {
    vi.useFakeTimers();
    try {
      let closes = 0;
      await Effect.runPromise(
        Effect.gen(function* () {
          const sink = yield* makeTraceSink({
            filePath: "/unused",
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10000,
            closeTimeoutMs: 50,
            writer: {
              write: () => new Promise(() => {}),
              close: async () => {
                closes++;
              },
            },
          });
          sink.push(makeRecord("hung"));
          const pending = Effect.runPromise(sink.close());
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(50));
          yield* Effect.promise(() => pending);
          assert.equal(closes, 1);
          const before = sink.statistics().droppedRecords;
          sink.push(makeRecord("after-close"));
          assert.equal(sink.statistics().droppedRecords, before + 1);
          yield* sink.close();
          assert.equal(closes, 1);
        }).pipe(Effect.scoped),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

it.skipIf(process.platform === "win32")(
  "a worker blocked opening a FIFO cannot keep the server process alive",
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-trace-shutdown-"));
    const fifo = path.join(directory, "blocked.ndjson");
    try {
      await runProcess("mkfifo", [fifo], { cwd: directory, env: process.env, timeoutMs: 5000 });
      const script = `
      import { Effect } from "effect";
      import { makeTraceSink } from ${JSON.stringify(new URL("./TraceSink.ts", import.meta.url).href)};
      await Effect.runPromise(Effect.gen(function* () {
        const sink = yield* makeTraceSink({ filePath: ${JSON.stringify(fifo)}, maxBytes: 1024, maxFiles: 2, batchWindowMs: 0 });
        sink.push(${JSON.stringify(makeRecord("blocked-worker"))});
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
        if (sink.statistics().inFlightRecords !== 1 || sink.statistics().writeFailures !== 0)
          throw new Error("The worker did not remain blocked on the FIFO.");
        yield* sink.close();
        console.log("closed");
      }).pipe(Effect.scoped));
    `;
      const result = await runProcess(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 6000,
        allowNonZeroExit: true,
      });
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes("closed"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
