import {
  PR_HUB_WS_CHANNELS,
  WsPush,
  WS_CHANNELS,
  type WsPushChannel,
  type WsPushData,
  type WsPushEnvelopeBase,
} from "@t3tools/contracts";
import { Deferred, Effect, Queue, Ref, Schema } from "effect";
import type { Scope } from "effect";
import type { WebSocket } from "ws";

type PushTarget =
  | { readonly kind: "all" }
  | { readonly kind: "client"; readonly client: WebSocket };

interface PushJob<C extends WsPushChannel = WsPushChannel> {
  readonly channel: C;
  readonly data: WsPushData<C>;
  readonly target: PushTarget;
  readonly delivered: Deferred.Deferred<boolean> | null;
}

type PushQueueEntry =
  | { readonly kind: "job"; readonly job: PushJob }
  | { readonly kind: "coalesced"; readonly key: string };

const DEFAULT_PUSH_QUEUE_CAPACITY = 2_048;
const DEFAULT_MAX_CLIENT_BUFFERED_BYTES = 4 * 1024 * 1024;
const SLOW_CLIENT_CLOSE_CODE = 1013;
const SLOW_CLIENT_CLOSE_REASON = "Client fell behind; reconnecting to resynchronize.";

// These channels carry latest-state notifications. Replacing an older queued
// value with a newer one is safe and prevents a burst of invalidations or
// progress frames from crowding lossless orchestration/terminal events.
const COALESCIBLE_BROADCAST_CHANNELS = new Set<WsPushChannel>([
  WS_CHANNELS.serverConfigUpdated,
  WS_CHANNELS.providerAdvisoriesUpdated,
  WS_CHANNELS.gitStatusInvalidated,
  WS_CHANNELS.previewLocalServersUpdated,
  WS_CHANNELS.mcpStatusUpdated,
  WS_CHANNELS.storageInvalidated,
  WS_CHANNELS.storageCleanupProgress,
  WS_CHANNELS.nextTurnQueueUpdated,
  PR_HUB_WS_CHANNELS.snapshotUpdated,
  PR_HUB_WS_CHANNELS.advisoriesUpdated,
]);

export function pushCoalescingKey<C extends WsPushChannel>(
  channel: C,
  data: WsPushData<C>,
): string {
  if (channel === WS_CHANNELS.nextTurnQueueUpdated) {
    const snapshot = data as WsPushData<typeof WS_CHANNELS.nextTurnQueueUpdated>;
    return `${channel}:${snapshot.threadId}`;
  }
  return channel;
}

export interface ServerPushBus {
  readonly publishAll: <C extends WsPushChannel>(
    channel: C,
    data: WsPushData<C>,
  ) => Effect.Effect<void>;
  readonly publishClient: <C extends WsPushChannel>(
    client: WebSocket,
    channel: C,
    data: WsPushData<C>,
  ) => Effect.Effect<boolean>;
}

