import { tmpdir } from "node:os";
import { ApprovalRequestId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, Option, Queue, Scope, Stream } from "effect";
import { expect, it } from "vitest";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import { run } from "../pi/PiMetadata.testkit.ts";
import { fixture, threadId } from "../pi/PiAdapter.testkit.ts";
import { PiRpcError } from "../pi/PiRpc.ts";
import { makePiAdapter, parsePiResumeCursor } from "./PiAdapter.ts";

// "streaming": native work started before its wake reached F5, so Pi must queue the prompt.
it.each(["normal", "abort", "reject", "crash", "slash", "final-only", "tool", "streaming"])(
  "owns a Pi child, correlates completion and closes the session: %s",
  async (mode) =>
    fixture(async ({ settings, options, trace }) => {
      options.environment.F5_PI_CASE = mode;
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* makePiAdapter(settings, options);
            const terminal = yield* Deferred.make<ProviderRuntimeEvent>();
            const observed: ProviderRuntimeEvent[] = [];
            yield* adapter.streamEvents.pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  observed.push(event);
                  if (event.type === "turn.completed") yield* Deferred.succeed(terminal, event);
                }),
              ),
              Effect.forkScoped,
            );
            const session = yield* adapter.startSession({
              threadId,
              cwd: tmpdir(),
              runtimeMode: "approval-required",
            });
            expect(parsePiResumeCursor(session.resumeCursor)).toBeDefined();
            const turn = yield* adapter.sendTurn({
              threadId,
              input: mode === "slash" ? "/reload" : "Hello Pi",
            });
            const completed = yield* Deferred.await(terminal).pipe(Effect.timeout("5 seconds"));
            expect(completed.turnId).toBe(turn.turnId);
            if (completed.type !== "turn.completed") throw new Error("Expected completion.");
            expect(completed.payload.state).toBe(
              mode === "abort"
                ? "cancelled"
                : mode === "reject" || mode === "crash"
                  ? "failed"
                  : "completed",
            );
            expect(JSON.stringify(observed)).not.toContain("PRIVATE_FAILURE");
            if (
              mode === "normal" ||
              mode === "final-only" ||
              mode === "tool" ||
              mode === "streaming"
            ) {
              expect(
                observed.filter(
                  (event) =>
                    event.type === "item.completed" &&
                    event.payload.itemType === "assistant_message",
                ),
              ).toHaveLength(1);
              expect(
                observed.some(
                  (event) => event.type === "content.delta" && event.payload.delta === "Pi reply",
                ),
              ).toBe(true);
            }
            if (mode === "tool") {
              const tools = observed.filter(
                (event) =>
                  event.type === "item.completed" && event.payload.itemType === "command_execution",
              );
              expect(tools).toHaveLength(1);
              expect(tools[0]).toMatchObject({
                payload: {
                  status: "failed",
                  mcpImagesOmitted: 1,
                  data: { exitCode: 2 },
                  completion: { semanticSuccess: false },
                },
              });
              expect(JSON.stringify(observed)).not.toContain("aGVsbG8=");
            }
            yield* adapter.stopSession(threadId);
            expect(yield* adapter.hasSession(threadId)).toBe(false);
            expect(yield* adapter.listSessions()).toEqual([]);
          }),
        ),
      );
      for (const record of (await trace()).filter((record) => record.type === "spawn"))
        expect(() => process.kill(Number(record.pid), 0)).toThrow();
    }),
);
it("answers a setup dialog while model selection is waiting for its RPC reply", async () =>
  fixture(async ({ settings, options }) => {
    options.environment.F5_PI_CASE = "start-dialog";
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makePiAdapter(settings, options);
          const approvals: string[] = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event.type === "request.opened" && event.requestId) {
                  approvals.push(event.requestId);
                  yield* adapter.respondToRequest(
                    threadId,
                    ApprovalRequestId.make(event.requestId),
                    "accept",
                  );
                }
              }),
            ),
            Effect.forkScoped,
          );
          const session = yield* adapter
            .startSession({
              threadId,
              cwd: tmpdir(),
              runtimeMode: "approval-required",
              model: "vendor/model",
            })
            .pipe(Effect.timeout("5 seconds"));
          expect(session.status).toBe("ready");
          expect(approvals).toHaveLength(1);
        }),
      ),
    );
  }));
