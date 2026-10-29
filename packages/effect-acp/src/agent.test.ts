import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { assert, it } from "@effect/vitest";

import * as AcpAgent from "./agent";
import * as AcpSchema from "./_generated/schema.gen";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared";
import { makeInMemoryStdio } from "./_internal/stdio";

const RequestPermissionRequest = jsonRpcRequest(
  "session/request_permission",
  AcpSchema.RequestPermissionRequest,
);
const InitializeRequest = jsonRpcRequest("initialize", AcpSchema.InitializeRequest);
const InitializeResponse = jsonRpcResponse(AcpSchema.InitializeResponse);
const RequestPermissionResponse = jsonRpcResponse(AcpSchema.RequestPermissionResponse);
const SessionCancelNotification = jsonRpcNotification(
  "session/cancel",
  AcpSchema.CancelNotification,
);
const ExtPingNotification = jsonRpcNotification("x/ping", Schema.Struct({ count: Schema.Number }));
const ExtRequest = jsonRpcRequest("x/test", Schema.Struct({ hello: Schema.String }));
const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));

it.effect("effect-acp agent handles core agent requests and outbound client requests", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const cancelNotifications = yield* Ref.make<Array<string>>([]);
    const extNotifications = yield* Ref.make<Array<number>>([]);
    const cancelReceived = yield* Deferred.make<void>();
    const extReceived = yield* Deferred.make<void>();
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(AcpAgent.layer(stdio), scope);

    yield* Effect.gen(function* () {
      const agent = yield* AcpAgent.AcpAgent;

      yield* agent.handleInitialize(() =>
        Effect.succeed({
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: {
            name: "mock-agent",
            version: "0.0.0",
          },
        }),
      );
      yield* agent.handleCancel((notification) =>
        Ref.update(cancelNotifications, (current) => [...current, notification.sessionId]).pipe(
          Effect.andThen(Deferred.succeed(cancelReceived, undefined)),
        ),
      );
      yield* agent.handleExtNotification(
        "x/ping",
        Schema.Struct({ count: Schema.Number }),
        (payload) =>
          Ref.update(extNotifications, (current) => [...current, payload.count]).pipe(
            Effect.andThen(Deferred.succeed(extReceived, undefined)),
          ),
      );

      const permissionFiber = yield* agent.client
        .requestPermission({
          sessionId: "session-1",
          toolCall: {
            toolCallId: "tool-1",
            title: "Allow mock action",
          },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        })
        .pipe(Effect.forkScoped);

      const permissionRequest = yield* Schema.decodeEffect(
        Schema.fromJsonString(RequestPermissionRequest),
      )(yield* Queue.take(output));
      assert.equal(permissionRequest.jsonrpc, "2.0");
      assert.equal(permissionRequest.method, "session/request_permission");
      assert.deepEqual(permissionRequest.params, {
        sessionId: "session-1",
        toolCall: {
          toolCallId: "tool-1",
          title: "Allow mock action",
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      assert.deepEqual(permissionRequest.headers, []);

      yield* Queue.offer(
        input,
        yield* encodeJsonl(RequestPermissionResponse, {
          jsonrpc: "2.0",
          id: permissionRequest.id,
          result: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        }),
      );

      const permission = yield* Fiber.join(permissionFiber);
      assert.equal(permission.outcome.outcome, "selected");

      yield* Queue.offer(
        input,
        yield* encodeJsonl(InitializeRequest, {
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: {
              name: "effect-acp-test",
              version: "0.0.0",
            },
          },
          headers: [],
        }),
      );

      const initResponse = yield* Schema.decodeEffect(Schema.fromJsonString(InitializeResponse))(
        yield* Queue.take(output),
      );
      assert.deepEqual(initResponse, {
        jsonrpc: "2.0",
        id: 2,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: {
            name: "mock-agent",
            version: "0.0.0",
          },
        },
      });

      yield* Queue.offer(
        input,
        yield* encodeJsonl(SessionCancelNotification, {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId: "session-1",
          },
        }),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtPingNotification, {
          jsonrpc: "2.0",
          method: "x/ping",
          params: { count: 2 },
        }),
      );

      yield* Deferred.await(cancelReceived);
      yield* Deferred.await(extReceived);
      assert.deepEqual(yield* Ref.get(cancelNotifications), ["session-1"]);
      assert.deepEqual(yield* Ref.get(extNotifications), [2]);
    }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
  }),
);