export const makeServerPushBus = (input: {
  readonly clients: Ref.Ref<Set<WebSocket>>;
  readonly logOutgoingPush: (push: WsPushEnvelopeBase, recipients: number) => void;
  readonly queueCapacity?: number;
  readonly maxClientBufferedBytes?: number;
}): Effect.Effect<ServerPushBus, never, Scope.Scope> =>
  Effect.gen(function* () {
    const nextSequence = yield* Ref.make(0);
    const queueCapacity = Math.max(1, input.queueCapacity ?? DEFAULT_PUSH_QUEUE_CAPACITY);
    const maxClientBufferedBytes = Math.max(
      1,
      input.maxClientBufferedBytes ?? DEFAULT_MAX_CLIENT_BUFFERED_BYTES,
    );
    const queue = yield* Queue.bounded<PushQueueEntry>(queueCapacity);
    const coalescedJobs = yield* Ref.make<ReadonlyMap<string, PushJob>>(new Map());
    const encodePush = Schema.encodeUnknownEffect(Schema.fromJsonString(WsPush));

    const settleDelivery = (job: PushJob, delivered: boolean) =>
      job.delivered === null
        ? Effect.void
        : Deferred.succeed(job.delivered, delivered).pipe(Effect.orDie);

    const send = Effect.fnUntraced(function* (job: PushJob) {
      const sequence = yield* Ref.updateAndGet(nextSequence, (current) => current + 1);
      const push: WsPushEnvelopeBase = {
        type: "push",
        sequence,
        channel: job.channel,
        data: job.data,
      };
      const recipients =
        job.target.kind === "all" ? yield* Ref.get(input.clients) : new Set([job.target.client]);

      const message = yield* encodePush(push);
      const clientsToRemove = new Set<WebSocket>();
      let recipientCount = 0;

      yield* Effect.sync(() => {
        for (const client of recipients) {
          if (client.readyState !== client.OPEN) {
            clientsToRemove.add(client);
            continue;
          }
          if (client.bufferedAmount > maxClientBufferedBytes) {
            clientsToRemove.add(client);
            try {
              client.close(SLOW_CLIENT_CLOSE_CODE, SLOW_CLIENT_CLOSE_REASON);
            } catch {
              // The socket may already be tearing down. Removing it from the
              // broadcast set is sufficient; its close handler is idempotent.
            }
            continue;
          }
          try {
            client.send(message);
            recipientCount += 1;
          } catch {
            clientsToRemove.add(client);
            try {
              client.close(SLOW_CLIENT_CLOSE_CODE, SLOW_CLIENT_CLOSE_REASON);
            } catch {
              // Ignore close failures for an already-broken socket.
            }
          }
        }
      });

      if (clientsToRemove.size > 0) {
        yield* Ref.update(input.clients, (current) => {
          const next = new Set(current);
          for (const client of clientsToRemove) next.delete(client);
          return next;
        });
      }

      input.logOutgoingPush(push, recipientCount);
      return recipientCount > 0;
    });

    const takeCoalescedJob = (key: string) =>
      Ref.modify(coalescedJobs, (current) => {
        const job = current.get(key) ?? null;
        if (job === null) return [null, current] as const;
        const next = new Map(current);
        next.delete(key);
        return [job, next] as const;
      });

    const processEntry = (entry: PushQueueEntry) =>
      entry.kind === "job"
        ? send(entry.job).pipe(
            Effect.tap((delivered) => settleDelivery(entry.job, delivered)),
            Effect.tapCause(() => settleDelivery(entry.job, false)),
          )
        : takeCoalescedJob(entry.key).pipe(
            Effect.flatMap((job) => (job === null ? Effect.void : send(job).pipe(Effect.asVoid))),
          );

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(Effect.flatMap(processEntry), Effect.ignoreCause({ log: true })),
      ),
    );

    const offerCoalesced = (key: string, job: PushJob) =>
      Ref.modify(coalescedJobs, (current) => {
        const shouldEnqueue = !current.has(key);
        const next = new Map(current);
        next.set(key, job);
        return [shouldEnqueue, next] as const;
      }).pipe(
        Effect.flatMap((shouldEnqueue) =>
          shouldEnqueue ? Queue.offer(queue, { kind: "coalesced", key }) : Effect.void,
        ),
        Effect.asVoid,
      );

    const publish =
      (target: PushTarget) =>
      <C extends WsPushChannel>(channel: C, data: WsPushData<C>) => {
        const job: PushJob<C> = {
          channel,
          data,
          target,
          delivered: null,
        };
        return target.kind === "all" && COALESCIBLE_BROADCAST_CHANNELS.has(channel)
          ? offerCoalesced(pushCoalescingKey(channel, data), job)
          : Queue.offer(queue, { kind: "job", job }).pipe(Effect.asVoid);
      };

    return {
      publishAll: publish({ kind: "all" }),
      publishClient: (client, channel, data) =>
        Effect.gen(function* () {
          const delivered = yield* Deferred.make<boolean>();
          yield* Queue.offer(queue, {
            kind: "job",
            job: {
              channel,
              data,
              target: { kind: "client", client },
              delivered,
            },
          }).pipe(Effect.asVoid);
          return yield* Deferred.await(delivered);
        }),
    } satisfies ServerPushBus;
  });
