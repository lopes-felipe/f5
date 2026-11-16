import { MAX_NATIVE_CONTINUATION_REQUESTS } from "./continuationPolicy.ts";
import type {
  CommandId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Queue, ServiceMap } from "effect";

export interface ProviderContinuationRequest {
  readonly requestId: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly generation: string;
  readonly createdAt: number;
  readonly previousTurnId: TurnId;
  readonly previousCommandId?: CommandId;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly status: Effect.Effect<"pending" | "adopted" | "closed">;
  readonly dispatchIfCurrent: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly clearIfCurrent: Effect.Effect<void>;
}
interface ProviderContinuationRequestsShape {
  /** Refused admission must stop the native wake; a request is never silently discarded. */
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<boolean>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
  readonly settle: (request: ProviderContinuationRequest) => Effect.Effect<void>;
}
export class ProviderContinuationRequests extends ServiceMap.Service<
  ProviderContinuationRequests,
  ProviderContinuationRequestsShape
>()("t3/provider/ProviderContinuationRequests") {}

export const makeProviderContinuationRequests = Effect.gen(function* () {
  const queue = yield* Queue.dropping<ProviderContinuationRequest>(
    MAX_NATIVE_CONTINUATION_REQUESTS,
  );
  const pending = new Map<ThreadId, ProviderContinuationRequest>();
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* Queue.shutdown(queue);
      const requests = [...pending.values()];
      pending.clear();
      yield* Effect.forEach(
        requests,
        (request) => request.clearIfCurrent.pipe(Effect.ignoreCause),
        { concurrency: 4, discard: true },
      );
    }),
  );
  return {
    offer: (request) =>
      Effect.gen(function* () {
        if (closed) return false;
        const previous = pending.get(request.threadId);
        if (previous === request) return true;
        if (previous && (yield* previous.status) === "pending") return false;
        if (pending.size >= MAX_NATIVE_CONTINUATION_REQUESTS) return false;
        pending.set(request.threadId, request);
        const accepted = yield* Queue.offer(queue, request);
        if (!accepted && pending.get(request.threadId) === request)
          pending.delete(request.threadId);
        return accepted;
      }),
    take: Queue.take(queue),
    settle: (request) =>
      Effect.sync(() => {
        if (pending.get(request.threadId) === request) pending.delete(request.threadId);
      }),
  } satisfies ProviderContinuationRequestsShape;
});
export const ProviderContinuationRequestsLive = Layer.effect(
  ProviderContinuationRequests,
  makeProviderContinuationRequests,
);
