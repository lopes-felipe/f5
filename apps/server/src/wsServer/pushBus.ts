import {
  AGENTS_WS_CHANNELS,
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

export interface WebSocketSendController {
  readonly send: (client: WebSocket, message: string) => Effect.Effect<boolean>;
  readonly logicalOutstandingBytes: (client: WebSocket) => number;
}

export function makeWebSocketSendController(input: {
  readonly clients: Ref.Ref<Set<WebSocket>>;
  readonly maxClientBufferedBytes?: number;
}): WebSocketSendController {
  const maxClientBufferedBytes = Math.max(
    1,
    input.maxClientBufferedBytes ?? DEFAULT_MAX_CLIENT_BUFFERED_BYTES,
  );
  const logicalOutstandingByClient = new WeakMap<WebSocket, number>();

  const removeClient = (client: WebSocket) =>
    Ref.update(input.clients, (current) => {
      if (!current.has(client)) return current;
      const next = new Set(current);
      next.delete(client);
      return next;
    });

  const closeSlowClient = (client: WebSocket) =>
    Effect.sync(() => {
      try {
        client.close(SLOW_CLIENT_CLOSE_CODE, SLOW_CLIENT_CLOSE_REASON);
      } catch {
        // The socket may already be tearing down. Removing it from the
        // broadcast set is sufficient; its close handler is idempotent.
      }
    }).pipe(Effect.andThen(removeClient(client)));

  const send: WebSocketSendController["send"] = (client, message) =>
    Effect.gen(function* () {
      if (client.readyState !== client.OPEN) {
        yield* removeClient(client);
        return false;
      }

      const logicalBytes = Buffer.byteLength(message);
      const logicalOutstanding = logicalOutstandingByClient.get(client) ?? 0;
      if (
        client.bufferedAmount > maxClientBufferedBytes ||
        logicalOutstanding + logicalBytes > maxClientBufferedBytes
      ) {
        yield* closeSlowClient(client);
        return false;
      }

      logicalOutstandingByClient.set(client, logicalOutstanding + logicalBytes);
      const didSend = yield* Effect.try({
        try: () =>
          client.send(message, (error) => {
            const currentOutstanding = logicalOutstandingByClient.get(client) ?? 0;
            logicalOutstandingByClient.set(client, Math.max(0, currentOutstanding - logicalBytes));
            if (error) {
              Effect.runFork(closeSlowClient(client));
            }
          }),
        catch: () => undefined,
      }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!didSend) {
        logicalOutstandingByClient.set(client, logicalOutstanding);
        yield* closeSlowClient(client);
        return false;
      }
      return true;
    });

  return {
    send,
    logicalOutstandingBytes: (client) => logicalOutstandingByClient.get(client) ?? 0,
  };
}

// These channels carry latest-state notifications. Replacing an older queued
// value with a newer one is safe and prevents a burst of invalidations or
// progress frames from crowding lossless orchestration/terminal events.
const COALESCIBLE_BROADCAST_CHANNELS = new Set<WsPushChannel>([
  AGENTS_WS_CHANNELS.snapshotUpdated,
  WS_CHANNELS.serverConfigUpdated,
  WS_CHANNELS.providerAdvisoriesUpdated,
  WS_CHANNELS.gitStatusInvalidated,
  WS_CHANNELS.previewLocalServersUpdated,
  WS_CHANNELS.mcpStatusUpdated,
  WS_CHANNELS.storageInvalidated,
  WS_CHANNELS.storageCleanupProgress,
  WS_CHANNELS.nextTurnQueueUpdated,
  WS_CHANNELS.nextTurnQueueSummaryUpdated,
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
  readonly sendClient?: WebSocketSendController["send"];
}): Effect.Effect<ServerPushBus, never, Scope.Scope> =>
  Effect.gen(function* () {
    const nextSequence = yield* Ref.make(0);
    const queueCapacity = Math.max(1, input.queueCapacity ?? DEFAULT_PUSH_QUEUE_CAPACITY);
    const sendClient =
      input.sendClient ??
      makeWebSocketSendController({
        clients: input.clients,
        ...(input.maxClientBufferedBytes !== undefined
          ? { maxClientBufferedBytes: input.maxClientBufferedBytes }
          : {}),
      }).send;
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
      let recipientCount = 0;

      for (const client of recipients) {
        if (yield* sendClient(client, message)) {
          recipientCount += 1;
        }
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
