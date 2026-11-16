import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../Layers/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipelineLive } from "../Layers/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionThreadCommandExecutionRepositoryLive } from "../../persistence/Layers/ProjectionThreadCommandExecutions.ts";
import { ThreadCommandExecutionQueryLive } from "../Layers/ThreadCommandExecutionQuery.ts";
import { ThreadCommandExecutionQuery } from "../Services/ThreadCommandExecutionQuery.ts";

export async function createPersistentOrchestrationSystem(input: {
  readonly dbPath: string;
  readonly eventStoreLayer?: Layer.Layer<OrchestrationEventStore, never, SqlClient.SqlClient>;
  readonly projectionSnapshotQueryLayer?: Layer.Layer<
    ProjectionSnapshotQuery,
    never,
    SqlClient.SqlClient
  >;
}) {
  const persistenceLayer = makeSqlitePersistenceLive(input.dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(
      ThreadCommandExecutionQueryLive.pipe(
        Layer.provide(ProjectionThreadCommandExecutionRepositoryLive),
      ),
    ),
    Layer.provideMerge(
      input.projectionSnapshotQueryLayer ?? OrchestrationProjectionSnapshotQueryLive,
    ),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(input.eventStoreLayer ?? OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    snapshotQuery: await runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    threadCommandExecutionQuery: await runtime.runPromise(
      Effect.service(ThreadCommandExecutionQuery),
    ),
    sql: await runtime.runPromise(Effect.service(SqlClient.SqlClient)),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}
