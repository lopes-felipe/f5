import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Queue } from "effect";
import { TestClock } from "effect/testing";
import { ScheduledTaskRunId, type DesktopComputerHostMessage } from "@t3tools/contracts";
import { setup, testLayer } from "./testing.ts";
import { userScheduleActor } from "./Service.ts";
import { makeScheduledNotificationDelivery } from "./notificationDelivery.ts";
it.effect(
  "leases native notifications without a renderer, retries unacknowledged presentation and stops after acknowledgement",
  () =>
    Effect.gen(function* () {
      const { create, service, store } = yield* setup;
      const { task } = yield* create();
      const run = yield* service.runNow(
        {
          taskId: task.id,
          runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
          requestedAt: new Date(0).toISOString(),
        },
        userScheduleActor,
      );
      yield* service.reserve((yield* store.run(run.id))!);
      yield* store.transition(run.id, "succeeded", null, new Date(0).toISOString());
      const messages = yield* Queue.unbounded<DesktopComputerHostMessage>();
      let receive: ((m: DesktopComputerHostMessage) => void) | undefined;
      const acknowledged = yield* Deferred.make<void>();
      const worker = yield* makeScheduledNotificationDelivery({
        host: {
          backendIncarnation: "test-incarnation",
          notificationsCapable: () => true,
          send: (m) => {
            void Effect.runPromise(Queue.offer(messages, m));
          },
          onMessage: (listener) => {
            receive = listener;
            return () => {
              receive = undefined;
            };
          },
        },
        service: {
          ...service,
          acknowledgeNotifications: (input) =>
            service
              .acknowledgeNotifications(input)
              .pipe(Effect.tap(() => Deferred.succeed(acknowledged, undefined))),
        },
        store,
        changed: () => Effect.void,
      });
      yield* worker.start;
      const first = yield* Queue.take(messages);
      expect(first.type).toBe("scheduledNotification");
      expect((yield* service.claimNotifications({ owner: "browser" })).notifications).toHaveLength(
        0,
      );
      yield* TestClock.adjust("1 minute");
      const replay = yield* Queue.take(messages);
      expect(replay).toEqual(first);
      if (replay.type !== "scheduledNotification") throw new Error("Expected a native notice");
      receive!({ type: "scheduledNotificationAck", id: replay.notification.id });
      yield* Deferred.await(acknowledged);
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(messages)).toBe(0);
      expect((yield* service.claimNotifications({ owner: "browser" })).notifications).toHaveLength(
        0,
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
