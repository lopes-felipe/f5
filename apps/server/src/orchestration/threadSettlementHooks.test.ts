import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  OrchestrationThread,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type ProjectScript,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Schema, Stream, type Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { makeFakeGitCore } from "../git/testDoubles.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { makeThreadSettlementHooks } from "./threadSettlementHooks.ts";

const at = "2026-10-19T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("settlement-hooks");
const projectId = ProjectId.makeUnsafe("project");
const script = (id: string, command: string): ProjectScript => ({
  id,
  name: id,
  command,
  icon: "play",
  runOnWorktreeCreate: false,
  runOnWorktreeSettle: true,
});
const fixture = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const root = Path.join(config.baseDir, "project");
  const worktree = Path.join(config.baseDir, "worktree");
  yield* Effect.promise(async () => {
    await FS.mkdir(root, { recursive: true });
    await FS.mkdir(worktree, { recursive: true });
    await FS.writeFile(Path.join(worktree, ".git"), "gitdir: ../project/.git/worktrees/test\n");
  });
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,default_model,scripts_json,created_at,updated_at,deleted_at) VALUES(${projectId},'P',${root},NULL,'[]',${at},${at},NULL)`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,branch,worktree_path,latest_turn_id,archived_at,created_at,last_interaction_at,updated_at,deleted_at,settled_at,settled_by) VALUES(${threadId},${projectId},'T','gpt-5.1-codex',NULL,${worktree},NULL,NULL,${at},${at},${at},NULL,${at},'user')`;
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  const notices: string[] = [];
  const state = {
    thread: Schema.decodeUnknownSync(OrchestrationThread)({
      id: threadId,
      projectId,
      title: "T",
      model: "model",
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: worktree,
      latestTurn: null,
      settledAt: at,
      settledBy: "user",
      createdAt: at,
      lastInteractionAt: at,
      updatedAt: at,
      deletedAt: null,
      messages: [],
      tasksTurnId: null,
      tasksUpdatedAt: null,
      activities: [],
      checkpoints: [],
      session: null,
    }),
  };
  const project = {
    id: projectId,
    title: "P",
    workspaceRoot: root,
    defaultModel: null,
    scripts: [],
    memories: [],
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  const hooks = yield* makeThreadSettlementHooks.pipe(
    Effect.provideService(
      GitCore,
      makeFakeGitCore({ resolveCommonDir: () => Effect.succeed(root) }).service,
    ),
    Effect.provide(
      Layer.mock(OrchestrationEngineService)({
        getReadModel: () =>
          Effect.succeed({
            snapshotSequence: 1,
            threads: [state.thread],
            projects: [project],
            planningWorkflows: [],
            codeReviewWorkflows: [],
            investigationWorkflows: [],
            updatedAt: at,
          }),
        streamDomainEvents: Stream.fromPubSub(events),
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type === "thread.activity.append") notices.push(command.activity.summary);
            return { sequence: 2 };
          }),
      }),
    ),
  );
  const insert = (scripts: readonly ProjectScript[], status = "pending") =>
    sql`INSERT INTO thread_settlement_hooks(thread_id,job_id,settled_at,worktree_path,project_id,scripts_json,state,updated_at) VALUES(${threadId},'job',${at},${worktree},${projectId},${JSON.stringify(scripts)},${status},${at})`;
  const status = () =>
    sql<{ state: string }>`SELECT state FROM thread_settlement_hooks`.pipe(
      Effect.map((rows) => rows[0]?.state),
    );
  const exists = (file: string) =>
    Effect.promise(() =>
      FS.access(Path.join(worktree, file)).then(
        () => true,
        () => false,
      ),
    );
  return { sql, hooks, root, worktree, notices, state, events, insert, status, exists };
});
function run<A, E>(test: (f: Effect.Success<typeof fixture>) => Effect.Effect<A, E, Scope.Scope>) {
  return Effect.scoped(fixture.pipe(Effect.flatMap(test))).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqlitePersistenceMemory,
        ServerConfig.layerTest(process.cwd(), { prefix: "f5-settle-hooks-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
}
it.effect(
  "executes captured scripts in the linked worktree before releasing their durable claim",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.insert([
          script("write", `node -e "require('fs').writeFileSync('hook-marker','done')"`),
        ]);
        yield* f.hooks.drain;
        assert.equal(yield* f.status(), "completed");
        assert.isTrue(yield* f.exists("hook-marker"));
        assert.isFalse(
          yield* Effect.promise(() =>
            FS.access(Path.join(f.root, "hook-marker")).then(
              () => true,
              () => false,
            ),
          ),
        );
      }),
    ),
);
it.effect("continues later hooks after a failure and exposes only a fixed failure notice", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.insert([
        script("fail", `node -e "console.error('private-output');process.exit(1)"`),
        script("continue", `node -e "require('fs').writeFileSync('after-failure','done')"`),
      ]);
      yield* f.hooks.drain;
      assert.equal(yield* f.status(), "failed");
      assert.isTrue(yield* f.exists("after-failure"));
      assert.lengthOf(f.notices, 1);
      assert.isFalse(f.notices.join().includes("private-output"));
    }),
  ),
);
it.effect("cancels an obsolete pending hook instead of executing it after a wake", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.insert([
        script("stale", `node -e "require('fs').writeFileSync('stale-marker','bad')"`),
      ]);
      f.state.thread = { ...f.state.thread, settledAt: null, settledBy: null };
      yield* f.sql`UPDATE projection_threads SET settled_at=NULL,settled_by=NULL WHERE thread_id=${threadId}`;
      yield* f.hooks.drain;
      assert.equal(yield* f.status(), "canceled");
      assert.isFalse(yield* f.exists("stale-marker"));
    }),
  ),
);
it.effect(
  "retains an unverified interrupted process claim after a crash and never replays its script",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.insert(
          [script("interrupted", `node -e "require('fs').writeFileSync('must-not-replay','bad')"`)],
          "running",
        );
        yield* f.hooks.recover;
        yield* f.hooks.drain;
        assert.equal(yield* f.status(), "orphaned");
        assert.isFalse(yield* f.exists("must-not-replay"));
        assert.match(f.notices[0]!, /not replayed/);
      }),
    ),
);
it.effect("a wake cancels an owned process and records cancellation after the process exits", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.insert([
        script(
          "wait",
          `node -e "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"`,
        ),
      ]);
      yield* f.hooks.start;
      const waitFor = <A, E>(read: Effect.Effect<A, E>, matches: (value: A) => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 500; attempt++) {
            const value = yield* read;
            if (matches(value)) return value;
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
          }
          return yield* Effect.die("Hook lifecycle did not reach the expected state");
        });
      yield* waitFor(f.exists("started"), Boolean);
      f.state.thread = { ...f.state.thread, settledAt: null, settledBy: null };
      yield* f.sql`UPDATE projection_threads SET settled_at=NULL,settled_by=NULL WHERE thread_id=${threadId}`;
      const event: OrchestrationEvent = {
        sequence: 2,
        eventId: EventId.makeUnsafe("wake"),
        type: "thread.unsettled",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at,
        commandId: CommandId.makeUnsafe("wake"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("wake"),
        metadata: {},
        payload: { threadId, reason: "wake" },
      };
      yield* PubSub.publish(f.events, event);
      yield* waitFor(f.status(), (value) => value === "canceled");
      assert.equal(yield* f.status(), "canceled");
    }),
  ),
);