it("refuses account changes before spawning or accepting a fresh session", async () =>
  fixture(async ({ settings, options, trace }) => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makePiAdapter(settings, {
            ...options,
            beforeLaunch: Effect.fail(
              new PiRpcError({ operation: "account", detail: "Account change in progress." }),
            ),
          });
          expect(
            (yield* adapter
              .startSession({ threadId, cwd: tmpdir(), runtimeMode: "approval-required" })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(yield* adapter.listSessions()).toEqual([]);
        }),
      ),
    );
    await expect(trace()).rejects.toThrow();
  }));
it("rejects malformed resume metadata instead of silently starting an unrelated conversation", () => {
  expect(
    parsePiResumeCursor({
      schemaVersion: 1,
      sessionFile: "relative.jsonl",
      leafId: null,
      boundaries: [],
    }),
  ).toBeUndefined();
  expect(
    parsePiResumeCursor({
      schemaVersion: 1,
      sessionFile: "/session.jsonl",
      leafId: null,
      boundaries: [
        { turnId: "t", entryId: "u" },
        { turnId: "t", entryId: "u" },
      ],
    }),
  ).toBeUndefined();
});

it("reaps an interrupted startup when its provider instance is replaced and refuses later starts", async () =>
  fixture(async ({ settings, options, trace }) => {
    options.environment.F5_PI_CASE = "hang-start";
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const driverScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(driverScope, Exit.void));
          const adapter = yield* Scope.provide(makePiAdapter(settings, options), driverScope);
          const startup = yield* adapter
            .startSession({ threadId, cwd: tmpdir(), runtimeMode: "approval-required" })
            .pipe(Effect.forkChild);
          yield* Effect.gen(function* () {
            for (;;) {
              const records = yield* Effect.tryPromise(trace).pipe(Effect.orElseSucceed(() => []));
              if (records.some((record) => record.type === "get_commands")) break;
              yield* Effect.sleep(10);
            }
          }).pipe(Effect.timeout("5 seconds"));
          yield* Scope.close(driverScope, Exit.void);
          expect((yield* Fiber.await(startup))._tag).toBe("Failure");
          expect(yield* adapter.listSessions()).toEqual([]);
          expect(
            (yield* adapter
              .startSession({ threadId, cwd: tmpdir(), runtimeMode: "approval-required" })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }),
      ),
    );
    for (const record of (await trace()).filter((record) => record.type === "spawn"))
      expect(() => process.kill(Number(record.pid), 0)).toThrow();
  }));

it.each(["normal", "fork-wrong-boundary", "fork-state-failure"])(
  "verifies native rewinds, persists adoption before hydration and never replays an uncertain fork: %s",
  async (mode) =>
    fixture(async ({ settings, options, trace }) => {
      options.environment.F5_PI_CASE = mode;
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* makePiAdapter(settings, options);
            const ended = new Map<string, Deferred.Deferred<void>>();
            yield* adapter.streamEvents.pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "turn.completed" && event.turnId) {
                    const done = ended.get(event.turnId);
                    if (done) yield* Deferred.succeed(done, undefined);
                  }
                }),
              ),
              Effect.forkScoped,
            );
            yield* adapter.startSession({
              threadId,
              cwd: tmpdir(),
              runtimeMode: "approval-required",
            });
            const ids: string[] = [];
            for (const input of ["First prompt", "Second prompt"]) {
              const turn = yield* adapter.sendTurn({ threadId, input });
              const done = yield* Deferred.make<void>();
              ended.set(turn.turnId, done);
              ids.push(turn.turnId);
              yield* Deferred.await(done).pipe(Effect.timeout("5 seconds"));
            }
            expect((yield* adapter.readThread(threadId)).turns.map((turn) => turn.id)).toEqual(ids);
            const adopted: unknown[] = [];
            const rollback = {
              beforeTurnId: ids[1]!,
              onAdoptSession: async (session: import("@t3tools/contracts").ProviderSession) => {
                adopted.push(session.resumeCursor);
              },
            };
            const result = yield* adapter.rollbackThread(threadId, 1, rollback).pipe(Effect.result);
            expect(adopted).toHaveLength(mode === "fork-state-failure" ? 0 : 1);
            if (adopted.length)
              expect(parsePiResumeCursor(adopted[0])?.rewindBeforeTurnId).toBe(ids[1]);
            expect(result._tag).toBe(mode === "normal" ? "Success" : "Failure");
            if (result._tag === "Success")
              expect(result.success.turns.map((turn) => turn.id)).toEqual([ids[0]]);
            if (mode !== "normal") {
              expect(
                (yield* adapter
                  .sendTurn({ threadId, input: "Must remain blocked" })
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
              expect(
                (yield* adapter
                  .startSession({ threadId, cwd: tmpdir(), runtimeMode: "approval-required" })
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
            }
            const retried = yield* adapter
              .rollbackThread(threadId, 1, rollback)
              .pipe(Effect.result);
            expect(retried._tag).toBe(mode === "normal" ? "Success" : "Failure");
            expect(
              (yield* Effect.tryPromise(trace)).filter((record) => record.type === "fork"),
            ).toHaveLength(1);
          }),
        ),
      );
    }),
);

