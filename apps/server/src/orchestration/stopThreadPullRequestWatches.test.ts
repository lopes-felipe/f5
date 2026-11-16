import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeNextTurnQueueStore } from "../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { makePullRequestWatchStore } from "./PullRequestWatchStore.ts";
import { PullRequestKey } from "@t3tools/contracts";
import { stopThreadPullRequestWatches } from "./stopThreadPullRequestWatches.ts";

it.effect("atomically cancels saved watches and pending wakes while preserving admitted work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-10-19T12:00:00.000Z";
    const threadId = ThreadId.makeUnsafe("durable-watch-stop");
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,default_model,scripts_json,created_at,updated_at,deleted_at) VALUES(${ProjectId.makeUnsafe("p")},'P','/tmp',NULL,'[]',${at},${at},NULL)`;
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,branch,worktree_path,latest_turn_id,archived_at,created_at,last_interaction_at,updated_at,deleted_at) VALUES(${threadId},'p','T','gpt-5.1-codex',NULL,NULL,NULL,NULL,${at},${at},${at},NULL)`;
    const watches = yield* makePullRequestWatchStore;
    yield* watches.start({
      threadId,
      key: PullRequestKey.makeUnsafe("github:github.com/org/repo#1"),
      accountId: "one",
      watch: {
        startedAt: at,
        headSha: "head",
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: at,
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
    });
    const queue = yield* makeNextTurnQueueStore;
    for (const id of ["pending", "accepted", "ordinary"]) {
      const command: ThreadTurnStartCommand = {
        type: "thread.turn.start",
        threadId,
        commandId: CommandId.makeUnsafe(id),
        message: { messageId: MessageId.makeUnsafe(id), role: "user", text: id, attachments: [] },
        model: "gpt-5.1-codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: at,
        presentation: "continuation",
      };
      yield* queue.insertSubmission({
        command,
        submissionId: command.commandId,
        itemId: command.commandId,
        requestHash: id,
        submissionSource: "automation",
        ...(id !== "ordinary" ? { scheduleReason: "pull_request_watch" as const } : {}),
        atHead: false,
      });
    }
    yield* sql`INSERT INTO orchestration_command_receipts(command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,error) VALUES('accepted','thread',${threadId},${at},1,'accepted',NULL)`;
    yield* sql.withTransaction(stopThreadPullRequestWatches(sql, threadId, at));
    assert.lengthOf(yield* watches.list(threadId), 0);
    assert.deepStrictEqual(
      (yield* queue.listByThread(threadId)).items.map((item) => item.itemId),
      ["accepted", "ordinary"],
    );
    assert.equal(
      (yield* queue.getBySubmissionId(CommandId.makeUnsafe("pending")))?.disposition,
      "canceled",
    );
    yield* sql.withTransaction(stopThreadPullRequestWatches(sql, threadId, at));
    assert.lengthOf((yield* queue.listByThread(threadId)).items, 2);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqlitePersistenceMemory,
        ServerConfig.layerTest(process.cwd(), { prefix: "watch-stop-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
