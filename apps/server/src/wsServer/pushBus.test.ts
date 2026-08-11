import type { WebSocket } from "ws";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, Ref } from "effect";
import { ThreadId, WS_CHANNELS } from "@t3tools/contracts";

import { makeServerPushBus, pushCoalescingKey } from "./pushBus";

class MockWebSocket {
  static readonly OPEN = 1;

  readonly OPEN = MockWebSocket.OPEN;
  readyState = MockWebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly waiters = new Set<() => void>();

  send(message: string) {
    this.sent.push(message);
    for (const waiter of this.waiters) {
      waiter();
    }
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