it("keeps read-only workflow sessions restricted and refuses a mode change before prompt delivery", async () =>
  fixture(async ({ settings, options, trace }) => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makePiAdapter(settings, options);
          yield* adapter.startSession({
            threadId,
            cwd: tmpdir(),
            runtimeMode: "full-access",
            workflowExecutionProfile: "unattended-readonly",
          });
          const refused = yield* adapter
            .sendTurn({ threadId, input: "Must not send", interactionMode: "default" })
            .pipe(Effect.result);
          expect(refused._tag).toBe("Failure");
          if (refused._tag === "Failure")
            expect(refused.failure).toMatchObject({ deliveryCertainty: "not_sent" });
          yield* adapter.stopSession(threadId);
        }),
      ),
    );
    const records = await trace();
    expect(
      records.filter(
        (record) => record.type === "spawn" && !String(record.args).includes("--version"),
      )[0]?.readOnly,
    ).toBe(true);
    expect(records.filter((record) => record.type === "prompt")).toHaveLength(0);
  }));

it("requires model read-back and reports a known unsent prompt when selection diverges", async () =>
  fixture(async ({ settings, options, trace }) => {
    options.environment.F5_PI_CASE = "wrong-model-readback";
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makePiAdapter(settings, options);
          yield* adapter.startSession({
            threadId,
            cwd: tmpdir(),
            runtimeMode: "approval-required",
          });
          const result = yield* adapter
            .sendTurn({
              threadId,
              input: "Never send",
              modelSelection: { instanceId: options.instanceId, model: "two/shared" },
            })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({
              deliveryCertainty: "not_sent",
              deliveryRetryable: false,
            });
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          expect(
            (yield* adapter.sendTurn({ threadId, input: "Still blocked" }).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          yield* adapter.stopSession(threadId);
        }),
      ),
    );
    expect((await trace()).filter((record) => record.type === "prompt")).toHaveLength(0);
  }));

it("closes a backpressured event stream before waiting for owned session cleanup", async () =>
  fixture(async ({ settings, options, trace }) => {
    options.environment.F5_PI_CASE = "flood";
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* Scope.make("sequential");
          const adapter = yield* makePiAdapter(settings, options).pipe(Scope.provide(owner));
          yield* adapter.streamEvents.pipe(
            Stream.runForEach(() => Effect.never),
            Effect.forkScoped,
          );
          yield* adapter.startSession({
            threadId,
            cwd: tmpdir(),
            runtimeMode: "approval-required",
          });
          yield* adapter.sendTurn({ threadId, input: "Flood fixture" });
          yield* Effect.repeat(
            Effect.tryPromise(trace).pipe(
              Effect.flatMap((records) =>
                records.some((record) => record.type === "flood-done")
                  ? Effect.succeed(true)
                  : Effect.sleep("10 millis").pipe(Effect.as(false)),
              ),
            ),
            { until: (done) => done },
          ).pipe(Effect.timeout("5 seconds"));
          // A backpressured close never finishes; Windows tree kills alone may take 2 seconds.
          yield* Scope.close(owner, Exit.void).pipe(Effect.timeout("5 seconds"));
        }),
      ),
    );
    for (const record of (await trace()).filter((record) => record.type === "spawn"))
      expect(() => process.kill(Number(record.pid), 0)).toThrow();
  }));

