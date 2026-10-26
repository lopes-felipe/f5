import { Clock, Deferred, Duration, Effect } from "effect";
import type { DesktopComputerHost } from "../computer/DesktopComputerHost.ts";
import type { ScheduledTaskServiceShape } from "./Service.ts";
import type { ScheduledTaskStoreShape } from "./Store.ts";
import { retryScheduledOperation } from "./worker.ts";
/** Durable, leased server-to-Electron delivery; no renderer or computer permission required. */
export const makeScheduledNotificationDelivery = (deps: {
  host: Pick<
    DesktopComputerHost,
    "backendIncarnation" | "notificationsCapable" | "send" | "onMessage"
  >;
  service: ScheduledTaskServiceShape;
  store: ScheduledTaskStoreShape;
  changed: () => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    let signal = yield* Deferred.make<void>();
    const wake = Effect.suspend(() => Deferred.succeed(signal, undefined)).pipe(Effect.asVoid);
    const owner = `desktop:${deps.host.backendIncarnation}`;
    const start = Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          deps.host.onMessage((message) => {
            const work =
              message.type === "scheduledNotificationAck"
                ? deps.service
                    .acknowledgeNotifications({ owner, ids: [message.id] })
                    .pipe(Effect.andThen(wake))
                : message.type === "hostCapabilities" || message.type === "status"
                  ? deps.changed().pipe(Effect.andThen(wake))
                  : Effect.void;
            void Effect.runPromise(work).catch((error) =>
              console.error("scheduledTasks.notification", error),
            );
          }),
        ),
        (off) => Effect.sync(off),
      );
      yield* Effect.gen(function* () {
        for (;;)
          yield* retryScheduledOperation(
            Effect.gen(function* () {
              signal = yield* Deferred.make<void>();
              if (deps.host.notificationsCapable()) {
                const batch = yield* deps.service.claimNotifications({ owner });
                for (const notification of batch.notifications)
                  deps.host.send({ type: "scheduledNotification", notification });
              }
              const pending = deps.host.notificationsCapable()
                ? yield* deps.store.sql<{
                    deadline: string | null;
                  }>`SELECT MIN(lease_until) AS deadline FROM scheduled_notifications WHERE acknowledged_at IS NULL AND lease_until IS NOT NULL`
                : [];
              const deadline = pending[0]?.deadline;
              if (deadline)
                yield* Deferred.await(signal).pipe(
                  Effect.timeoutOption(
                    Duration.millis(
                      Math.max(1, Date.parse(deadline) - (yield* Clock.currentTimeMillis)),
                    ),
                  ),
                );
              else yield* Deferred.await(signal);
            }),
            "scheduledTasks.notifications",
          );
      }).pipe(Effect.forkScoped);
    });
    return { wake, start };
  });
