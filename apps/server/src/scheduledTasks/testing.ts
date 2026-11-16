import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Schema } from "effect";
import { ProviderInstanceId, ScheduledTaskCreateInput } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { FakeAgentBridgeHost, project, thread } from "../agentBridge/testing/fakeHost.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeScheduledTaskStore } from "./Store.ts";
import { makeScheduledTaskService, userScheduleActor as actor } from "./Service.ts";
const layer = SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer));
export const setup = Effect.gen(function* () {
  const store = yield* makeScheduledTaskStore,
    host = new FakeAgentBridgeHost();
  host.projects = [project("project")];
  const settings = yield* ServerSettingsService;
  const service = yield* makeScheduledTaskService({
    store,
    host: host.shape,
    settings,
    publish: () => Effect.void,
  });
  const create = (extra = {}, requestedAt = new Date(0).toISOString()) =>
    service.create(
      Schema.decodeUnknownSync(ScheduledTaskCreateInput)({
        id: crypto.randomUUID(),
        projectId: "project",
        requestedAt,
        configuration: {
          name: "Check",
          prompt: "Check tests",
          modelSelection: { instanceId: "codex", model: "model-a" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspace: { kind: "projectRoot" },
          cron: "* * * * *",
          timezone: "UTC",
          scheduleSource: "cron",
          maxRuns: null,
          oneShotAt: null,
          notify: "all",
          enabled: true,
          ...extra,
        },
      }),
      actor,
    );
  return { store, host, settings, service, create };
});
export const testLayer = Layer.merge(layer, ServerSettingsService.layerTest());
/** An existing user conversation that a thread-bound task can target, in the host and projections. */
export const seedBoundThread = (
  host: FakeAgentBridgeHost,
  store: import("./Store.ts").ScheduledTaskStoreShape,
  threadId: string,
  overrides: Partial<import("@t3tools/contracts").OrchestrationThread> = {},
) =>
  Effect.gen(function* () {
    const value = thread(threadId, "project", {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model-a" },
      ...overrides,
    });
    host.threads = [...host.threads.filter((t) => t.id !== threadId), value];
    const at = new Date(0).toISOString();
    yield* store.sql`INSERT OR IGNORE INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('project','Project','/repo','[]',${at},${at})`;
    yield* store.sql`INSERT OR REPLACE INTO projection_threads(thread_id,project_id,title,model,model_selection_json,runtime_mode,interaction_mode,created_at,last_interaction_at,updated_at)
      VALUES(${threadId},'project','Conversation',${value.modelSelection?.model ?? "model-a"},${value.modelSelection ? JSON.stringify(value.modelSelection) : null},${value.runtimeMode},${value.interactionMode},${at},${at},${at})`;
    return value;
  });
export const seedScheduledThread = (
  store: import("./Store.ts").ScheduledTaskStoreShape,
  task: import("@t3tools/contracts").ScheduledTask,
  threadId: string,
) =>
  Effect.gen(function* () {
    const { sql } = store;
    const at = task.createdAt;
    yield* sql`INSERT OR IGNORE INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${task.projectId},'Project','/repo','[]',${at},${at})`;
    yield* sql`INSERT OR IGNORE INTO projection_threads(thread_id,project_id,title,model,model_selection_json,runtime_mode,created_at,last_interaction_at,updated_at) VALUES(${threadId},${task.projectId},'Scheduled',${task.modelSelection.model},${JSON.stringify(task.modelSelection)},${task.runtimeMode},${at},${at},${at})`;
  });