it.each(["native-rewind", "native-switch"])(
  "blocks new prompts after an uncoordinated Pi history mutation: %s",
  async (mode) =>
    fixture(async ({ settings, options }) => {
      options.environment.F5_PI_CASE = mode;
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* makePiAdapter(settings, options);
            const terminal = yield* Queue.unbounded<ProviderRuntimeEvent>();
            yield* adapter.streamEvents.pipe(
              Stream.runForEach((event) =>
                event.type === "turn.completed"
                  ? Queue.offer(terminal, event).pipe(Effect.asVoid)
                  : Effect.void,
              ),
              Effect.forkScoped,
            );
            yield* adapter.startSession({
              threadId,
              cwd: tmpdir(),
              runtimeMode: "approval-required",
            });
            for (const input of ["First", "Second"]) {
              yield* adapter.sendTurn({ threadId, input });
              const event = yield* Queue.take(terminal).pipe(Effect.timeout("5 seconds"));
              expect(event.type === "turn.completed" && event.payload.state).toBe(
                input === "First" ? "completed" : "failed",
              );
            }
            const rejected = yield* adapter
              .sendTurn({ threadId, input: "Must stay blocked" })
              .pipe(Effect.result);
            expect(rejected._tag).toBe("Failure");
            expect(yield* adapter.hasSession(threadId)).toBe(false);
            yield* adapter.stopSession(threadId);
          }),
        ),
      );
    }),
);

it.each([true, false])(
  "requires native rewind projection acknowledgement before reopening prompts: %s",
  async (accepted) =>
    fixture(async ({ settings, options, trace }) => {
      options.environment.F5_PI_CASE = "native-rewind-deep";
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const reconciliations: import("../ProviderNativeHistory.ts").NativeHistoryReconciliation[] =
              [];
            const adapter = yield* makePiAdapter(settings, {
              ...options,
              reconcileNativeHistory: (request) =>
                Effect.gen(function* () {
                  expect(yield* request.isCurrent).toBe(true);
                  reconciliations.push(request);
                  return accepted;
                }),
            });
            const completed = yield* Queue.unbounded<ProviderRuntimeEvent>();
            yield* adapter.streamEvents.pipe(
              Stream.runForEach((event) =>
                event.type === "turn.completed"
                  ? Queue.offer(completed, event).pipe(Effect.asVoid)
                  : Effect.void,
              ),
              Effect.forkScoped,
            );
            yield* adapter.startSession({
              threadId,
              cwd: tmpdir(),
              runtimeMode: "approval-required",
            });
            const turns: string[] = [];
            for (const input of ["First", "Second", "Rewind natively"]) {
              yield* adapter.sendTurn({ threadId, input });
              const event = yield* Queue.take(completed).pipe(Effect.timeout("5 seconds"));
              expect(event.type).toBe("turn.completed");
              if (event.type !== "turn.completed") throw new Error("Missing terminal event");
              turns.push(event.turnId!);
              expect(event.payload.state).toBe(
                input === "Rewind natively" && !accepted ? "failed" : "completed",
              );
            }
            expect(reconciliations).toHaveLength(1);
            expect(reconciliations[0]?.removedTurnIds).toEqual([turns[1]]);
            expect(reconciliations[0]?.turnId).toBe(turns[2]);
            expect(yield* adapter.hasSession(threadId)).toBe(accepted);
            const readback = yield* adapter.readThread(threadId);
            expect(readback.turns.map((turn) => turn.id)).toEqual([turns[0]]);
            expect(
              (yield* Effect.promise(trace)).filter((record) => record.type === "fork"),
            ).toHaveLength(0);
            yield* adapter.stopSession(threadId);
          }),
        ),
      );
    }),
);

