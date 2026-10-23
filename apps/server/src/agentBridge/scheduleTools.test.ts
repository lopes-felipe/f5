import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { ProjectId, type ScheduledTask } from "@t3tools/contracts";
import { setup, testLayer } from "../scheduledTasks/testing.ts";
import { userScheduleActor } from "../scheduledTasks/Service.ts";
import { scheduledSendGate } from "../scheduledTasks/sendGate.ts";
import { makeAgentBridgeStore } from "./AgentBridgeStore.ts";
import { makeAgentBridgeLimiters } from "./rateLimits.ts";
import { makeScheduleTools } from "./scheduleTools.ts";
import type { AgentBridgeCaller } from "./threadTools.ts";

const setupTools = Effect.gen(function* () {
  const fixture = yield* setup;
  const bridge = makeAgentBridgeStore(fixture.store.sql);
  yield* bridge.ensureLocalClient;
  yield* fixture.settings.updateSettings({
    agentBridge: { enabled: true, exposedProjectIds: [ProjectId.makeUnsafe("project")] },
  });
  fixture.host.settings = yield* fixture.settings.getSettings;
  let limiterTime = 0;
  const tools = makeScheduleTools({
    service: fixture.service,
    store: bridge,
    host: fixture.host.shape,
    limiters: makeAgentBridgeLimiters(() => limiterTime),
  });
  const caller = (id = "local") =>
    bridge.getClient(id).pipe(
      Effect.map(
        (client) =>
          ({
            client: client!,
            visibleProjectIds: new Set(["project"]),
          }) satisfies AgentBridgeCaller,
      ),
    );
  const grant = (enabled: boolean) =>
    Effect.gen(function* () {
      const client = (yield* bridge.getClient("local"))!;
      yield* bridge.setSchedulingGrant({
        clientId: "local",
        enabled,
        expectedGrantGeneration: client.grantGeneration,
      });
      yield* fixture.service.revalidateAuthorities;
    });
  const call = (name: string, args: unknown, id = "local") =>
    caller(id).pipe(
      Effect.flatMap((caller) => tools.find((tool) => tool.name === name)!.run(args, caller)),
    );
  const tick = Effect.sync(() => {
    limiterTime += 1000;
  }).pipe(Effect.andThen(TestClock.adjust("1 second")));
  const create = (id: string = crypto.randomUUID(), extra = {}) =>
    call("create_scheduled_task", {
      clientRequestId: id,
      projectId: "project",
      name: "Check",
      prompt: "Run tests",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      workspace: { kind: "projectRoot" },
      ...extra,
    });
  return { ...fixture, bridge, tools, caller, grant, call, tick, createTask: create };
});
const savedTask = (result: unknown) => (result as { task: ScheduledTask }).task;
it.effect(
  "does not implicitly grant scheduling and echoes validated cron on an explicitly granted create",
  () =>
    Effect.gen(function* () {
      const f = yield* setupTools;
      expect((yield* f.bridge.getClient("local"))!.scopes).not.toContain("f5.schedules");
      expect((yield* Effect.result(f.createTask()))._tag).toBe("Failure");
      yield* f.grant(true);
      const argsId = crypto.randomUUID();
      const created = yield* f.createTask(argsId);
      const task = savedTask(created);
      expect(task.createdBy).toBe("agent");
      expect(task.runtimeMode).toBe("approval-required");
      expect(
        (created as { schedule: { nextFireTimes: string[] } }).schedule.nextFireTimes,
      ).toHaveLength(5);
      expect(yield* f.createTask(argsId)).toEqual(created);
      expect(yield* f.store.tasks()).toHaveLength(1);
      expect((yield* Effect.result(f.createTask(argsId, { prompt: "Other" })))._tag).toBe(
        "Failure",
      );
      expect(JSON.stringify(created)).not.toContain("/repo");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect(
  "rejects nonsupervised modes and hides projects, while user nonsupervised tasks remain read-only",
  () =>
    Effect.gen(function* () {
      const f = yield* setupTools;
      yield* f.grant(true);
      expect(
        (yield* Effect.result(f.createTask(undefined, { runtimeMode: "full-access" })))._tag,
      ).toBe("Failure");
      expect((yield* Effect.result(f.createTask(undefined, { projectId: "hidden" })))._tag).toBe(
        "Failure",
      );
      const { task } = yield* f.create({ runtimeMode: "full-access" });
      const result = yield* Effect.result(
        f.call("delete_scheduled_task", {
          taskId: task.id,
          expectedVersion: task.version,
          clientRequestId: "no-delete",
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(yield* f.store.task(task.id)).not.toBeNull();
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("replays create, update, run and delete after a crash before receipt completion", () =>
  Effect.gen(function* () {
    const f = yield* setupTools;
    yield* f.grant(true);
    const task = savedTask(yield* f.createTask("create"));
    yield* f.store
      .sql`UPDATE agent_bridge_requests SET status='pending',result_json=NULL WHERE namespace='schedules:local' AND request_id='create'`;
    expect(savedTask(yield* f.createTask("create")).id).toBe(task.id);
    const update = {
      taskId: task.id,
      clientRequestId: "update",
      expectedVersion: task.version,
      configuration: {
        name: "Renamed",
        prompt: task.prompt,
        cron: task.cron,
        timezone: task.timezone,
      },
    };
    const changed = savedTask(yield* f.call("update_scheduled_task", update));
    yield* f.store
      .sql`UPDATE agent_bridge_requests SET status='pending',result_json=NULL WHERE namespace='schedules:local' AND request_id='update'`;
    expect(savedTask(yield* f.call("update_scheduled_task", update)).version).toBe(changed.version);
    const run = { taskId: task.id, clientRequestId: "run" };
    yield* f.call("run_scheduled_task", run);
    yield* f.store
      .sql`UPDATE agent_bridge_requests SET status='pending',result_json=NULL WHERE namespace='schedules:local' AND request_id='run'`;
    yield* f.call("run_scheduled_task", run);
    expect(yield* f.store.history(task.id)).toHaveLength(1);
    const remove = { taskId: task.id, clientRequestId: "delete", expectedVersion: changed.version };
    yield* f.call("delete_scheduled_task", remove);
    yield* f.store
      .sql`UPDATE agent_bridge_requests SET status='pending',result_json=NULL WHERE namespace='schedules:local' AND request_id='delete'`;
    expect(yield* f.call("delete_scheduled_task", remove)).toEqual({ deleted: task.id });
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect(
  "revocation fences pending work and regrant never silently resumes it; a user can adopt it",
  () =>
    Effect.gen(function* () {
      const f = yield* setupTools;
      yield* f.grant(true);
      const task = savedTask(yield* f.createTask());
      yield* f.call("run_scheduled_task", { taskId: task.id, clientRequestId: "fire" });
      const pending = (yield* f.store.active)[0]!;
      yield* f.service.reserve(pending);
      const reserved = (yield* f.store.run(pending.run.id))!;
      yield* f.store.sql`UPDATE scheduled_control SET ready=1 WHERE id=1`;
      expect(
        yield* scheduledSendGate(
          f.store.sql,
          yield* f.settings.getSettings,
          reserved.submissionId!,
        ),
      ).toBe("ready");
      yield* f.grant(false);
      expect((yield* f.store.task(task.id))!.task.enabled).toBe(false);
      expect((yield* f.store.run(pending.run.id))!.owner).toBe(false);
      expect(
        yield* scheduledSendGate(
          f.store.sql,
          yield* f.settings.getSettings,
          reserved.submissionId!,
        ),
      ).toBe("cancel");
      yield* f.grant(true);
      const current = (yield* f.store.task(task.id))!.task;
      expect(current.enabled).toBe(false);
      expect(
        (yield* Effect.result(
          f.call("run_scheduled_task", { taskId: task.id, clientRequestId: "not-resumed" }),
        ))._tag,
      ).toBe("Failure");
      const adopted = yield* f.service.setEnabled(
        { id: current.id, expectedVersion: current.version, enabled: true },
        userScheduleActor,
      );
      expect(adopted.authority.kind).toBe("user");
      expect(adopted.createdBy).toBe("agent");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("enforces client ownership and refreshed visibility for every lookup", () =>
  Effect.gen(function* () {
    const f = yield* setupTools;
    yield* f.grant(true);
    const task = savedTask(yield* f.createTask());
    yield* f.store
      .sql`INSERT INTO agent_bridge_clients(id,kind,name,label,scopes_json,project_ids_json,grant_generation,created_at) VALUES('other','dcr','Other',NULL,'["f5.read","f5.schedules"]','["project"]',0,${new Date(0).toISOString()})`;
    expect(
      (yield* Effect.result(
        f.call(
          "delete_scheduled_task",
          { taskId: task.id, expectedVersion: task.version, clientRequestId: "takeover" },
          "other",
        ),
      ))._tag,
    ).toBe("Failure");
    yield* f.settings.updateSettings({ agentBridge: { exposedProjectIds: [] } });
    f.host.settings = yield* f.settings.getSettings;
    expect((yield* f.call("list_scheduled_tasks", {})) as { tasks: unknown[] }).toEqual(
      expect.objectContaining({ tasks: [] }),
    );
    expect(
      (yield* Effect.result(f.call("list_scheduled_task_runs", { taskId: task.id })))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("caps owned active schedules at twenty, including agent re-enablement", () =>
  Effect.gen(function* () {
    const f = yield* setupTools;
    yield* f.grant(true);
    const first = savedTask(yield* f.createTask());
    for (let index = 1; index < 20; index++) {
      yield* f.tick;
      yield* f.createTask();
    }
    yield* f.tick;
    expect((yield* Effect.result(f.createTask()))._tag).toBe("Failure");
    const actor = {
      kind: "agent" as const,
      clientId: "local",
      grantGeneration: (yield* f.bridge.getClient("local"))!.grantGeneration,
      visibleProjectIds: new Set(["project"]),
    };
    const disabled = yield* f.service.setEnabled(
      { id: first.id, expectedVersion: first.version, enabled: false },
      actor,
    );
    yield* f.tick;
    yield* f.createTask();
    expect(
      (yield* Effect.result(
        f.service.setEnabled(
          { id: first.id, expectedVersion: disabled.version, enabled: true },
          actor,
        ),
      ))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect(
  "rate limits scheduling mutations independently and counts manual thread admission once",
  () =>
    Effect.gen(function* () {
      const f = yield* setupTools;
      yield* f.grant(true);
      const task = savedTask(yield* f.createTask());
      for (let i = 0; i < 9; i++)
        yield* f.call("run_scheduled_task", { taskId: task.id, clientRequestId: `manual-${i}` });
      expect((yield* Effect.result(f.createTask()))._tag).toBe("Failure");
      yield* f.tick;
      yield* f.call("run_scheduled_task", { taskId: task.id, clientRequestId: "tenth" });
      yield* f.tick;
      expect(
        (yield* Effect.result(
          f.call("run_scheduled_task", { taskId: task.id, clientRequestId: "eleventh" }),
        ))._tag,
      ).toBe("Failure");
      yield* f.call("run_scheduled_task", { taskId: task.id, clientRequestId: "tenth" });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect(
  "serves real local MCP scheduling calls only after activation and an explicit grant",
  () =>
    Effect.gen(function* () {
      const f = yield* setupTools;
      const fs = yield* Effect.promise(() => import("node:fs/promises"));
      const os = yield* Effect.promise(() => import("node:os"));
      const path = yield* Effect.promise(() => import("node:path"));
      const { makeAgentBridgeService } = yield* Effect.promise(
        () => import("./AgentBridgeService.ts"),
      );
      const { makeBotTaskStore } = yield* Effect.promise(() => import("./BotTaskStore.ts"));
      const dir = yield* Effect.promise(() =>
        fs.mkdtemp(path.join(os.tmpdir(), "f5-scheduled-mcp-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      );
      const bridgeService = yield* makeAgentBridgeService({
        host: f.host.shape,
        store: f.bridge,
        tasks: makeBotTaskStore(f.store.sql),
        schedules: f.service,
        settingsChanges: f.settings.streamChanges,
        stateDir: dir,
        serverVersion: "test",
        stdio: { desktop: null, cli: { command: "f5", args: ["agent-bridge-stdio"], env: {} } },
        publish: () => Effect.void,
      });
      const state = yield* bridgeService.getState;
      expect(state.local.status).toBe("running");
      const credentials = JSON.parse(
        yield* Effect.promise(() =>
          fs.readFile(path.join(dir, "agent-bridge", "local.json"), "utf8"),
        ),
      ) as { token: string; port: number };
      let id = 0;
      const rpc = (method: string, params: unknown = {}) =>
        Effect.promise(async () => {
          const response = await fetch(`http://127.0.0.1:${credentials.port}/mcp`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${credentials.token}`,
              "content-type": "application/json",
              "mcp-protocol-version": "2025-06-18",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          });
          expect(response.status).toBe(200);
          return (await response.json()) as {
            result: {
              tools?: Array<{ name: string }>;
              isError?: boolean;
              structuredContent?: { task?: ScheduledTask; runs?: unknown[] };
            };
          };
        });
      const before = yield* rpc("tools/list");
      expect(before.result.tools!.some((t) => t.name === "create_scheduled_task")).toBe(false);
      yield* bridgeService.setSchedulingGrant({
        clientId: "local",
        expectedGrantGeneration: 0,
        enabled: true,
      });
      const after = yield* rpc("tools/list");
      expect(after.result.tools!.filter((t) => t.name.includes("scheduled"))).toHaveLength(6);
      const args = {
        clientRequestId: "mcp-create",
        projectId: "project",
        name: "MCP task",
        prompt: "Check tests",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
        workspace: { kind: "projectRoot" },
      };
      const created = yield* rpc("tools/call", { name: "create_scheduled_task", arguments: args });
      expect(created.result.isError).not.toBe(true);
      const task = created.result.structuredContent!.task!;
      expect(task.createdBy).toBe("agent");
      expect(task.runtimeMode).toBe("approval-required");
      expect(
        (yield* rpc("tools/call", {
          name: "create_scheduled_task",
          arguments: { ...args, clientRequestId: "unsafe", runtimeMode: "full-access" },
        })).result.isError,
      ).toBe(true);
      const run = yield* rpc("tools/call", {
        name: "run_scheduled_task",
        arguments: { taskId: task.id, clientRequestId: "mcp-run" },
      });
      expect(run.result.isError).not.toBe(true);
      yield* bridgeService.setSchedulingGrant({
        clientId: "local",
        expectedGrantGeneration: 1,
        enabled: false,
      });
      expect((yield* f.store.task(task.id))!.task.enabled).toBe(false);
      expect(
        (yield* rpc("tools/call", {
          name: "run_scheduled_task",
          arguments: { taskId: task.id, clientRequestId: "revoked" },
        })).result.isError,
      ).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "keeps user-owned supervised tasks readable but rejects agent update, run and delete",
  () =>
    Effect.gen(function* () {
      const f = yield* setupTools;
      yield* f.grant(true);
      const { task } = yield* f.create();
      const caller = yield* f.caller();
      expect(
        (yield* f.service.get(
          { id: task.id },
          {
            kind: "agent",
            clientId: caller.client.id,
            grantGeneration: caller.client.grantGeneration,
            visibleProjectIds: caller.visibleProjectIds,
          },
        )).task.id,
      ).toBe(task.id);
      const configuration = {
        name: "Agent rename",
        prompt: task.prompt,
        cron: task.cron,
        timezone: task.timezone,
      };
      for (const [tool, args] of [
        ["update_scheduled_task", { expectedVersion: task.version, configuration }],
        ["run_scheduled_task", {}],
        ["delete_scheduled_task", { expectedVersion: task.version }],
      ] as const) {
        const result = yield* Effect.result(
          f.call(tool, { taskId: task.id, clientRequestId: tool, ...args }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.message).toContain("user-owned");
      }
      yield* f.grant(false);
      const current = (yield* f.store.task(task.id))!.task;
      expect(current.authority).toEqual({ kind: "user" });
      expect(current.enabled).toBe(true);
      expect(current.version).toBe(task.version);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("MCP can disable its own task after the configured provider disappears", () =>
  Effect.gen(function* () {
    const f = yield* setupTools;
    yield* f.grant(true);
    const task = savedTask(yield* f.createTask());
    f.host.providers = [];
    const result = savedTask(
      yield* f.call("update_scheduled_task", {
        taskId: task.id,
        expectedVersion: task.version,
        clientRequestId: "offline-disable",
        configuration: {
          name: task.name,
          prompt: task.prompt,
          cron: task.cron,
          timezone: task.timezone,
          enabled: false,
        },
      }),
    );
    expect(result.enabled).toBe(false);
    expect(result.modelSelection).toEqual(task.modelSelection);
    expect(result.authority).toBeUndefined(); // Tool echoes never expose execution authority.
    expect((yield* f.store.task(task.id))!.task.authority).toEqual(
      task.authority ?? {
        kind: "agent",
        clientId: "local",
        grantGeneration: (yield* f.caller()).client.grantGeneration,
      },
    );
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("MCP metadata edits preserve an expired one-shot without probing its provider", () =>
  Effect.gen(function* () {
    const f = yield* setupTools;
    yield* f.grant(true);
    const task = savedTask(yield* f.createTask(undefined, { cron: "0 1 0 1 1 * 1970" }));
    yield* TestClock.adjust("2 minutes");
    f.host.providers = [];
    const result = (yield* f.call("update_scheduled_task", {
      taskId: task.id,
      expectedVersion: task.version,
      clientRequestId: "expired-metadata",
      configuration: {
        name: "Expired, renamed",
        prompt: task.prompt,
        cron: task.cron,
        timezone: task.timezone,
      },
    })) as { task: ScheduledTask; schedule: { nextFireTimes: string[] } };
    expect(result.task.name).toBe("Expired, renamed");
    expect(result.task.oneShotAt).toBe(task.oneShotAt);
    expect(result.task.maxRuns).toBe(1);
    expect(result.schedule.nextFireTimes).toEqual([]);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
