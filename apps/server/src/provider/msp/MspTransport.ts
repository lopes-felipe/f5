import { ServerShutdown } from "../../shutdown.ts";
/**
 * MspTransport — the SDK's `DuplexTransport` over an Effect-spawned
 * `muse serve` child process.
 *
 * The SDK `Connection` owns NDJSON framing; this module only moves text:
 * decoded stdout chunks in, frames out through a bounded queue whose
 * `write` waits on the stdin sink, stderr always drained into a bounded
 * tail. `close` escalates: flush, end stdin, SIGTERM after 3 s, SIGKILL
 * 2 s later.
 *
 * @module provider/msp/MspTransport
 */
import type { DuplexTransport } from "@muse-code/sdk";
import { Cause, Effect, Exit, Fiber, Option, Queue, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveMuseInvocation } from "./MusePaths.ts";

export const MSP_FRAME_LIMIT_BYTES = 8 * 1024 * 1024;
export const MSP_OUTBOUND_QUEUE_FRAMES = 1_024;
export const MSP_STDERR_TAIL_BYTES = 64 * 1024;
export const MSP_FLUSH_BUDGET_MS = 1_000;
export const MSP_TERM_AFTER_MS = 3_000;
export const MSP_KILL_AFTER_MS = 2_000;
export const MSP_PIPE_CLOSE_GRACE_MS = 500;

export interface MspProcessExit {
  readonly code: number | null;
}

export interface MspTransportHandle {
  readonly transport: DuplexTransport;
  readonly pid: number;
  readonly exited: Promise<MspProcessExit>;
  /** Last {@link MSP_STDERR_TAIL_BYTES} of stderr, for error messages. */
  readonly stderrTail: () => string;
}

export interface MspTransportOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onStderr?: (chunk: string) => void;
  /** Injectable for tests; defaults keep the documented budgets. */
  readonly timings?: {
    readonly flushBudgetMs?: number;
    readonly termAfterMs?: number;
    readonly killAfterMs?: number;
    readonly pipeCloseGraceMs?: number;
  };
}

export class MspTransportClosedError extends Error {
  constructor() {
    super("Muse Code transport is closed.");
    this.name = "MspTransportClosedError";
  }
}

/** Single-consumer async iterable fed by the stdout fiber. */
class ChunkChannel implements AsyncIterable<string> {
  readonly #buffer: string[] = [];
  #waiter: ((result: IteratorResult<string>) => void) | undefined;
  #failWaiter: ((error: unknown) => void) | undefined;
  #done = false;
  #error: unknown;

