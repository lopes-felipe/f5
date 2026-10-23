import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as AcpAgent from "./agent";
import * as AcpClient from "./client";
import * as AcpError from "./errors";
import * as AcpProtocol from "./protocol";
import { makeInMemoryStdio } from "./_internal/stdio";

const encoder = new TextEncoder();
const wire = (message: unknown) => encoder.encode(JSON.stringify(message) + "\n");
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.timeout("2 seconds")));
const failures = [
  ["defect", () => Effect.die(new Error("fixture handler defect"))],
  [
    "synchronous throw",
    () => {
      throw new Error("fixture handler construction failed");
    },
  ],
  ["typed failure", () => Effect.fail(AcpError.AcpRequestError.invalidParams("fixture failure"))],
  [
    "typed failure with cleanup defect",
    () =>
      Effect.fail(AcpError.AcpRequestError.invalidParams("fixture failure")).pipe(
        Effect.ensuring(Effect.die(new Error("fixture cleanup defect"))),
      ),
  ],
] as const;

for (const [name, fail] of failures) {
  it(`keeps reading responses after a notification ${name}`, () =>
    run(
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const protocol = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
          onNotification: fail,
        });
        const pending = yield* protocol.request("x/pending", {}).pipe(Effect.forkScoped);
        const request = JSON.parse(yield* Queue.take(output));
        yield* Queue.offer(input, wire({ jsonrpc: "2.0", method: "x/notice", params: {} }));
        yield* Queue.offer(input, wire({ jsonrpc: "2.0", id: request.id, result: "received" }));
        expect(yield* Fiber.join(pending)).toBe("received");
      }),
    ));

  it(`answers only the failed extension request after a ${name}`, () =>
    run(
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const protocol = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
          onExtRequest: (method) => (method === "x/bad" ? fail() : Effect.succeed("ok")),
        });
        const pending = yield* protocol.request("x/pending", {}).pipe(Effect.forkScoped);
        const request = JSON.parse(yield* Queue.take(output));
        yield* Queue.offer(input, wire({ jsonrpc: "2.0", id: 41, method: "x/bad", params: {} }));
        const failure = JSON.parse(yield* Queue.take(output));
        expect(failure.id).toBe(41);
        expect(failure).toHaveProperty("error");
        if (name === "typed failure")
          expect(JSON.stringify(failure.error)).toContain("fixture failure");
        if (name === "typed failure with cleanup defect")
          expect(JSON.stringify(failure.error)).toContain("Internal error");
        yield* Queue.offer(input, wire({ jsonrpc: "2.0", id: 42, method: "x/good", params: {} }));
        expect(JSON.parse(yield* Queue.take(output))).toMatchObject({ id: 42, result: "ok" });
        yield* Queue.offer(input, wire({ jsonrpc: "2.0", id: request.id, result: "alive" }));
        expect(yield* Fiber.join(pending)).toBe("alive");
      }),
    ));

  for (const buffered of [false, true]) {
    it(`runs later client notification handlers after a ${name}, buffered=${buffered}`, () =>
      run(
        Effect.gen(function* () {
          const { stdio, input, output } = yield* makeInMemoryStdio();
          const client = yield* AcpClient.make(stdio);
          const received: string[] = [];
          if (buffered) {
            const sentinel = yield* Deferred.make<void>();
            yield* client.handleExtNotification("x/sentinel", Schema.Unknown, () =>
              Deferred.succeed(sentinel, undefined).pipe(Effect.asVoid),
            );
            yield* Queue.offer(
              input,
              wire({
                jsonrpc: "2.0",
                method: "session/update",
                params: { sessionId: "buffered", update: { sessionUpdate: "plan", entries: [] } },
              }),
            );
            yield* Queue.offer(input, wire({ jsonrpc: "2.0", method: "x/sentinel", params: {} }));
            yield* Deferred.await(sentinel);
          }
          yield* client.handleSessionUpdate(fail);
          yield* client.handleSessionUpdate((notification) =>
            Effect.sync(() => received.push(notification.sessionId)).pipe(Effect.asVoid),
          );
          yield* Queue.offer(
            input,
            wire({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: "root", update: { sessionUpdate: "plan", entries: [] } },
            }),
          );
          const pending = yield* client.raw.request("x/barrier", {}).pipe(Effect.forkScoped);
          // The response is queued after the update, so its completion fences delivery.
          const request = JSON.parse(yield* Queue.take(output));
          yield* Queue.offer(input, wire({ jsonrpc: "2.0", id: request.id, result: "alive" }));
          expect(yield* Fiber.join(pending)).toBe("alive");
          expect(received).toEqual(["root"]);
        }),
      ));
  }

  it(`runs later agent cancellation handlers after a ${name}`, () =>
    run(
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const agent = yield* AcpAgent.make(stdio);
        const received: string[] = [];
        yield* agent.handleCancel(fail);
        yield* agent.handleCancel((notification) =>
          Effect.sync(() => {
            received.push(notification.sessionId);
          }),
        );
        const pending = yield* agent.raw.request("x/barrier", {}).pipe(Effect.forkScoped);
        const request = JSON.parse(yield* Queue.take(output));
        yield* Queue.offer(
          input,
          wire({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "root" } }),
        );
        yield* Queue.offer(input, wire({ jsonrpc: "2.0", id: request.id, result: "alive" }));
        expect(yield* Fiber.join(pending)).toBe("alive");
        expect(received).toEqual(["root"]);
      }),
    ));

  for (const role of ["client", "agent"] as const) {
    it(`isolates a core ${role} request ${name} from concurrent and later requests`, () =>
      run(
        Effect.gen(function* () {
          const { stdio, input, output } = yield* makeInMemoryStdio();
          let calls = 0;
          const peer =
            role === "client" ? yield* AcpClient.make(stdio) : yield* AcpAgent.make(stdio);
          if ("handleInitialize" in peer) {
            yield* peer.handleInitialize(() =>
              ++calls === 1 ? fail() : Effect.succeed({ protocolVersion: 1 }),
            );
          } else {
            yield* peer.handleRequestPermission(() =>
              ++calls === 1 ? fail() : Effect.succeed({ outcome: { outcome: "cancelled" } }),
            );
          }
          const method = role === "client" ? "session/request_permission" : "initialize";
          const params =
            role === "client"
              ? {
                  sessionId: "root",
                  toolCall: { toolCallId: "tool" },
                  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
                }
              : { protocolVersion: 1 };
          const pending = yield* peer.raw.request("x/pending", {}).pipe(Effect.forkScoped);
          const request = JSON.parse(yield* Queue.take(output));
          yield* Queue.offer(input, wire({ jsonrpc: "2.0", id: 71, method, params }));
          const failure = JSON.parse(yield* Queue.take(output));
          expect(failure.id).toBe(71);
          expect(failure).toHaveProperty("error");
          if (name === "typed failure")
            expect(JSON.stringify(failure.error)).toContain("fixture failure");
          if (name === "typed failure with cleanup defect")
            expect(JSON.stringify(failure.error)).toContain("Internal error");
          yield* Queue.offer(input, wire({ jsonrpc: "2.0", id: 72, method, params }));
          expect(JSON.parse(yield* Queue.take(output))).toHaveProperty("result");
          yield* Queue.offer(input, wire({ jsonrpc: "2.0", id: request.id, result: "alive" }));
          expect(yield* Fiber.join(pending)).toBe("alive");
        }),
      ));
  }
}

