import { OrchestrationUsageLimit, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionThreadSessionRepository } from "../Services/ProjectionThreadSessions.ts";
import { ProjectionThreadSessionRepositoryLive } from "./ProjectionThreadSessions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const at = "2026-10-07T12:00:00.000Z";
const usageLimit: OrchestrationUsageLimit = {
  windows: [{ id: "five_hour", label: "5-hour", resetsAt: "2026-10-07T13:00:00.000Z" }],
  resetsAt: "2026-10-07T13:00:00.000Z",
  resetSource: "provider",
  evidence: "typed",
  providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
  turnId: TurnId.makeUnsafe("turn"),
  deliveryId: null,
};
it.layer(ProjectionThreadSessionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "usage limit persistence",
  (it) => {
    it.effect("round trips typed windows and clears the persisted limit", () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadSessionRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("limit-thread");
        const row = {
          threadId,
          status: "error" as const,
          providerName: "claudeAgent",
          providerInstanceId: usageLimit.providerInstanceId,
          runtimeMode: "full-access" as const,
          activeTurnId: null,
          lastError: "Limit",
          lastErrorId: "error",
          lastErrorOccurredAt: at,
          lastErrorRetryability: null,
          usageLimit,
          estimatedContextTokens: null,
          modelContextWindowTokens: null,
          tokenUsageSource: null,
          updatedAt: at,
        };
        yield* repository.upsert(row);
        const loaded = yield* repository.getByThreadId({ threadId });
        assert(Option.isSome(loaded));
        assert.deepEqual(loaded.value.usageLimit, usageLimit);
        const raw = yield* sql<{
          usage_limit_json: string;
        }>`SELECT usage_limit_json FROM projection_thread_sessions WHERE thread_id=${threadId}`;
        assert.equal(JSON.parse(raw[0]!.usage_limit_json).resetsAt, usageLimit.resetsAt);
        yield* repository.upsert({ ...row, usageLimit: null });
        const cleared = yield* repository.getByThreadId({ threadId });
        assert(Option.isSome(cleared));
        assert.equal(cleared.value.usageLimit, null);
      }),
    );
  },
);
