#!/usr/bin/env bun
/** Create a disposable usage-limit thread in a new, isolated dev state directory.
 * Usage: bun apps/server/scripts/seed-usage-limit.ts /tmp/f5-usage-test/state [resetSeconds]
 * Start with F5_DEV_USAGE_LIMIT_THREAD=<printed threadId> bun run dev --state-dir <same directory>.
 * The opt-in dev hook reapplies the fake failure after reconciliation with a fresh two-minute reset.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { isProtectedAppStateDir } from "@t3tools/shared/appStatePaths";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";

const directory = process.argv[2];
const seconds = Number(process.argv[3] ?? 120);
if (!directory || !Number.isFinite(seconds) || seconds <= 0 || seconds > 7 * 86400)
  throw new Error(
    "Usage: seed-usage-limit.ts <new isolated state directory> [resetSeconds: 1..604800]",
  );
const stateDir = path.resolve(directory);
if (isProtectedAppStateDir(stateDir) || fs.existsSync(path.join(stateDir, "state.sqlite")))
  throw new Error(
    "Use a new isolated state directory; existing databases and app state are protected.",
  );
const workspace = path.join(path.dirname(stateDir), "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
const threadId = ThreadId.makeUnsafe(`usage-limit-test-${randomUUID()}`);
const projectId = ProjectId.makeUnsafe(`usage-limit-project-${randomUUID()}`);
const turnId = TurnId.makeUnsafe(`simulated-limit-${randomUUID()}`);
const instanceId = ProviderInstanceId.makeUnsafe(
  defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
);
const at = new Date().toISOString();
const resetsAt = new Date(Date.now() + seconds * 1000).toISOString();
const model = DEFAULT_MODEL_BY_PROVIDER.codex;
const commandId = () => CommandId.makeUnsafe(randomUUID());
const layer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite"))),
  Layer.provideMerge(ServerConfig.layerTest(workspace, stateDir)),
  Layer.provideMerge(NodeServices.layer),
);
const runtime = ManagedRuntime.make(layer);
try {
  await runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: commandId(),
        projectId,
        title: "Usage limit sandbox",
        workspaceRoot: workspace,
        defaultModel: model,
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: commandId(),
        threadId,
        projectId,
        title: "Simulated subscription limit",
        model,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: at,
      });
      const session = {
        threadId,
        providerName: "codex",
        providerInstanceId: instanceId,
        runtimeMode: "approval-required" as const,
        lastError: null,
        updatedAt: at,
      };
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: commandId(),
        threadId,
        session: {
          ...session,
          status: "error",
          activeTurnId: null,
          lastError: `SIMULATED: Codex usage limit reached. Resets at ${resetsAt}.`,
          lastErrorId: `simulated:${turnId}`,
          lastErrorOccurredAt: at,
          lastErrorRetryability: "retryable",
          usageLimit: {
            windows: [{ id: "primary", label: "5-hour", resetsAt }],
            resetsAt,
            resetSource: "provider",
            evidence: "typed",
            providerInstanceId: instanceId,
            turnId,
            deliveryId: null,
          },
        },
        createdAt: at,
      });
      const thread = (yield* engine.getReadModel()).threads.find((entry) => entry.id === threadId);
      if (thread?.session?.usageLimit?.resetsAt !== resetsAt || thread.session.activeTurnId)
        throw new Error("Simulated limit was not projected correctly.");
    }),
  );
  console.log(
    JSON.stringify(
      {
        stateDir,
        threadId,
        resetsAt,
        continueAt: new Date(Date.parse(resetsAt) + 60000).toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  await runtime.dispose();
}