it("fails pending and subsequent requests if a reader callback itself dies", () =>
  run(
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const protocol = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logIncoming: true,
        logger: () => Effect.die(new Error("fixture reader callback defect")),
      });
      const pending = yield* protocol.request("x/pending", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(input, wire({ jsonrpc: "2.0", method: "x/notice", params: {} }));
      const failed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () =>
              expect.fail("Expected the terminated connection to reject the request"),
          }),
        );
      const error = yield* failed(Fiber.join(pending));
      expect(Schema.is(AcpError.AcpTransportError)(error)).toBe(true);
      const later = yield* failed(protocol.request("x/later", {}));
      expect(later).toBe(error);
      expect(yield* failed(protocol.notify("x/later", {}))).toBe(error);
    }),
  ));

for (const kind of ["notification", "extension", "core"] as const) {
  it(`cancels an owned ${kind} handler and completes its finalizer on disposal`, () =>
    run(
      Effect.gen(function* () {
        const { stdio, input } = yield* makeInMemoryStdio();
        const scope = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        let finalized = false;
        const handler = () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true;
              }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
            ),
          );
        const setup =
          kind === "core"
            ? Effect.gen(function* () {
                const agent = yield* AcpAgent.make(stdio);
                yield* agent.handleInitialize(handler);
              })
            : AcpProtocol.makeAcpPatchedProtocol({
                stdio,
                serverRequestMethods: new Set(),
                ...(kind === "notification"
                  ? { onNotification: handler }
                  : { onExtRequest: handler }),
              }).pipe(Effect.asVoid);
        yield* Scope.provide(setup, scope);
        yield* Effect.gen(function* () {
          yield* Queue.offer(
            input,
            wire({
              jsonrpc: "2.0",
              ...(kind !== "notification" ? { id: 5 } : {}),
              method: kind === "core" ? "initialize" : "x/test",
              params: { protocolVersion: 1 },
            }),
          );
          yield* Deferred.await(started);
        }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
        yield* Deferred.await(stopped);
        expect(finalized).toBe(true);
      }),
    ));
}