it.effect("effect-acp agent keeps RPC ids within int32 and apart from extension ids", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(AcpAgent.layer(stdio), scope);

    yield* Effect.gen(function* () {
      const agent = yield* AcpAgent.AcpAgent;

      const permissionFiber = yield* agent.client
        .requestPermission({
          sessionId: "session-1",
          toolCall: {
            toolCallId: "tool-1",
            title: "Allow mock action",
          },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        })
        .pipe(Effect.forkScoped);
      const extFiber = yield* agent.client
        .extRequest("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);

      const firstOutbound = yield* Queue.take(output);
      const secondOutbound = yield* Queue.take(output);

      const decodedPermission = Schema.decodeEffect(
        Schema.fromJsonString(RequestPermissionRequest),
      );
      const decodedExt = Schema.decodeEffect(Schema.fromJsonString(ExtRequest));
      const firstIsPermission = yield* decodedPermission(firstOutbound).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: () => true,
        }),
      );

      const permissionRequest = firstIsPermission
        ? yield* decodedPermission(firstOutbound)
        : yield* decodedPermission(secondOutbound);
      const extRequest = firstIsPermission
        ? yield* decodedExt(secondOutbound)
        : yield* decodedExt(firstOutbound);

      assert.notEqual(permissionRequest.id, extRequest.id);
      // Kotlin ACP SDK clients decode ids as signed int32.
      assert.equal(Number(permissionRequest.id), 2 ** 30);
      assert.isAtMost(Number(permissionRequest.id), 2 ** 31 - 1);
      assert.equal(Number(extRequest.id), 1);

      yield* Queue.offer(
        input,
        yield* encodeJsonl(RequestPermissionResponse, {
          jsonrpc: "2.0",
          id: permissionRequest.id,
          result: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        }),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: extRequest.id,
          result: { ok: true },
        }),
      );

      const permission = yield* Fiber.join(permissionFiber);
      assert.equal(permission.outcome.outcome, "selected");
      assert.deepEqual(yield* Fiber.join(extFiber), { ok: true });

      const nextPermissionFiber = yield* agent.client
        .requestPermission(permissionRequest.params)
        .pipe(Effect.forkScoped);
      const nextPermissionRequest = yield* decodedPermission(yield* Queue.take(output));
      assert.equal(Number(nextPermissionRequest.id), 2 ** 30 + 1);
      yield* Queue.offer(
        input,
        yield* encodeJsonl(RequestPermissionResponse, {
          jsonrpc: "2.0",
          id: nextPermissionRequest.id,
          result: { outcome: { outcome: "cancelled" } },
        }),
      );
      assert.equal((yield* Fiber.join(nextPermissionFiber)).outcome.outcome, "cancelled");
    }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
  }),
);

it.effect.each([0, 2 ** 30, 2 ** 32])(
  "effect-acp agent answers incoming id %s independently of outbound ids",
  (requestId) =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(AcpAgent.layer(stdio), scope);

      yield* Effect.gen(function* () {
        const agent = yield* AcpAgent.AcpAgent;
        yield* agent.handleInitialize(() =>
          Effect.succeed({
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "mock-agent", version: "0.0.0" },
          }),
        );

        // Opposite directions may reuse an id even while a request is pending.
        const outboundFiber = yield* agent.client
          .requestPermission({
            sessionId: "session-1",
            toolCall: { toolCallId: "tool-1", title: "Allow mock action" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          })
          .pipe(Effect.forkScoped);
        const outbound = yield* Schema.decodeEffect(
          Schema.fromJsonString(RequestPermissionRequest),
        )(yield* Queue.take(output));

        yield* Queue.offer(
          input,
          yield* encodeJsonl(InitializeRequest, {
            jsonrpc: "2.0",
            id: requestId,
            method: "initialize",
            params: {
              protocolVersion: 1,
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              },
              clientInfo: { name: "effect-acp-test", version: "0.0.0" },
            },
            headers: [],
          }),
        );
        const initResponse = yield* Schema.decodeEffect(Schema.fromJsonString(InitializeResponse))(
          yield* Queue.take(output),
        );
        assert.equal(Number(initResponse.id), requestId);
        assert.equal(initResponse.result.agentInfo?.name, "mock-agent");

        yield* Queue.offer(
          input,
          yield* encodeJsonl(RequestPermissionResponse, {
            jsonrpc: "2.0",
            id: outbound.id,
            result: { outcome: { outcome: "cancelled" } },
          }),
        );
        assert.equal((yield* Fiber.join(outboundFiber)).outcome.outcome, "cancelled");
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
);
