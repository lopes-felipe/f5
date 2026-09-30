import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { makeConversationRewind } from "./rewind.ts";

const layer = it.layer(SqlitePersistenceMemory);
const at = "2026-09-30T12:00:00.000Z";
const harness = (
  name: string,
  failure: "persist" | "disconnect" | "capture" | "interrupt" | null = null,
  worktreePath: string | null = null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.makeUnsafe(name);
    const projectId = ProjectId.makeUnsafe(`project:${name}`);
    const messageId = MessageId.makeUnsafe(`message:${name}`);
    const operationId = CommandId.makeUnsafe(`rewind:${name}`);
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId}, 'No Git', '/tmp/no-git-phase8', '[]', ${at}, ${at})`;
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,created_at,last_interaction_at,updated_at) VALUES (${threadId}, ${projectId}, 'No Git', 'gpt-5-codex', ${at}, ${at}, ${at})`;
    yield* sql`INSERT INTO next_turn_queue_state(thread_id,paused,revision,updated_at) VALUES (${threadId},1,0,${at})`;
    const request = {
      type: "thread.conversation.revert" as const,
      commandId: operationId,
      operationId,
      threadId,
      targetMessageId: messageId,
      restoreFiles: false,
      createdAt: at,
    };
    yield* sql`INSERT INTO rewind_requests(operation_id, thread_id, payload_json, created_at) VALUES (${operationId}, ${threadId}, ${JSON.stringify(request)}, ${at})`;
    const fileActions: string[] = [];
    let rollbackCalls = 0;
    let identity = "provider-session";
    let providerTurns = [TurnId.makeUnsafe("first"), TurnId.makeUnsafe("second")];
    let failPersist = failure === "persist";
    let failCapture = failure === "capture";
    const model = {
      snapshotSequence: 3,
      projects: [{ id: projectId, workspaceRoot: "/tmp/no-git-phase8" }],
      threads: [
        {
          id: threadId,
          projectId,
          worktreePath,
          session: { providerName: worktreePath ? "opencode" : "codex" },
          messages: [{ id: messageId, text: "Recovered source", attachments: [] }],
          checkpoints: [],
        },
      ],
    };
    const rewind = yield* makeConversationRewind.pipe(
      Effect.provideService(ProviderService, {
        getCapabilities: () =>
          Effect.succeed({
            runtimeCapabilities: {
              conversationRollback: true,
              rollbackReadback: true,
              rollbackAffectsFiles: worktreePath !== null,
            },
          }),
        readThread: () =>
          Effect.sync(() => ({ threadId, turns: providerTurns.map((id) => ({ id, items: [] })) })),
        listSessions: () => Effect.sync(() => [{ threadId, resumeCursor: { threadId: identity } }]),
        rollbackConversation: ({ numTurns }: { numTurns: number }) =>
          Effect.suspend(() => {
            rollbackCalls++;
            fileActions.push("rollback");
            if (failure === "interrupt") return Effect.never;
            if (failure === "disconnect") return Effect.fail(new Error("Disconnected"));
            providerTurns = providerTurns.slice(0, -numTurns);
            return Effect.void;
          }),
      } as never),
      Effect.provideService(CheckpointStore, {
        hasCheckpointRef: () => Effect.succeed(false),
        captureCheckpoint: () =>
          worktreePath
            ? Effect.suspend(() => {
                if (failCapture) {
                  failCapture = false;
                  return Effect.fail(new Error("Checkpoint capture failed"));
                }
                fileActions.push("capture");
                return Effect.void;
              })
            : Effect.die("conversation-only must not access Git"),
        restoreCheckpoint: () =>
          worktreePath
            ? Effect.sync(() => {
                fileActions.push("restore");
                return true;
              })
            : Effect.die("conversation-only must not restore files"),
        deleteCheckpointRefs: () => Effect.void,
      } as never),
      Effect.provideService(ProjectionTurnRepository, {
        listByThreadId: () =>
          Effect.succeed([
            { turnId: "first", pendingMessageId: "earlier", requestedAt: at },
            {
              turnId: "second",
              pendingMessageId: messageId,
              requestedAt: "2026-09-30T12:01:00.000Z",
            },
          ]),
      } as never),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () => Effect.succeed(model),
        dispatch: (command: { type: string }) =>
          Effect.suspend(() => {
            if (command.type !== "thread.revert.complete") return Effect.succeed({ sequence: 4 });
            if (failPersist) {
              failPersist = false;
              return Effect.fail(new Error("Persistence unavailable after provider accepted"));
            }
            return sql`UPDATE rewind_operations SET state = 'completed' WHERE operation_id = ${operationId}`.pipe(
              Effect.as({ sequence: 4 }),
            );
          }),
      } as never),
    );
    return {
      rewind,
      request,
      operationId,
      fileActions,
      rollbackCalls: () => rollbackCalls,
      changeIdentity: () => {
        identity = "different-session";
      },
    };
  });
