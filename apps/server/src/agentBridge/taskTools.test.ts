import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ThreadId } from "@t3tools/contracts";
import { Duration, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { pruneAgentBridgeHistory } from "./AgentBridgeService.ts";
import { makeAgentBridgeStore, type AgentBridgeClientRecord } from "./AgentBridgeStore.ts";
import { BotTaskError, makeBotTaskStore } from "./BotTaskStore.ts";
import { makeAgentBridgeLimiters } from "./rateLimits.ts";
import { makeTaskOperator, progressRetentionBoundary } from "./taskOperator.ts";
import { makeTaskTools } from "./taskTools.ts";
import { FakeAgentBridgeHost, project, thread } from "./testing/fakeHost.ts";
import type {
  AgentBridgeCaller,
  AgentBridgeToolDefinition,
  AgentBridgeToolError,
} from "./threadTools.ts";

const layer = it.layer(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer)));

const setup = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = makeAgentBridgeStore(sql);
    const tasks = makeBotTaskStore(sql);
    yield* store.ensureLocalClient;
    // The database is shared across tests, so ids must be unique per setup.
    const prefix = crypto.randomUUID().slice(0, 8);
    const clientId = `client-${prefix}`;
    yield* sql`INSERT INTO agent_bridge_clients
        (id, kind, name, scopes_json, project_ids_json, grant_generation, created_at)
      VALUES (${clientId}, 'dcr', 'Test Dot', '["f5.read","f5.tasks"]', '["exposed"]', 0,
        '2026-01-01T00:00:00.000Z')`;
    const client = (yield* store.getClient(clientId)) as AgentBridgeClientRecord;
    const host = new FakeAgentBridgeHost();
    host.projects = [project("exposed"), project("hidden")];
    host.threads = [thread(`source-${prefix}`, "exposed")];
    let clock = Date.parse("2026-10-01T00:00:00.000Z");
    const now = () => new Date(clock);
    const advance = (ms: number) => {
      clock += ms;
    };
    let counter = 0;
    const mintId = () => `${prefix}-${++counter}`;
    const changes: Array<ReadonlyArray<string>> = [];
    const tools = makeTaskTools({
      host: host.shape,
      tasks,
      limiters: makeAgentBridgeLimiters(() => clock),
      mintId,
      now,
      onWorkspaceChanged: (_revision, ids) => changes.push(ids),
    });
    const operator = makeTaskOperator({
      host: host.shape,
      store,
      tasks,
      settings: () => ({
        ...DEFAULT_SERVER_SETTINGS.agentBridge,
        enabled: true,
        exposedProjectIds: [ProjectId.makeUnsafe("exposed")],
      }),
      visibleProjectIds: () => new Set(["exposed"]),
      onWorkspaceChanged: (_revision, ids) => changes.push(ids),
      mintId,
      now,
    });
    const caller: AgentBridgeCaller = { client, visibleProjectIds: new Set(["exposed"]) };
    type RunResult =
      | { readonly ok: true; readonly value: any; readonly error?: undefined }
      | { readonly ok: false; readonly value?: any; readonly error: AgentBridgeToolError };
    const run = (name: string, args: Record<string, unknown>, as: AgentBridgeCaller = caller) =>
      (tools.find((entry) => entry.name === name) as AgentBridgeToolDefinition).run(args, as).pipe(
        Effect.map((value): RunResult => ({ ok: true, value })),
        Effect.catchTag("AgentBridgeToolError", (error) =>
          Effect.succeed<RunResult>({ ok: false, error }),
        ),
      );
    let op = 0;
    const opId = (label = "op") => `${prefix}-${label}-${++op}`;
    const createTask = (overrides: Record<string, unknown> = {}) =>
      operator.createTask({
        operationId: opId("create"),
        clientId,
        projectId: ProjectId.makeUnsafe("exposed"),
        title: "Summarize open PRs",
        instructions: "Read the open PRs and summarize them.",
        ...overrides,
      });
    const claim = (taskId: string) =>
      run("claim_task", { taskId, operationId: opId("claim") }).pipe(
        Effect.map((result) => result.value.executionEpoch as number),
      );
    const attempt = <A>(effect: Effect.Effect<A, BotTaskError>) =>
      effect.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchTag("BotTaskError", (error) => Effect.succeed({ ok: false as const, error })),
      );
    return {
      sql,
      store,
      tasks,
      tools,
      operator,
      caller,
      client,
      clientId,
      host,
      prefix,
      run,
      opId,
      createTask,
      claim,
      attempt,
      advance,
      now,
      changes,
    };
  });

