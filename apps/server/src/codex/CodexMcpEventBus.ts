import { McpStatusUpdatedPayload } from "@t3tools/contracts";
import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect";

export interface CodexMcpEventBusShape {
  readonly publishStatusUpdated: (payload: McpStatusUpdatedPayload) => Effect.Effect<void>;
  readonly streamStatusUpdates: Stream.Stream<McpStatusUpdatedPayload>;
}

export class CodexMcpEventBus extends ServiceMap.Service<CodexMcpEventBus, CodexMcpEventBusShape>()(
  "t3/codex/CodexMcpEventBus",
) {}

const makeCodexMcpEventBus = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<McpStatusUpdatedPayload>();

  return {
    publishStatusUpdated: (payload) => PubSub.publish(pubSub, payload).pipe(Effect.asVoid),
    streamStatusUpdates: Stream.fromPubSub(pubSub),
  } satisfies CodexMcpEventBusShape;
});

export const CodexMcpEventBusLive = Layer.effect(CodexMcpEventBus, makeCodexMcpEventBus);
