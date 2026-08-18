import type { WebSocket } from "ws";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { ThreadId, WS_CHANNELS } from "@t3tools/contracts";

import { makeServerPushBus, makeWebSocketSendController, pushCoalescingKey } from "./pushBus";

class MockWebSocket {
  static readonly OPEN = 1;

  readonly OPEN = MockWebSocket.OPEN;
  readyState = MockWebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  autoCompleteSends = true;
  private readonly sendCallbacks: Array<(error?: Error) => void> = [];
  private readonly waiters = new Set<() => void>();

  send(message: string, callback?: (error?: Error) => void) {
    this.sent.push(message);
    const logicalBytes = Buffer.byteLength(message);
    this.bufferedAmount += logicalBytes;
    if (callback) {
      const complete = (error?: Error) => {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - logicalBytes);
        callback(error);
      };
      if (this.autoCompleteSends) {
        complete();
      } else {
        this.sendCallbacks.push(complete);
      }
    }
    for (const waiter of this.waiters) {
      waiter();
    }
  }

  completeNextSend(error?: Error) {
    this.sendCallbacks.shift()?.(error);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closes.push({
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    for (const waiter of this.waiters) waiter();
  }

  waitForSentCount(count: number): Promise<void> {
    if (this.sent.length >= count) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const check = () => {
        if (this.sent.length < count) {
          return;
        }
        this.waiters.delete(check);
        resolve();
      };

      this.waiters.add(check);
    });
  }

  waitForClose(): Promise<void> {
    if (this.closes.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.closes.length === 0) return;
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }
}