layer("Agent Bridge task board", (it) => {
  it.effect("exposes the task tools under the f5.tasks scope", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup();
      assert.deepStrictEqual(
        tools.map((tool) => tool.name),
        [
          "list_tasks",
          "get_task",
          "claim_task",
          "report_task_progress",
          "request_task_input",
          "complete_task",
          "fail_task",
        ],
      );
      for (const tool of tools) assert.strictEqual(tool.scope, "f5.tasks");
    }),
  );

  it.effect("a retried create produces one task; a changed retry conflicts", () =>
    Effect.gen(function* () {
      const { operator, clientId, attempt, tasks, prefix } = yield* setup();
      const input = {
        operationId: `${prefix}-create-retry`,
        clientId,
        projectId: ProjectId.makeUnsafe("exposed"),
        title: "Task",
        instructions: "Do it.",
      };
      const first = yield* operator.createTask(input);
      const second = yield* operator.createTask(input);
      assert.strictEqual(second.id, first.id);
      const page = yield* tasks.listTasks({ clientId });
      assert.strictEqual(page.tasks.length, 1);
      const conflict = yield* attempt(operator.createTask({ ...input, title: "Other" }));
      assert.isFalse(conflict.ok);
      if (!conflict.ok) assert.strictEqual(conflict.error.code, "conflict");
    }),
  );

  it.effect("creation requires a shared project and an existing source thread", () =>
    Effect.gen(function* () {
      const { createTask, attempt, prefix } = yield* setup();
      const hidden = yield* attempt(createTask({ projectId: ProjectId.makeUnsafe("hidden") }));
      assert.isFalse(hidden.ok);
      const missingThread = yield* attempt(
        createTask({ sourceThreadId: ThreadId.makeUnsafe("missing") }),
      );
      assert.isFalse(missingThread.ok);
      const withThread = yield* createTask({
        sourceThreadId: ThreadId.makeUnsafe(`source-${prefix}`),
      });
      assert.strictEqual(withThread.sourceThreadId, `source-${prefix}`);
      assert.strictEqual(withThread.clientName, "Test Dot");
    }),
  );

  it.effect("payloads never include workspace paths", () =>
    Effect.gen(function* () {
      const { createTask, run } = yield* setup();
      const task = yield* createTask();
      const listed = yield* run("list_tasks", {});
      const read = yield* run("get_task", { taskId: task.id });
      const serialized = JSON.stringify([listed.value, read.value]);
      assert.notInclude(serialized, "/repo/");
      assert.strictEqual(read.value.project, "exposed");
      assert.strictEqual(read.value.instructions, "Read the open PRs and summarize them.");
    }),
  );

  it.effect("concurrent claims: exactly one wins", () =>
    Effect.gen(function* () {
      const { createTask, run, opId } = yield* setup();
      const task = yield* createTask();
      const results = yield* Effect.all(
        [
          run("claim_task", { taskId: task.id, operationId: opId() }),
          run("claim_task", { taskId: task.id, operationId: opId() }),
          run("claim_task", { taskId: task.id, operationId: opId() }),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter((result) => result.ok).length, 1);
    }),
  );

  it.effect("question, reply, second question, reply, then an immutable completion", () =>
    Effect.gen(function* () {
      const { createTask, claim, run, opId, operator, attempt } = yield* setup();
      const task = yield* createTask();
      const epoch = yield* claim(task.id);
      assert.strictEqual(epoch, 1);
      for (const answer of ["blue", "green"]) {
        const asked = yield* run("request_task_input", {
          taskId: task.id,
          executionEpoch: epoch,
          operationId: opId(),
          question: "Which color?",
        });
        assert.isTrue(asked.ok);
        const waiting = yield* operator.getTask(task.id);
        assert.strictEqual(waiting.status, "waiting-for-user");
        assert.strictEqual(waiting.pendingQuestion?.questionId, asked.value.questionId);
        const replied = yield* operator.replyToTask({
          operationId: opId("reply"),
          taskId: task.id,
          questionId: asked.value.questionId,
          expectedVersion: waiting.version,
          text: answer,
        });
        assert.strictEqual(replied.status, "running");
        assert.strictEqual(replied.executionEpoch, epoch);
      }
      const read = yield* run("get_task", { taskId: task.id });
      assert.deepStrictEqual(
        read.value.history
          .filter((entry: { type: string }) => entry.type === "reply")
          .map((entry: { content: string }) => entry.content),
        ["blue", "green"],
      );
      const completeArgs = {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId("complete"),
        result: "Done.",
      };
      const completed = yield* run("complete_task", completeArgs);
      assert.isTrue(completed.ok);
      // A repeated terminal operation returns its stored receipt.
      const repeated = yield* run("complete_task", completeArgs);
      assert.deepStrictEqual(repeated.value, completed.value);
      const failed = yield* run("fail_task", {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId(),
        reason: "Changed my mind.",
      });
      assert.isFalse(failed.ok);
      const cancel = yield* attempt(
        operator.controlTask("cancel", { operationId: opId(), taskId: task.id }),
      );
      assert.isFalse(cancel.ok);
      const final = yield* operator.getTask(task.id);
      assert.strictEqual(final.status, "completed");
      assert.strictEqual(final.result, "Done.");
    }),
  );

  it.effect("replying to a withdrawn question fails", () =>
    Effect.gen(function* () {
      const { createTask, claim, run, opId, operator, attempt, tasks } = yield* setup();
      const task = yield* createTask();
      const epoch = yield* claim(task.id);
      const asked = yield* run("request_task_input", {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId(),
        question: "Proceed?",
      });
      const paused = yield* operator.controlTask("pause", { operationId: opId(), taskId: task.id });
      assert.strictEqual(paused.status, "paused");
      assert.isNull(paused.pendingQuestion);
      const reply = yield* attempt(
        operator.replyToTask({
          operationId: opId(),
          taskId: task.id,
          questionId: asked.value.questionId,
          expectedVersion: paused.version,
          text: "yes",
        }),
      );
      assert.isFalse(reply.ok);
      const history = yield* tasks.listActivities({ taskId: task.id, limit: 50 });
      assert.include(
        history.activities.map((activity) => activity.type),
        "question-withdrawn",
      );
    }),
  );

  it.effect("a stale reply version is rejected", () =>
    Effect.gen(function* () {
      const { createTask, claim, run, opId, operator, attempt } = yield* setup();
      const task = yield* createTask();
      const epoch = yield* claim(task.id);
      const asked = yield* run("request_task_input", {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId(),
        question: "Proceed?",
      });
      const stale = yield* attempt(
        operator.replyToTask({
          operationId: opId(),
          taskId: task.id,
          questionId: asked.value.questionId,
          expectedVersion: 0,
          text: "yes",
        }),
      );
      assert.isFalse(stale.ok);
      if (!stale.ok) assert.strictEqual(stale.error.code, "stale-version");
    }),
  );

  it.effect("pause fences the old epoch; resume requires a fresh claim", () =>
    Effect.gen(function* () {
      const { createTask, claim, run, opId, operator } = yield* setup();
      const task = yield* createTask();
      const epoch = yield* claim(task.id);
      yield* operator.controlTask("pause", { operationId: opId(), taskId: task.id });
      const afterPause = yield* run("report_task_progress", {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId(),
        summary: "Still going",
      });
      assert.isFalse(afterPause.ok);
      const resumed = yield* operator.controlTask("resume", {
        operationId: opId(),
        taskId: task.id,
      });
      assert.strictEqual(resumed.status, "queued");
      const stale = yield* run("complete_task", {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId(),
        result: "Done",
      });
      assert.isFalse(stale.ok);
      if (!stale.ok) assert.match(stale.error.message, /epoch|Cannot complete/u);
      const next = yield* claim(task.id);
      assert.isAbove(next, epoch);
      const done = yield* run("complete_task", {
        taskId: task.id,
        executionEpoch: next,
        operationId: opId(),
        result: "Done",
      });
      assert.isTrue(done.ok);
    }),
  );

  it.effect("a grant change or revocation fences bot writes; client fencing pauses tasks", () =>
    Effect.gen(function* () {
      const { createTask, claim, run, opId, sql, clientId, tasks, operator, attempt, caller } =
        yield* setup();
      const task = yield* createTask();
      const epoch = yield* claim(task.id);
      yield* sql`UPDATE agent_bridge_clients SET grant_generation = grant_generation + 1
        WHERE id = ${clientId}`;
      const stale = yield* run("report_task_progress", {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId(),
        summary: "Working",
      });
      assert.isFalse(stale.ok);
      const fenced = yield* tasks.fenceTasks({
        clientId,
        reason: "Revoked",
        at: new Date().toISOString(),
      });
      assert.deepStrictEqual(fenced, [task.id]);
      const paused = yield* operator.getTask(task.id);
      assert.strictEqual(paused.status, "paused");
      assert.strictEqual(paused.executionEpoch, epoch + 1);
      yield* sql`UPDATE agent_bridge_clients SET revoked_at = '2026-10-01T00:00:00.000Z'
        WHERE id = ${clientId}`;
      const resume = yield* attempt(
        operator.controlTask("resume", { operationId: opId(), taskId: task.id }),
      );
      assert.isFalse(resume.ok);
      const revokedCaller = yield* run(
        "claim_task",
        { taskId: task.id, operationId: opId() },
        caller,
      );
      assert.isFalse(revokedCaller.ok);
    }),
  );

  it.effect("project deletion fences tasks and source-thread deletion clears the link", () =>
    Effect.gen(function* () {
      const { createTask, claim, tasks, operator, prefix } = yield* setup();
      const task = yield* createTask({ sourceThreadId: ThreadId.makeUnsafe(`source-${prefix}`) });
      yield* claim(task.id);
      const cleared = yield* tasks.clearSourceThread(`source-${prefix}`);
      assert.deepStrictEqual(cleared, [task.id]);
      assert.isNull((yield* operator.getTask(task.id)).sourceThreadId);
      const fenced = yield* tasks.fenceTasks({
        projectId: "exposed",
        reason: "The project was deleted.",
        at: new Date().toISOString(),
      });
      assert.include(fenced, task.id);
      assert.strictEqual((yield* operator.getTask(task.id)).status, "paused");
    }),
  );

  it.effect("a deleted project's tasks cannot be resumed, read, or claimed", () =>
    Effect.gen(function* () {
      const { createTask, run, opId, operator, host, attempt } = yield* setup();
      const task = yield* createTask();
      yield* operator.controlTask("pause", { operationId: opId(), taskId: task.id });
      // The project id stays in exposedProjectIds after deletion.
      host.projects = host.projects.map((entry) =>
        entry.id === "exposed" ? { ...entry, deletedAt: "2026-10-02T00:00:00.000Z" } : entry,
      );
      const resumed = yield* attempt(
        operator.controlTask("resume", { operationId: opId(), taskId: task.id }),
      );
      assert.isFalse(resumed.ok);
      assert.include(!resumed.ok ? resumed.error.message : "", "deleted");
      for (const name of ["get_task", "claim_task"]) {
        const result = yield* run(name, { taskId: task.id, operationId: opId() });
        assert.strictEqual(result.error?.message, "Task not found.");
      }
      const listed = yield* run("list_tasks", {});
      assert.deepStrictEqual(listed.value.tasks, []);
    }),
  );

  it.effect("progress is limited per task; identical retries are free", () =>
    Effect.gen(function* () {
      const { createTask, claim, run, opId, advance } = yield* setup();
      const task = yield* createTask();
      const epoch = yield* claim(task.id);
      const args = {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId("progress"),
        summary: "Halfway",
      };
      assert.isTrue((yield* run("report_task_progress", args)).ok);
      const retry = yield* run("report_task_progress", args);
      assert.isTrue(retry.ok);
      const tooSoon = yield* run("report_task_progress", { ...args, operationId: opId() });
      assert.isFalse(tooSoon.ok);
      if (!tooSoon.ok) assert.isAbove(tooSoon.error.retryAfterSeconds ?? 0, 0);
      advance(5_000);
      assert.isTrue((yield* run("report_task_progress", { ...args, operationId: opId() })).ok);
    }),
  );

  it.effect("task writes are limited to a burst of 10", () =>
    Effect.gen(function* () {
      const { createTask, run, opId } = yield* setup();
      const ids: string[] = [];
      for (let index = 0; index < 11; index++) ids.push((yield* createTask()).id);
      const results = [];
      for (const id of ids)
        results.push(yield* run("claim_task", { taskId: id, operationId: opId() }));
      assert.strictEqual(results.filter((result) => result.ok).length, 10);
      const limited = results.at(-1)!;
      assert.isFalse(limited.ok);
      if (!limited.ok) assert.strictEqual(limited.error.retryAfterSeconds, 1);
    }),
  );

  it.effect("pruning removes only progress older than 30 days", () =>
    Effect.gen(function* () {
      const { createTask, claim, run, opId, tasks, advance, now } = yield* setup();
      const task = yield* createTask();
      const epoch = yield* claim(task.id);
      yield* run("report_task_progress", {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId(),
        summary: "Old progress",
      });
      advance(31 * 24 * 60 * 60 * 1000);
      yield* run("report_task_progress", {
        taskId: task.id,
        executionEpoch: epoch,
        operationId: opId(),
        summary: "New progress",
      });
      yield* tasks.pruneProgress(progressRetentionBoundary(now()));
      const history = yield* tasks.listActivities({ taskId: task.id, limit: 50 });
      const types = history.activities.map((activity) => activity.type);
      assert.deepStrictEqual(
        history.activities
          .filter((activity) => activity.type === "progress")
          .map((activity) => activity.content),
        ["New progress"],
      );
      assert.include(types, "created");
      assert.include(types, "claimed");
    }),
  );

  it.effect("history pruning takes a fresh cutoff on every run and keeps pending receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeAgentBridgeStore(sql);
      const tasks = makeBotTaskStore(sql);
      // TestClock starts at the epoch, far before any other test's rows.
      const day = 24 * 60 * 60 * 1000;
      const at = new Date(10 * day).toISOString();
      const namespace = `prune-${crypto.randomUUID()}`;
      for (const requestId of ["done", "open"])
        yield* store.insertPendingRequest({
          namespace,
          requestId,
          tool: "send_message",
          argsHash: "hash",
          command: null,
          relatedIds: {},
          at,
        });
      yield* store.completeRequest({ namespace, requestId: "done", result: {}, at });

      yield* TestClock.adjust(Duration.millis(35 * day));
      assert.strictEqual((yield* pruneAgentBridgeHistory({ tasks, store })).receipts, 0);
      assert.isNotNull(yield* store.getRequest(namespace, "done"));

      yield* TestClock.adjust(Duration.millis(10 * day));
      assert.strictEqual((yield* pruneAgentBridgeHistory({ tasks, store })).receipts, 1);
      assert.isNull(yield* store.getRequest(namespace, "done"));
      assert.isNotNull(yield* store.getRequest(namespace, "open"));
    }),
  );

  it.effect("list_tasks is paginated and scoped to the caller's shared projects", () =>
    Effect.gen(function* () {
      const { createTask, run, caller } = yield* setup();
      yield* createTask();
      yield* createTask();
      const visible = yield* run("list_tasks", {});
      assert.strictEqual(visible.value.tasks.length, 2);
      const unshared = yield* run("list_tasks", {}, { ...caller, visibleProjectIds: new Set() });
      assert.strictEqual(unshared.value.tasks.length, 0);
    }),
  );
});
