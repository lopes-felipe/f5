import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { ORCHESTRATION_WS_CHANNELS, type OrchestrationEvent } from "@t3tools/contracts";
import { Effect, Ref, Stream } from "effect";
import { makeServerPushBus, makeWebSocketSendController } from "../../src/wsServer/pushBus.ts";
import { closeSocketsWithin } from "../../src/wsServer/socketLiveness.ts";
/** Real sockets with an injectable send callback barrier, shared by recovery cases. */
export const makeClientTransport = (
  harness: {
    engine: import("../../src/orchestration/Services/OrchestrationEngine.ts").OrchestrationEngineShape;
  },
  maxClientBufferedBytes = 4 * 1024 * 1024,
) =>
  Effect.gen(function* () {
    const clients = yield* Ref.make(new Set<WebSocket>());
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const listening = once(server, "listening");
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await closeSocketsWithin(server.clients, performance.now() + 100);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
    const incarnation = randomUUID();
    const controller = makeWebSocketSendController({ clients, maxClientBufferedBytes });
    let latestSocket: WebSocket | undefined;
    let closes = 0;
    let configureNext: ((socket: WebSocket) => void) | undefined;
    let broadcastSequence = 0;
    server.on("connection", (socket) => {
      latestSocket = socket;
      const configure = configureNext;
      configureNext = undefined;
      configure?.(socket);
      Effect.runSync(Ref.update(clients, (previous) => new Set([...previous, socket])));
      socket.on("close", () => {
        closes++;
        Effect.runSync(
          Ref.update(
            clients,
            (previous) => new Set([...previous].filter((client) => client !== socket)),
          ),
        );
      });
      socket.on("message", (bytes) => {
        const request = JSON.parse(String(bytes));
        if (request.method === "snapshot")
          void Effect.runPromise(harness.engine.getReadModel()).then((snapshot) =>
            Effect.runPromise(
              controller.send(socket, JSON.stringify({ id: request.id, snapshot })),
            ),
          );
      });
      void Effect.runPromise(
        controller.send(socket, JSON.stringify({ type: "welcome", incarnation })),
      );
    });
    yield* Effect.promise(() => listening);
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Expected TCP address");
    const push = yield* makeServerPushBus({
      clients,
      sendClient: controller.send,
      logOutgoingPush: (push) => {
        broadcastSequence = (push.data as OrchestrationEvent).sequence;
      },
    });
    yield* Stream.runForEach(harness.engine.streamDomainEvents, (event) =>
      push.publishAll(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
    ).pipe(Effect.forkScoped);
    return {
      url: `ws://127.0.0.1:${address.port}`,
      socket: () => {
        if (!latestSocket) throw new Error("No connected client");
        return latestSocket;
      },
      closes: () => closes,
      onNextConnection: (configure: (socket: WebSocket) => void) => {
        configureNext = configure;
      },
      controller,
      waitForBroadcast: (sequence: number) =>
        Effect.gen(function* () {
          while (broadcastSequence < sequence) yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("5 seconds")),
    };
  });