describe("makeServerPushBus", () => {
  it("coalesces next-turn queue snapshots independently per thread", () => {
    const first = pushCoalescingKey(WS_CHANNELS.nextTurnQueueUpdated, {
      threadId: ThreadId.makeUnsafe("thread-a"),
      items: [],
      revision: 1,
      paused: false,
      blockedKind: null,
      reasonCode: null,
      reasonDetail: null,
      maxItems: 20,
      quarantinedCount: 0,
    });
    const second = pushCoalescingKey(WS_CHANNELS.nextTurnQueueUpdated, {
      threadId: ThreadId.makeUnsafe("thread-b"),
      items: [],
      revision: 1,
      paused: false,
      blockedKind: null,
      reasonCode: null,
      reasonDetail: null,
      maxItems: 20,
      quarantinedCount: 0,
    });

    expect(first).not.toBe(second);
  });

  it.live("waits for the welcome push before a new client joins broadcast delivery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = new MockWebSocket();
        const clients = yield* Ref.make(new Set<WebSocket>());
        const pushBus = yield* makeServerPushBus({
          clients,
          logOutgoingPush: () => {},
        });

        yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: [{ kind: "keybindings.malformed-config", message: "queued-before-connect" }],
          providers: [],
        });

        const delivered = yield* pushBus.publishClient(
          client as unknown as WebSocket,
          WS_CHANNELS.serverWelcome,
          {
            cwd: "/tmp/project",
            projectName: "project",
          },
        );
        expect(delivered).toBe(true);

        yield* Ref.update(clients, (current) => current.add(client as unknown as WebSocket));

        yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: [],
          providers: [],
        });

        yield* Effect.promise(() => client.waitForSentCount(2));

        const messages = client.sent.map(
          (message) => JSON.parse(message) as { channel: string; data: unknown },
        );

        expect(messages).toHaveLength(2);
        expect(messages[0]).toEqual({
          type: "push",
          sequence: 2,
          channel: WS_CHANNELS.serverWelcome,
          data: {
            cwd: "/tmp/project",
            projectName: "project",
          },
        });
        expect(messages[1]).toEqual({
          type: "push",
          sequence: 3,
          channel: WS_CHANNELS.serverConfigUpdated,
          data: {
            issues: [],
            providers: [],
          },
        });
      }),
    ),
  );

  it.live("keeps only the latest coalescible snapshot while delivery is backpressured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = new MockWebSocket();
        const clients = yield* Ref.make(new Set([client as unknown as WebSocket]));
        const welcomeSendStarted = yield* Deferred.make<void, never>();
        const releaseWelcomeSend = yield* Deferred.make<void, never>();
        const pushBus = yield* makeServerPushBus({
          clients,
          logOutgoingPush: () => {},
          sendClient: (_client, message) =>
            message.includes(WS_CHANNELS.serverWelcome)
              ? Deferred.succeed(welcomeSendStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseWelcomeSend)),
                  Effect.as(true),
                )
              : Effect.sync(() => {
                  client.send(message);
                  return true;
                }),
        });

        const welcomeFiber = yield* Effect.forkScoped(
          pushBus.publishClient(client as unknown as WebSocket, WS_CHANNELS.serverWelcome, {
            cwd: "/tmp/project",
            projectName: "project",
          }),
        );
        yield* Deferred.await(welcomeSendStarted);

        yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: [{ kind: "keybindings.malformed-config", message: "superseded" }],
          providers: [],
        });
        yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: [],
          providers: [],
        });

        yield* Deferred.succeed(releaseWelcomeSend, undefined);
        expect(yield* Fiber.join(welcomeFiber)).toBe(true);
        yield* Effect.promise(() => client.waitForSentCount(1));

        expect(client.sent.map((message) => JSON.parse(message))).toEqual([
          {
            type: "push",
            sequence: 2,
            channel: WS_CHANNELS.serverConfigUpdated,
            data: { issues: [], providers: [] },
          },
        ]);
      }),
    ),
  );

  it.live("disconnects and removes clients whose outbound buffer exceeds the high-water mark", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = new MockWebSocket();
        client.bufferedAmount = 101;
        const clients = yield* Ref.make(new Set([client as unknown as WebSocket]));
        const pushBus = yield* makeServerPushBus({
          clients,
          logOutgoingPush: () => {},
          maxClientBufferedBytes: 100,
        });

        yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: [],
          providers: [],
        });
        yield* Effect.promise(() => client.waitForClose());

        expect(client.sent).toHaveLength(0);
        expect(client.closes).toEqual([
          {
            code: 1013,
            reason: "Client fell behind; reconnecting to resynchronize.",
          },
        ]);
        expect((yield* Ref.get(clients)).size).toBe(0);
      }),
    ),
  );

  it.effect("counts uncompressed logical bytes until the send callback completes", () =>
    Effect.gen(function* () {
      const client = new MockWebSocket();
      client.autoCompleteSends = false;
      const clients = yield* Ref.make(new Set([client as unknown as WebSocket]));
      const controller = makeWebSocketSendController({
        clients,
        maxClientBufferedBytes: 10,
      });

      expect(yield* controller.send(client as unknown as WebSocket, "123456")).toBe(true);
      expect(controller.logicalOutstandingBytes(client as unknown as WebSocket)).toBe(6);

      expect(yield* controller.send(client as unknown as WebSocket, "12345")).toBe(false);
      expect(client.sent).toEqual(["123456"]);
      expect(client.closes).toEqual([
        {
          code: 1013,
          reason: "Client fell behind; reconnecting to resynchronize.",
        },
      ]);
      expect((yield* Ref.get(clients)).size).toBe(0);
    }),
  );

  it.effect("releases logical bytes from the WebSocket send completion callback", () =>
    Effect.gen(function* () {
      const client = new MockWebSocket();
      client.autoCompleteSends = false;
      const clients = yield* Ref.make(new Set([client as unknown as WebSocket]));
      const controller = makeWebSocketSendController({
        clients,
        maxClientBufferedBytes: 10,
      });

      expect(yield* controller.send(client as unknown as WebSocket, "123456")).toBe(true);
      client.completeNextSend();
      expect(controller.logicalOutstandingBytes(client as unknown as WebSocket)).toBe(0);
      expect(yield* controller.send(client as unknown as WebSocket, "abcdef")).toBe(true);
      expect(client.closes).toHaveLength(0);
    }),
  );

  it.effect("serializes normal frames while retaining their combined logical backlog", () =>
    Effect.gen(function* () {
      const client = new MockWebSocket();
      client.autoCompleteSends = false;
      const clients = yield* Ref.make(new Set([client as unknown as WebSocket]));
      const controller = makeWebSocketSendController({
        clients,
        maxClientBufferedBytes: 10,
      });

      expect(yield* controller.send(client as unknown as WebSocket, "1234")).toBe(true);
      expect(yield* controller.send(client as unknown as WebSocket, "5678")).toBe(true);
      expect(client.sent).toEqual(["1234"]);
      expect(controller.logicalOutstandingBytes(client as unknown as WebSocket)).toBe(8);

      client.completeNextSend();
      expect(client.sent).toEqual(["1234", "5678"]);
      expect(controller.logicalOutstandingBytes(client as unknown as WebSocket)).toBe(4);
    }),
  );

  it.live("queues the next frame without closing while an oversized snapshot drains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = new MockWebSocket();
        client.autoCompleteSends = false;
        const clients = yield* Ref.make(new Set([client as unknown as WebSocket]));
        const controller = makeWebSocketSendController({
          clients,
          maxClientBufferedBytes: 10,
        });

        expect(yield* controller.send(client as unknown as WebSocket, "12345678901")).toBe(true);
        expect(controller.logicalOutstandingBytes(client as unknown as WebSocket)).toBe(11);

        expect(yield* controller.send(client as unknown as WebSocket, "x")).toBe(true);
        expect(client.sent).toEqual(["12345678901"]);

        client.completeNextSend();
        expect(client.sent).toEqual(["12345678901", "x"]);
        expect(client.closes).toEqual([]);
        expect((yield* Ref.get(clients)).size).toBe(1);
      }),
    ),
  );

  it.live("does not let one oversized client block pushes to other clients", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const slowClient = new MockWebSocket();
        slowClient.autoCompleteSends = false;
        const healthyClient = new MockWebSocket();
        const clients = yield* Ref.make(
          new Set([slowClient as unknown as WebSocket, healthyClient as unknown as WebSocket]),
        );
        const pushBus = yield* makeServerPushBus({
          clients,
          logOutgoingPush: () => {},
          maxClientBufferedBytes: 100,
        });

        yield* pushBus.publishAll(WS_CHANNELS.serverWelcome, {
          cwd: `/${"x".repeat(200)}`,
          projectName: "project",
        });
        yield* Effect.promise(() => healthyClient.waitForSentCount(1));
        yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: [],
          providers: [],
        });
        yield* Effect.promise(() => healthyClient.waitForSentCount(2));

        expect(slowClient.sent).toHaveLength(1);
        expect(slowClient.closes).toEqual([]);
        expect(healthyClient.sent).toHaveLength(2);

        slowClient.completeNextSend();
        expect(slowClient.sent).toHaveLength(2);
      }),
    ),
  );

  it.live("removes a failed client after a targeted push", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = new MockWebSocket();
        client.bufferedAmount = 101;
        const clients = yield* Ref.make(new Set([client as unknown as WebSocket]));
        const pushBus = yield* makeServerPushBus({
          clients,
          logOutgoingPush: () => {},
          maxClientBufferedBytes: 100,
        });

        const delivered = yield* pushBus.publishClient(
          client as unknown as WebSocket,
          WS_CHANNELS.serverWelcome,
          { cwd: "/tmp/project", projectName: "project" },
        );

        expect(delivered).toBe(false);
        expect(client.closes).toHaveLength(1);
        expect((yield* Ref.get(clients)).size).toBe(0);
      }),
    ),
  );
});