  push(chunk: string): void {
    if (this.#done) return;
    if (this.#waiter) {
      const resolve = this.#waiter;
      this.#waiter = undefined;
      this.#failWaiter = undefined;
      resolve({ value: chunk, done: false });
      return;
    }
    this.#buffer.push(chunk);
  }

  end(error?: unknown): void {
    if (this.#done) return;
    this.#done = true;
    this.#error = error;
    if (this.#waiter) {
      const resolve = this.#waiter;
      const reject = this.#failWaiter;
      this.#waiter = undefined;
      this.#failWaiter = undefined;
      if (error !== undefined) reject?.(error);
      else resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const next = this.#buffer.shift();
        if (next !== undefined) return Promise.resolve({ value: next, done: false });
        if (this.#done) {
          return this.#error !== undefined
            ? Promise.reject(this.#error)
            : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.#waiter = resolve;
          this.#failWaiter = reject;
        });
      },
    };
  }
}

async function waitWithin<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const makeMspTransport = Effect.fn("makeMspTransport")(function* (
  options: MspTransportOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const shutdown = Option.getOrUndefined(yield* Effect.serviceOption(ServerShutdown));
  const remaining = (budget: number) =>
    shutdown?.deadline === undefined
      ? budget
      : Math.min(budget, Math.max(0, shutdown.deadline - Date.now()));
  const scope = yield* Scope.Scope;
  const invocation = yield* resolveMuseInvocation(
    options.binaryPath,
    [...options.args],
    options.environment,
    options.cwd,
  );
  const handle = yield* spawner.spawn(
    ChildProcess.make(invocation.file, [...invocation.args], {
      cwd: options.cwd,
      env: options.environment,
      extendEnv: false,
    }),
  );

  const incoming = new ChunkChannel();
  let processExited = false;
  const stdoutClosed = Promise.withResolvers<void>();
  let stderrTail = "";
  let resolveExited!: (exit: MspProcessExit) => void;
  const exited = new Promise<MspProcessExit>((resolve) => {
    resolveExited = resolve;
  });

  const stdoutReader = yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Effect.sync(() => incoming.push(chunk))),
    Effect.exit,
    Effect.flatMap((exit) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit)) incoming.end();
        else incoming.end(Cause.squash(exit.cause));
        stdoutClosed.resolve();
      }),
    ),
    Effect.forkIn(scope),
  );
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + chunk).slice(-MSP_STDERR_TAIL_BYTES);
        options.onStderr?.(chunk);
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  const finishIncoming = async () => {
    if (
      (await waitWithin(
        stdoutClosed.promise,
        remaining(options.timings?.pipeCloseGraceMs ?? MSP_PIPE_CLOSE_GRACE_MS),
      )) === "timeout"
    ) {
      // A descendant can retain stdout after the host dies. Only this bounded
      // fallback may end incoming before EOF; normal exit still drains frames.
      incoming.end(new MspTransportClosedError());
      void Effect.runPromise(Fiber.interrupt(stdoutReader));
    }
  };
  yield* handle.exitCode.pipe(
    Effect.match({
      onFailure: () => {
        processExited = true;
        resolveExited({ code: null });
      },
      onSuccess: (code) => {
        processExited = true;
        resolveExited({ code });
      },
    }),
    Effect.andThen(Effect.promise(finishIncoming)),
    Effect.forkIn(scope),
  );

  const outbound = yield* Queue.bounded<string, Cause.Done<void>>(MSP_OUTBOUND_QUEUE_FRAMES);
  const encoder = new TextEncoder();
  const writer = yield* Stream.fromQueue(outbound).pipe(
    Stream.map((frame) => encoder.encode(frame)),
    Stream.run(handle.stdin),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  let closing: Promise<void> | undefined;
  const flushBudgetMs = options.timings?.flushBudgetMs ?? MSP_FLUSH_BUDGET_MS;
  const termAfterMs = options.timings?.termAfterMs ?? MSP_TERM_AFTER_MS;
  const killAfterMs = options.timings?.killAfterMs ?? MSP_KILL_AFTER_MS;
  // `kill` resolves only once the process exits, so it is never awaited
  // directly: each step waits on `exited` within its own budget instead.
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    void Effect.runPromise(handle.kill({ killSignal: signal }).pipe(Effect.ignore));
  };

  const transport: DuplexTransport = {
    incoming,
    write: async (chunk) => {
      if (closing || processExited) throw new MspTransportClosedError();
      const accepted = await Effect.runPromise(Queue.offer(outbound, chunk));
      if (!accepted) throw new MspTransportClosedError();
    },
    close: (flushed) => {
      closing ??= (async () => {
        if (flushed)
          await waitWithin(
            flushed.catch(() => undefined),
            remaining(flushBudgetMs),
          );
        await Effect.runPromise(Queue.end(outbound));
        await waitWithin(Effect.runPromise(Fiber.await(writer)), remaining(flushBudgetMs));
        if ((await waitWithin(exited, remaining(termAfterMs))) !== "timeout") return;
        kill("SIGTERM");
        if ((await waitWithin(exited, remaining(killAfterMs))) !== "timeout") return;
        kill("SIGKILL");
        await waitWithin(exited, remaining(killAfterMs));
      })().finally(finishIncoming);
      return closing;
    },
  };

  return {
    transport,
    pid: handle.pid,
    exited,
    stderrTail: () => stderrTail,
  } satisfies MspTransportHandle;
});