layer("conversation rewind recovery", (it) => {
  it.effect(
    "OpenCode keeps files by capturing before rollback and restoring after verified readback",
    () =>
      Effect.gen(function* () {
        const cwd = yield* Effect.acquireRelease(
          Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "f5-rewind-files-"))),
          (cwd) => Effect.sync(() => fs.rmSync(cwd, { recursive: true, force: true })),
        );
        const h = yield* harness("rewind-opencode-files", null, cwd);
        yield* h.rewind.run(h.request);
        assert.deepEqual(h.fileActions, ["capture", "rollback", "restore"]);
      }),
  );
  it.effect("retries preparation failures without treating them as ambiguous rollback", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "f5-rewind-retry-"))),
        (cwd) => Effect.sync(() => fs.rmSync(cwd, { recursive: true, force: true })),
      );
      const h = yield* harness("rewind-capture-retry", "capture", cwd);
      yield* h.rewind.run(h.request);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(h.rollbackCalls(), 0);
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]?.state,
        "prepared",
      );
      yield* h.rewind.run(h.request);
      assert.equal(h.rollbackCalls(), 1);
      assert.deepEqual(h.fileActions, ["capture", "rollback", "restore"]);
    }),
  );

  it.effect("missing file checkpoints fail before rollback or draft ownership is changed", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "f5-rewind-missing-"))),
        (cwd) => Effect.sync(() => fs.rmSync(cwd, { recursive: true, force: true })),
      );
      const h = yield* harness("rewind-missing-checkpoint", null, cwd);
      yield* h.rewind.run({ ...h.request, restoreFiles: true });
      assert.equal(h.rollbackCalls(), 0);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT * FROM rewind_operations WHERE operation_id = ${h.operationId}`).length,
        0,
      );
    }),
  );

  it.effect("rewinds without Git and retains the recoverable draft across duplicate requests", () =>
    Effect.gen(function* () {
      const h = yield* harness("rewind-no-git");
      yield* h.rewind.run(h.request);
      yield* h.rewind.run(h.request);
      assert.equal(h.rollbackCalls(), 1);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        state: string;
        draft: string;
      }>`SELECT state, draft_json AS draft FROM rewind_operations WHERE operation_id = ${h.operationId}`;
      assert.equal(rows[0]?.state, "completed");
      assert.equal(JSON.parse(rows[0]!.draft).text, "Recovered source");
      assert.equal(
        (yield* sql`SELECT * FROM rewind_requests WHERE operation_id = ${h.operationId}`).length,
        0,
      );
    }),
  );
  it.effect(
    "verifies a provider success after persistence failed without repeating the relative rollback",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("rewind-persistence", "persist");
        yield* h.rewind.run(h.request);
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql<{
            state: string;
          }>`SELECT state FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]?.state,
          "reconciliation-required",
        );
        yield* h.rewind.recover;
        assert.equal(h.rollbackCalls(), 1);
        assert.equal(
          (yield* sql<{
            state: string;
          }>`SELECT state FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]?.state,
          "completed",
        );
      }),
  );
  it.effect("keeps a disconnected rollback paused and never blindly replays it", () =>
    Effect.gen(function* () {
      const h = yield* harness("rewind-disconnect", "disconnect");
      yield* h.rewind.run(h.request);
      yield* h.rewind.recover;
      yield* h.rewind.run(h.request);
      assert.equal(h.rollbackCalls(), 1);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]?.state,
        "reconciliation-required",
      );
    }),
  );
  it.effect("preserves provider-pending state when shutdown interrupts rollback", () =>
    Effect.gen(function* () {
      const h = yield* harness("rewind-shutdown", "interrupt");
      const fiber = yield* h.rewind.run(h.request).pipe(Effect.forkChild);
      const sql = yield* SqlClient.SqlClient;
      while (h.rollbackCalls() === 0)
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));
      yield* Fiber.interrupt(fiber);
      const row = (yield* sql<{
        state: string;
        error: string | null;
      }>`SELECT state,error FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]!;
      assert.equal(row.state, "provider-pending");
      assert.equal(row.error, null);
    }),
  );

  it.effect("refuses to reconcile a different provider session", () =>
    Effect.gen(function* () {
      const h = yield* harness("rewind-stale", "persist");
      yield* h.rewind.run(h.request);
      h.changeIdentity();
      yield* h.rewind.recover;
      assert.equal(h.rollbackCalls(), 1);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]?.state,
        "reconciliation-required",
      );
    }),
  );
});
