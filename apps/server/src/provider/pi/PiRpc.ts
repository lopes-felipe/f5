import { Cause, Deferred, Effect, Option, Queue, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodePath from "node:path";
import { assertJsonSourceWithinLimits, stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { resolveInvocationEffect } from "../../spawn/resolveCommand.ts";
import { PiLineFramer } from "./PiLineFramer.ts";

export class PiRpcError extends Schema.TaggedErrorClass<PiRpcError>()("PiRpcError", {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}
export class PiRpcTimeoutError extends Schema.TaggedErrorClass<PiRpcTimeoutError>()(
  "PiRpcTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message() {
    return `Pi RPC ${this.operation} timed out after ${this.timeoutMs}ms.`;
  }
}
import type { PiRpcRecord } from "./PiProtocol.ts";
export {
  piRecordField,
  piRecordString,
  piRecordNumber,
  parsePiModelSlug,
  type PiRpcRecord,
} from "./PiProtocol.ts";
export const PI_RPC_LIMITS = {
  frameBytes: 16 * 1024 * 1024,
  bufferedBytes: 32 * 1024 * 1024,
  queuedFrames: 256,
  pendingRequests: 64,
} as const;
type Limits = { readonly [K in keyof typeof PI_RPC_LIMITS]: number };
export interface PiRpcOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  /** Internal harnesses may reduce budgets, never raise them. */
  readonly limits?: Partial<Limits>;
  readonly terminationGraceMs?: number;
}
export interface PiRpcConnection {
  readonly pid: number;
  readonly request: (
    record: PiRpcRecord,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, PiRpcError | PiRpcTimeoutError>;
  readonly send: (record: PiRpcRecord) => Effect.Effect<void, PiRpcError>;
  readonly events: Stream.Stream<PiRpcRecord, PiRpcError>;
  readonly exited: Effect.Effect<number, PiRpcError>;
  readonly terminate: Effect.Effect<void>;
}

const json = Schema.fromJsonString(Schema.Unknown);
const decode = Schema.decodeUnknownSync(json);
type Packet = { readonly record: PiRpcRecord; readonly bytes: number };

export const makePiRpcConnection = (options: PiRpcOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Effect.scope;
    const error = (operation: string, detail: string) => new PiRpcError({ operation, detail });
    const limits: Limits = { ...PI_RPC_LIMITS };
    for (const key of Object.keys(limits) as (keyof Limits)[]) {
      const value = options.limits?.[key] ?? limits[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > PI_RPC_LIMITS[key])
        return yield* error("configure", "The Pi transport budget is invalid.");
      Object.assign(limits, { [key]: value });
    }
    const grace = options.terminationGraceMs ?? 1000;
    if (!Number.isSafeInteger(grace) || grace < 1 || grace > 1000)
      return yield* error("configure", "The Pi termination deadline is invalid.");
    const invocation = yield* resolveInvocationEffect(options.command, options.args, options.env, {
      cwd: options.cwd,
    }).pipe(Effect.mapError(() => error("spawn", "The Pi executable could not be resolved.")));
    const child = yield* spawner
      .spawn(
        ChildProcess.make(invocation.file, [...invocation.args], {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: options.env,
          extendEnv: false,
          detached: process.platform !== "win32",
        }),
      )
      .pipe(
        Effect.mapError(() => error("spawn", "The Pi process could not be started.")),
        Effect.tap((handle) =>
          Scope.addFinalizer(
            scope,
            Effect.gen(function* () {
              if (yield* handle.isRunning.pipe(Effect.orElseSucceed(() => false)))
                yield* handle
                  .kill({ killSignal: "SIGKILL" })
                  .pipe(Effect.timeoutOption("1 second"), Effect.ignore);
            }).pipe(Effect.uninterruptible),
          ),
        ),
        // Cancellation cannot land between a successful spawn and owned cleanup.
        Effect.uninterruptible,
      );
    const stopProcess = yield* Effect.cached(
      Effect.gen(function* () {
        if (!(yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)))) return;
        if (process.platform === "win32") {
          const taskkill = NodePath.win32.join(
            options.env.SystemRoot ?? options.env.SYSTEMROOT ?? "C:\\Windows",
            "System32",
            "taskkill.exe",
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const killer = yield* spawner.spawn(
                ChildProcess.make(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
                  env: options.env,
                  extendEnv: false,
                }),
              );
              yield* killer.exitCode;
            }),
          ).pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
        } else {
          yield* child
            .kill({ killSignal: "SIGTERM" })
            .pipe(Effect.timeoutOption(grace), Effect.ignore);
        }
        if (yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)))
          yield* child
            .kill({ killSignal: "SIGKILL" })
            .pipe(Effect.timeoutOption("1 second"), Effect.ignore);
      }).pipe(Effect.uninterruptible),
    );
    // Register immediately after spawn, before streams or request bookkeeping can fail.
    yield* Scope.addFinalizer(scope, stopProcess.pipe(Effect.uninterruptible));
    const pending = new Map<
      string,
      { operation: string; reply: Deferred.Deferred<unknown, PiRpcError> }
    >();
    const events = yield* Queue.dropping<Packet, PiRpcError>(limits.queuedFrames);
    const outgoing = yield* Queue.dropping<Uint8Array, PiRpcError>(limits.queuedFrames);
    const transportDown = yield* Deferred.make<never, PiRpcError>();
    const exit = yield* Deferred.make<number, PiRpcError>();
    let failure: PiRpcError | undefined;
    let diagnosingStdoutClose = false;
    let incomingBytes = 0,
      outgoingBytes = 0,
      nextId = 0;
    const failTransport = (reason: PiRpcError) =>
      Effect.gen(function* () {
        if (failure) return;
        failure = reason;
        yield* Deferred.fail(transportDown, reason);
        for (const entry of pending.values()) yield* Deferred.fail(entry.reply, reason);
        pending.clear();
        yield* Queue.fail(events, reason);
        yield* Queue.fail(outgoing, reason);
        yield* stopProcess;
      });
    yield* Scope.addFinalizer(scope, failTransport(error("close", "The Pi transport was closed.")));
    const route = (record: PiRpcRecord, bytes: number) =>
      Effect.gen(function* () {
        if (
          record.type === "response" &&
          typeof record.id === "string" &&
          record.id.startsWith("f5-rpc:")
        ) {
          const request = typeof record.id === "string" ? pending.get(record.id) : undefined;
          if (!request) return; // A late host request is not a turn acknowledgement.
          pending.delete(record.id as string);
          if (record.success === true) yield* Deferred.succeed(request.reply, record.data);
          else
            yield* Deferred.fail(
              request.reply,
              error(request.operation, "Pi rejected the request."),
            );
          return;
        }
        if (incomingBytes + bytes > limits.bufferedBytes)
          return yield* failTransport(error("read", "The Pi event buffer is full."));
        incomingBytes += bytes;
        const accepted = yield* Queue.offer(events, { record, bytes });
        if (!accepted) yield* failTransport(error("read", "The Pi event queue is full."));
      });
    const readLine = (line: string) =>
      Effect.gen(function* () {
        assertJsonSourceWithinLimits(line);
        let record: unknown;
        try {
          record = decode(line);
        } catch {
          return;
        }
        if (
          record === null ||
          typeof record !== "object" ||
          Array.isArray(record) ||
          typeof (record as PiRpcRecord).type !== "string"
        )
          return;
        yield* route(record as PiRpcRecord, Buffer.byteLength(line, "utf8"));
      });
    // Capture exit independently; stdout is drained before pending calls receive EOF.
    yield* child.exitCode.pipe(
      Effect.matchEffect({
        onSuccess: (code) =>
          Deferred.succeed(exit, Number(code)).pipe(
            Effect.andThen(Effect.sleep(250)),
            Effect.andThen(failTransport(error("exit", `Pi exited with code ${Number(code)}.`))),
          ),
        onFailure: () =>
          Deferred.fail(exit, error("exit", "The Pi process was interrupted.")).pipe(
            Effect.andThen(Effect.sleep(250)),
            Effect.andThen(failTransport(error("exit", "The Pi process was interrupted."))),
          ),
      }),
      Effect.forkIn(scope),
    );
    yield* Effect.gen(function* () {
      const framer = new PiLineFramer(limits.frameBytes);
      yield* Stream.runForEach(child.stdout, (chunk) =>
        Effect.gen(function* () {
          for (const line of framer.push(chunk)) yield* readLine(line);
        }),
      );
      const trailing = framer.finish();
      if (trailing) yield* readLine(trailing);
      diagnosingStdoutClose = true;
      const code = yield* Deferred.await(exit).pipe(
        Effect.timeoutOption(250),
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      yield* failTransport(
        error(
          "read",
          Option.isSome(code)
            ? `Pi exited with code ${code.value}.`
            : "Pi closed its output stream.",
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : failTransport(error("read", "The Pi output stream failed or exceeded its byte limit.")),
      ),
      Effect.forkIn(scope),
    );
    yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.tap((bytes) =>
        Effect.sync(() => {
          outgoingBytes -= bytes.length;
        }),
      ),
      Stream.run(child.stdin),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : diagnosingStdoutClose
            ? Effect.void
            : Effect.gen(function* () {
                const code = yield* Deferred.await(exit).pipe(
                  Effect.timeoutOption(250),
                  Effect.orElseSucceed(() => Option.none<number>()),
                );
                yield* failTransport(
                  error(
                    "write",
                    Option.isSome(code)
                      ? `Pi exited with code ${code.value}.`
                      : "The Pi input stream failed.",
                  ),
                );
              }),
      ),
      Effect.forkIn(scope),
    );
    const encoder = new TextEncoder();
    const send = (record: PiRpcRecord): Effect.Effect<void, PiRpcError> =>
      Effect.gen(function* () {
        if (failure) return yield* failure;
        const text = stringifyWithinBytes(record, limits.frameBytes - 1);
        if (text === undefined)
          return yield* error("write", "The Pi request exceeds its byte or structure limit.");
        const bytes = encoder.encode(text + "\n");
        if (outgoingBytes + bytes.length > limits.bufferedBytes) {
          yield* failTransport(error("write", "The Pi request buffer is full."));
          return yield* failure!;
        }
        outgoingBytes += bytes.length;
        const accepted = yield* Queue.offer(outgoing, bytes);
        if (!accepted) {
          yield* failTransport(error("write", "The Pi request queue is full."));
          return yield* failure!;
        }
      });
    const request: PiRpcConnection["request"] = (record, timeoutMs = 30_000) =>
      Effect.gen(function* () {
        const operation = typeof record.type === "string" ? record.type : "request";
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
          return yield* error(operation, "The Pi request deadline is invalid.");
        if (failure) return yield* failure;
        if (pending.size >= limits.pendingRequests)
          return yield* error(operation, "Too many Pi requests are pending.");
        const id = `f5-rpc:${nextId++}`;
        const reply = yield* Deferred.make<unknown, PiRpcError>();
        pending.set(id, { operation, reply });
        return yield* send({ ...record, id }).pipe(
          Effect.andThen(Effect.raceFirst(Deferred.await(reply), Deferred.await(transportDown))),
          Effect.timeoutOrElse({
            duration: timeoutMs,
            onTimeout: () => Effect.fail(new PiRpcTimeoutError({ operation, timeoutMs })),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(id);
            }),
          ),
        );
      });
    return {
      pid: Number(child.pid),
      send,
      request,
      events: Stream.fromQueue(events).pipe(
        Stream.tap((packet) =>
          Effect.sync(() => {
            incomingBytes -= packet.bytes;
          }),
        ),
        Stream.map((packet) => packet.record),
      ),
      exited: Deferred.await(exit),
      terminate: failTransport(error("terminate", "The Pi process was stopped.")).pipe(
        Effect.andThen(stopProcess),
        Effect.uninterruptible,
      ),
    } satisfies PiRpcConnection;
  });
