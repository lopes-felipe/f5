import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, describe, expect } from "vitest";

// Larger than any pipe buffer, so the write is still pending when the child stops reading.
const payload = new Uint8Array(8 * 1024 * 1024).fill(97);

// The patched spawner (patches/@effect%2Fplatform-node-shared@*.patch) must turn a
// failed stdin write into a sink failure, never an uncaught EPIPE or a hung writer.
const uncaught: unknown[] = [];
const collect = (error: unknown) => void uncaught.push(error);
beforeEach(() => {
  uncaught.length = 0;
  process.on("uncaughtException", collect);
});
afterEach(() => {
  process.off("uncaughtException", collect);
  expect(uncaught).toEqual([]);
});

const spawn = (script: string, options?: ChildProcess.CommandOptions) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner.asEffect(), (spawner) =>
    spawner.spawn(ChildProcess.make(process.execPath, ["-e", script], options)),
  );

describe("child stdin", () => {
  it.live("fails a pending write when the child exits before reading, and reports its exit", () =>
    Effect.gen(function* () {
      const child = yield* spawn("process.exit(3)");
      const written = yield* Stream.run(Stream.make(payload), child.stdin).pipe(
        Effect.timeout("10 seconds"),
        Effect.exit,
      );
      expect(Exit.isFailure(written)).toBe(true);
      expect(String(written)).toContain("fromWritable(stdin)");
      expect(Number(yield* child.exitCode)).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails a write to a running child that closed its stdin instead of hanging", () =>
    Effect.gen(function* () {
      // An ACP agent that stops reading: later messages must fail, not queue forever.
      const child = yield* spawn('require("node:fs").closeSync(0); setInterval(() => {}, 1000)');
      const written = yield* Stream.run(Stream.make(payload), child.stdin).pipe(
        Effect.timeout("10 seconds"),
        Effect.exit,
      );
      expect(Exit.isFailure(written)).toBe(true);
      expect(String(written)).toContain("fromWritable(stdin)");
      expect(yield* child.isRunning).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports the exit code when a stdin stream option outlives the child", () =>
    Effect.gen(function* () {
      // GitService's shape: the spawner forks the stdin writer itself.
      const child = yield* spawn("process.exit(3)", { stdin: Stream.make(payload) });
      expect(Number(yield* child.exitCode)).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
