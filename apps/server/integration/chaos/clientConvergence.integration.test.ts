import { once } from "node:events";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { it, assert } from "@effect/vitest";
import {
  makeOrchestrationIntegrationHarness,
  seedOrchestrationProjectAndThread,
} from "../OrchestrationEngineHarness.integration.ts";
import { makeClientTransport } from "./transport.ts";
import { connectStoreClient } from "./client.ts";

it.live(
  "a WebSocket drop mid-stream converges the real client store without duplicate deltas",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* Effect.acquireRelease(
          makeOrchestrationIntegrationHarness(),
          (harness) => harness.dispose,
        );
        yield* seedOrchestrationProjectAndThread(harness);
        const transport = yield* makeClientTransport(harness);
        const client = yield* Effect.acquireRelease(
          Effect.promise(() => connectStoreClient(transport.url)),
          (client) => Effect.promise(() => client.close()),
        );
        yield* Effect.promise(() => client.next("ready"));
        const barrier = Promise.withResolvers<void>();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const createdAt = new Date().toISOString();
        const base = {
          provider: "codex" as const,
          threadId,
          turnId: "fixture-turn",
          itemId: "chaos-item",
          createdAt,
        };
        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          beforeEvent: (index) =>
            index === 2 ? Effect.promise(() => barrier.promise) : Effect.void,
          events: [
            { ...base, type: "turn.started", eventId: EventId.makeUnsafe("chaos-start") },
            {
              ...base,
              type: "content.delta",
              eventId: EventId.makeUnsafe("chaos-prefix"),
              payload: { streamKind: "assistant_text", delta: "prefix " },
            },
            {
              ...base,
              type: "content.delta",
              eventId: EventId.makeUnsafe("chaos-suffix"),
              payload: { streamKind: "assistant_text", delta: "suffix\n" },
            },
            {
              ...base,
              type: "item.completed",
              eventId: EventId.makeUnsafe("chaos-complete"),
              payload: { itemType: "assistant_message", status: "completed" },
            },
            {
              ...base,
              type: "turn.completed",
              eventId: EventId.makeUnsafe("chaos-terminal"),
              payload: { state: "completed" },
            },
          ],
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => barrier.resolve()));
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("chaos-dispatch"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("chaos-user"),
            role: "user",
            text: "stream",
            attachments: [],
          },
          assistantDeliveryMode: "streaming",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt,
        });
        yield* harness.waitForThread(threadId, (thread) =>
          thread.messages.some((message) => message.text === "prefix "),
        );
        client.send("disconnect");
        yield* Effect.promise(() => client.next("closed"));
        barrier.resolve();
        yield* harness.waitForThread(threadId, (thread) =>
          thread.messages.some(
            (message) => message.text === "prefix suffix\n" && !message.streaming,
          ),
        );
        client.send("reconnect");
        yield* Effect.promise(() => client.next("ready"));
        client.send("inspect");
        const observed = yield* Effect.promise(() => client.next("state"));
        const expected = (yield* harness.engine.getReadModel()).threads.map((thread) => ({
          id: thread.id,
          messages: thread.messages.map((message) => ({ id: message.id, text: message.text })),
        }));
        assert.deepEqual(observed.threads, expected);
      }),
    ),
  30_000,
);

it.live(
  "a slow client closes once, then an oversized snapshot and queued push converge",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* Effect.acquireRelease(
          makeOrchestrationIntegrationHarness(),
          (harness) => harness.dispose,
        );
        yield* seedOrchestrationProjectAndThread(harness);
        const threadId = ThreadId.makeUnsafe("thread-1");
        const messageId = MessageId.makeUnsafe("slow-client-message");
        let index = 0;
        const append = (delta: string) =>
          harness.engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.makeUnsafe(`slow-client:${++index}`),
            threadId,
            messageId,
            delta,
            createdAt: new Date().toISOString(),
          });
        yield* append("snapshot".repeat(2048));
        const transport = yield* makeClientTransport(harness, 4096);
        const client = yield* Effect.acquireRelease(
          Effect.promise(() => connectStoreClient(transport.url)),
          (client) => Effect.promise(() => client.close()),
        );
        yield* Effect.promise(() => client.next("ready"));
        const oldSocket = transport.socket();
        const realSend = oldSocket.send.bind(oldSocket);
        const sent = Promise.withResolvers<void>();
        let release: (() => void) | undefined;
        // Hold completion of the first real send; subsequent lossless frames queue
        // behind it until the normal backlog budget closes this connection.
        oldSocket.send = ((message: string, callback: (error?: Error) => void) => {
          realSend(message, (error) => {
            release = () => callback(error);
            sent.resolve();
          });
        }) as typeof oldSocket.send;
        yield* append("first");
        yield* Effect.promise(() => sent.promise);
        const serverClosed = once(oldSocket, "close");
        let lastFloodSequence = 0;
        for (let i = 0; i < 12; i++)
          lastFloodSequence = (yield* append("delta".repeat(128))).sequence;
        yield* Effect.promise(() => client.next("closed"));
        yield* Effect.promise(() => serverClosed);
        release?.();
        assert.equal(transport.closes(), 1);
        // Dispatch acknowledges persistence before the push bus finishes sending.
        // Drain the old flood so it cannot overload the replacement connection.
        yield* transport.waitForBroadcast(lastFloodSequence);

        // Install the same delayed callback on the replacement before its snapshot
        // request. A legitimate oversized response must not consume push backlog.
        const snapshotSent = Promise.withResolvers<void>();
        let releaseSnapshot: (() => void) | undefined;
        let snapshotBytes = 0;
        transport.onNextConnection((socket) => {
          const send = socket.send.bind(socket);
          socket.send = ((message: string, callback: (error?: Error) => void) => {
            if (!JSON.parse(message).snapshot) {
              send(message, callback);
              return;
            }
            snapshotBytes = Buffer.byteLength(message);
            send(message, (error) => {
              releaseSnapshot = () => callback(error);
              snapshotSent.resolve();
            });
          }) as typeof socket.send;
        });
        client.send("reconnect");
        yield* Effect.promise(() => snapshotSent.promise);
        yield* Effect.promise(() => client.next("ready"));
        const socket = transport.socket();
        assert.notEqual(socket, oldSocket);
        assert.isAbove(snapshotBytes, 4096);
        yield* append("tail");
        for (
          let attempt = 0;
          attempt < 100 && transport.controller.logicalOutstandingBytes(socket) === snapshotBytes;
          attempt++
        )
          yield* Effect.sleep("10 millis");
        assert.isAbove(transport.controller.logicalOutstandingBytes(socket), snapshotBytes);
        releaseSnapshot?.();
        const expected = (yield* harness.engine.getReadModel()).threads.map((thread) => ({
          id: thread.id,
          messages: thread.messages.map((message) => ({ id: message.id, text: message.text })),
        }));
        let observed: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          client.send("inspect");
          observed = yield* Effect.promise(() => client.next("state"));
          if (JSON.stringify(observed.threads) === JSON.stringify(expected)) break;
          yield* Effect.sleep("10 millis");
        }
        assert.deepEqual(observed?.threads, expected);
        assert.equal(transport.closes(), 1);
      }),
    ),
  30_000,
);