it("adopts an exact native extension wake without another prompt and fences competing or stale sends", async () =>
  fixture(async ({ settings, options, trace }) => {
    options.environment.F5_PI_CASE = "wake";
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const offered = yield* Deferred.make<ProviderContinuationRequest>();
          const adapter = yield* makePiAdapter(settings, {
            ...options,
            offerContinuation: (request) =>
              Deferred.succeed(offered, request).pipe(Effect.as(true)),
          });
          const terminal = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const observed: ProviderRuntimeEvent[] = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => {
              observed.push(event);
              return event.type === "turn.completed"
                ? Queue.offer(terminal, event).pipe(Effect.asVoid)
                : Effect.void;
            }),
            Effect.forkScoped,
          );
          yield* adapter.startSession({
            threadId,
            cwd: tmpdir(),
            runtimeMode: "approval-required",
          });
          const first = yield* adapter.sendTurn({ threadId, input: "Original user prompt" });
          yield* Queue.take(terminal).pipe(Effect.timeout("5 seconds"));
          const request = yield* Deferred.await(offered).pipe(Effect.timeout("5 seconds"));
          expect(request.previousTurnId).toBe(first.turnId);
          expect(yield* request.status).toBe("pending");
          expect((yield* adapter.readThread(threadId).pipe(Effect.result))._tag).toBe("Failure");
          expect((yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          const competing = yield* adapter
            .sendTurn({ threadId, input: "Human input must wait" })
            .pipe(Effect.result);
          expect(competing._tag).toBe("Failure");
          if (competing._tag === "Failure")
            expect(competing.failure).toMatchObject({
              deliveryCertainty: "not_sent",
              deliveryRetryable: true,
            });
          const wrong = yield* adapter
            .sendTurn({ threadId, input: "Wrong wake", continuationRequestId: "old-request" })
            .pipe(Effect.result);
          expect(wrong._tag).toBe("Failure");
          const adopted = yield* adapter.sendTurn({
            threadId,
            input: "Internal continuation placeholder",
            continuationRequestId: request.requestId,
          });
          const ended = yield* Queue.take(terminal).pipe(Effect.timeout("5 seconds"));
          expect(ended).toMatchObject({
            type: "turn.completed",
            turnId: adopted.turnId,
            payload: { state: "completed" },
          });
          expect(yield* request.status).toBe("adopted");
          expect(
            observed.some(
              (event) =>
                event.type === "content.delta" &&
                event.turnId === adopted.turnId &&
                event.payload.delta === "Native reply",
            ),
          ).toBe(true);
          expect(
            Option.isNone(
              yield* request.dispatchIfCurrent(Effect.succeed("must not dispatch twice")),
            ),
          ).toBe(true);
          yield* request.clearIfCurrent;
          expect(yield* adapter.hasSession(threadId)).toBe(true);
          expect((yield* adapter.readThread(threadId)).turns.map((turn) => turn.id)).toEqual([
            first.turnId,
            adopted.turnId,
          ]);
          const next = yield* adapter.sendTurn({ threadId, input: "After native continuation" });
          yield* Queue.take(terminal).pipe(Effect.timeout("5 seconds"));
          const rollback = { beforeTurnId: next.turnId };
          const retained = yield* adapter.rollbackThread(threadId, 1, rollback);
          expect(retained.turns.map((turn) => turn.id)).toEqual([first.turnId, adopted.turnId]);
          expect(JSON.stringify(retained.turns[1])).toContain("Native reply");
          expect(
            (yield* adapter.rollbackThread(threadId, 1, rollback)).turns.map((turn) => turn.id),
          ).toEqual([first.turnId, adopted.turnId]);
          expect(
            (yield* adapter
              .rollbackThread(threadId, 1, { beforeTurnId: adopted.turnId })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          const replay = yield* adapter
            .sendTurn({ threadId, input: "Never replay", continuationRequestId: request.requestId })
            .pipe(Effect.result);
          expect(replay._tag).toBe("Failure");
          yield* adapter.stopSession(threadId);
        }),
      ),
    );
    expect((await trace()).filter((record) => record.type === "prompt")).toMatchObject([
      { message: "Original user prompt" },
      { message: "After native continuation" },
    ]);
    expect((await trace()).filter((record) => record.type === "fork")).toHaveLength(1);
  }));

it("retires a declined native continuation without replaying it into a replacement session", async () =>
  fixture(async ({ settings, options, trace }) => {
    options.environment.F5_PI_CASE = "wake";
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const offered = yield* Deferred.make<ProviderContinuationRequest>();
          const adapter = yield* makePiAdapter(settings, {
            ...options,
            offerContinuation: (request) =>
              Deferred.succeed(offered, request).pipe(Effect.as(true)),
          });
          yield* adapter.streamEvents.pipe(Stream.runDrain, Effect.forkScoped);
          yield* adapter.startSession({
            threadId,
            cwd: tmpdir(),
            runtimeMode: "approval-required",
          });
          yield* adapter.sendTurn({ threadId, input: "Original user prompt" });
          const request = yield* Deferred.await(offered).pipe(Effect.timeout("5 seconds"));
          yield* request.clearIfCurrent;
          expect(yield* request.status).toBe("closed");
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          yield* adapter.startSession({
            threadId,
            cwd: tmpdir(),
            runtimeMode: "approval-required",
          });
          yield* request.clearIfCurrent;
          expect(yield* adapter.hasSession(threadId)).toBe(true);
          expect(Option.isNone(yield* request.dispatchIfCurrent(Effect.succeed("stale")))).toBe(
            true,
          );
          yield* adapter.stopSession(threadId);
        }),
      ),
    );
    expect((await trace()).filter((record) => record.type === "prompt")).toHaveLength(1);
  }));
