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
  failure:
    | "persist"
    | "disconnect"
    | "capture"
    | "interrupt"
    | "reject-once"
    | "scramble"
    | null = null,
  worktreePath: string | null = null,
  options: {
    providerCwd?: string;
    zeroTurnClaude?: boolean;
    forkCodex?: boolean;
    failReadback?: boolean;
    cancelDuringCapture?: boolean;
  } = {},
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
    const beforeTurnIds: Array<string | undefined> = [];
    const deletedRefs: string[] = [];
    const activityCommandIds: string[] = [];
    let rollbackCalls = 0;
    let identity = "provider-session";
    let providerTurns = [TurnId.makeUnsafe("first"), TurnId.makeUnsafe("second")];
    let failPersist = failure === "persist";
    let failCapture = failure === "capture";
    let failReadback = options.failReadback === true;
    const model = {
      snapshotSequence: 3,
      projects: [{ id: projectId, workspaceRoot: "/tmp/no-git-phase8" }],
      threads: [
        {
          id: threadId,
          projectId,
          worktreePath,
          session: {
            providerName: options.zeroTurnClaude
              ? "claudeAgent"
              : worktreePath
                ? "opencode"
                : "codex",
          },
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
          Effect.suspend(() => {
            if (rollbackCalls > 0 && failReadback) {
              failReadback = false;
              return Effect.fail(new Error("Readback unavailable"));
            }
            return Effect.succeed({
              threadId,
              turns: providerTurns.map((id) => ({ id, items: [] })),
            });
          }),
        listSessions: () =>
          Effect.sync(() => [
            {
              threadId,
              cwd: options.providerCwd ?? worktreePath,
              resumeCursor: {
                threadId: identity,
                ...(options.forkCodex && rollbackCalls > 0
                  ? { rewindSourceThreadId: "provider-session" }
                  : {}),
              },
            },
          ]),
        rollbackConversation: ({
          numTurns,
          beforeTurnId,
        }: {
          numTurns: number;
          beforeTurnId?: string;
        }) =>
          Effect.suspend(() => {
            rollbackCalls++;
            beforeTurnIds.push(beforeTurnId);
            fileActions.push("rollback");
            if (failure === "interrupt") return Effect.never;
            if (failure === "disconnect") return Effect.fail(new Error("Disconnected"));
            if (failure === "reject-once" && rollbackCalls === 1)
              return Effect.fail(
                new Error(
                  "thread/revert failed: Invalid request: unknown variant `thread/revert`, expected one of `initialize`\n    at handleResponse (codexAppServerManager.ts:1)",
                ),
              );
            if (failure === "scramble") {
              providerTurns = [TurnId.makeUnsafe("first"), TurnId.makeUnsafe("unexpected")];
              return Effect.fail(new Error("Disconnected"));
            }
            providerTurns = providerTurns.slice(0, -numTurns);
            if (options.zeroTurnClaude) identity = "replacement-claude-session";
            if (options.forkCodex) identity = "replacement-codex-session";
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
                // Simulates the engine's Cancel landing while the run is preparing.
                return options.cancelDuringCapture
                  ? sql`DELETE FROM rewind_operations WHERE operation_id = ${operationId}`.pipe(
                      Effect.andThen(
                        sql`DELETE FROM rewind_requests WHERE operation_id = ${operationId}`,
                      ),
                      Effect.asVoid,
                    )
                  : Effect.void;
              })
            : Effect.die("conversation-only must not access Git"),
        restoreCheckpoint: () =>
          worktreePath
            ? Effect.sync(() => {
                fileActions.push("restore");
                return true;
              })
            : Effect.die("conversation-only must not restore files"),
        deleteCheckpointRefs: ({ checkpointRefs }: { checkpointRefs: readonly string[] }) =>
          Effect.sync(() => {
            deletedRefs.push(...checkpointRefs);
          }),
      } as never),
      Effect.provideService(ProjectionTurnRepository, {
        listByThreadId: () =>
          Effect.succeed([
            {
              turnId: "first",
              pendingMessageId: options.zeroTurnClaude ? messageId : "earlier",
              requestedAt: at,
            },
            {
              turnId: "second",
              pendingMessageId: options.zeroTurnClaude ? "later" : messageId,
              requestedAt: "2026-09-30T12:01:00.000Z",
            },
          ]),
      } as never),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () => Effect.succeed(model),
        dispatch: (command: { type: string; commandId: string }) =>
          Effect.suspend(() => {
            if (command.type === "thread.activity.append")
              activityCommandIds.push(command.commandId);
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
      beforeTurnIds,
      activityCommandIds,
      deletedRefs,
      rollbackCalls: () => rollbackCalls,
      changeIdentity: () => {
        identity = "different-session";
      },
    };
  });
layer("conversation rewind recovery", (it) => {
  it.effect("rejects a provider cwd outside the isolated worktree before any file operation", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "f5-rewind-cwd-"))),
        (cwd) => Effect.sync(() => fs.rmSync(cwd, { recursive: true, force: true })),
      );
      const h = yield* harness("rewind-wrong-cwd", null, cwd, { providerCwd: os.tmpdir() });
      yield* h.rewind.run(h.request);
      assert.equal(h.rollbackCalls(), 0);
      assert.deepEqual(h.fileActions, []);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT * FROM rewind_operations WHERE operation_id = ${h.operationId}`).length,
        0,
      );
    }),
  );
  for (const failReadback of [false, true])
    it.effect(
      `recovers a replacement Claude session after zero-turn rollback and ${failReadback ? "readback" : "persistence"} failure`,
      () =>
        Effect.gen(function* () {
          const h = yield* harness(`rewind-claude-zero:${failReadback}`, "persist", null, {
            zeroTurnClaude: true,
            failReadback,
          });
          yield* h.rewind.run(h.request);
          const sql = yield* SqlClient.SqlClient;
          assert.equal(
            (yield* sql<{
              state: string;
            }>`SELECT state FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]
              ?.state,
            "reconciliation-required",
          );
          yield* h.rewind.recover;
          // With a failed readback the first recovery reaches the injected save failure.
          if (failReadback) yield* h.rewind.recover;
          assert.equal(h.rollbackCalls(), 1);
          const row = (yield* sql<{
            state: string;
            identity: string;
          }>`SELECT state, provider_session_id AS identity FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]!;
          assert.equal(row.state, "completed");
          assert.equal(row.identity, "replacement-claude-session");
        }),
    );
  it.effect("recovers a validated Codex fork after failed readback", () =>
    Effect.gen(function* () {
      const h = yield* harness("rewind-codex-fork", null, null, {
        forkCodex: true,
        failReadback: true,
      });
      yield* h.rewind.run(h.request);
      yield* h.rewind.recover;
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* sql<{
        state: string;
        identity: string;
      }>`SELECT state, provider_session_id AS identity FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]!;
      assert.equal(row.state, "completed");
      assert.equal(row.identity, "replacement-codex-session");
      assert.equal(h.rollbackCalls(), 1);
    }),
  );
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
  it.effect(
    "keeps a failed rollback with untouched history retryable, but only replays it on user request",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("rewind-disconnect", "disconnect");
        const sql = yield* SqlClient.SqlClient;
        const row = () =>
          sql<{
            state: string;
            error: string | null;
          }>`SELECT state, error FROM rewind_operations WHERE operation_id = ${h.operationId}`.pipe(
            Effect.map((rows) => rows[0]!),
          );
        yield* h.rewind.run(h.request);
        assert.equal((yield* row()).state, "prepared");
        assert.equal((yield* row()).error, "Disconnected");
        yield* h.rewind.recover;
        assert.equal(h.rollbackCalls(), 1);
        yield* h.rewind.run(h.request);
        assert.equal(h.rollbackCalls(), 2);
        assert.equal((yield* row()).state, "prepared");
        // Each attempt surfaces its own failure activity.
        assert.equal(h.activityCommandIds.length, 2);
        assert.notEqual(h.activityCommandIds[0], h.activityCommandIds[1]);
      }),
  );
  it.effect("sends the first dropped provider turn and stores a short error", () =>
    Effect.gen(function* () {
      const h = yield* harness("rewind-reject-once", "reject-once");
      const sql = yield* SqlClient.SqlClient;
      yield* h.rewind.run(h.request);
      const failed = (yield* sql<{
        state: string;
        error: string;
      }>`SELECT state, error FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]!;
      assert.equal(failed.state, "prepared");
      assert.equal(
        failed.error,
        "The installed provider CLI does not support thread/revert. Update the CLI and retry.",
      );
      const queue = (yield* sql<{
        reason: string | null;
      }>`SELECT pause_reason_code AS reason FROM next_turn_queue_state WHERE thread_id = ${h.request.threadId}`)[0]!;
      assert.equal(queue.reason, "reconciliation_required");
      yield* h.rewind.run(h.request);
      assert.equal(h.rollbackCalls(), 2);
      assert.deepEqual(h.beforeTurnIds, ["second", "second"]);
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]?.state,
        "completed",
      );
    }),
  );
  it.effect(
    "rechecks a stuck reconciliation with untouched history: recovery parks it, the user's recheck completes it",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("rewind-stuck-recheck", "reject-once");
        const sql = yield* SqlClient.SqlClient;
        yield* h.rewind.run(h.request);
        // Rows written before this fix landed in reconciliation-required.
        yield* sql`UPDATE rewind_operations SET state = 'reconciliation-required' WHERE operation_id = ${h.operationId}`;
        yield* h.rewind.recover;
        assert.equal(h.rollbackCalls(), 1);
        assert.equal(
          (yield* sql<{
            state: string;
          }>`SELECT state FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]?.state,
          "prepared",
        );
        // The queue reflects that the rewind now waits on the user.
        const queue = (yield* sql<{
          paused: number;
          reason: string | null;
          detail: string | null;
        }>`SELECT paused, pause_reason_code AS reason, pause_detail AS detail FROM next_turn_queue_state WHERE thread_id = ${h.request.threadId}`)[0]!;
        assert.equal(queue.paused, 1);
        assert.equal(queue.reason, "reconciliation_required");
        assert.include(queue.detail ?? "", "did not apply this rewind");
        yield* sql`UPDATE rewind_operations SET state = 'reconciliation-required' WHERE operation_id = ${h.operationId}`;
        yield* h.rewind.run(h.request);
        assert.equal(h.rollbackCalls(), 2);
        assert.equal(
          (yield* sql<{
            state: string;
          }>`SELECT state FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]?.state,
          "completed",
        );
      }),
  );
  it.effect("does not recreate a cancelled rewind when a queued Retry runs afterwards", () =>
    Effect.gen(function* () {
      const h = yield* harness("rewind-retry-after-cancel", "reject-once");
      const sql = yield* SqlClient.SqlClient;
      yield* h.rewind.run(h.request);
      const activitiesAfterFailure = h.activityCommandIds.length;
      // Cancel removes the operation and its request together.
      yield* sql`DELETE FROM rewind_operations WHERE operation_id = ${h.operationId}`;
      yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${h.operationId}`;
      yield* h.rewind.run(h.request);
      assert.equal(h.rollbackCalls(), 1);
      assert.equal(
        (yield* sql`SELECT 1 FROM rewind_operations WHERE operation_id = ${h.operationId}`).length,
        0,
      );
      assert.equal(h.activityCommandIds.length, activitiesAfterFailure);
    }),
  );
  it.effect("exits quietly and drops the keep-files ref when Cancel wins the claim", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "f5-rewind-cancel-claim-"))),
        (cwd) => Effect.sync(() => fs.rmSync(cwd, { recursive: true, force: true })),
      );
      const h = yield* harness("rewind-cancel-claim", null, cwd, { cancelDuringCapture: true });
      yield* h.rewind.run(h.request);
      assert.equal(h.rollbackCalls(), 0);
      assert.deepEqual(h.fileActions, ["capture"]);
      assert.deepEqual(h.deletedRefs, [`refs/f5/rewind/${h.operationId}`]);
      assert.deepEqual(h.activityCommandIds, []);
    }),
  );
  it.effect("keeps an ambiguous provider history in reconciliation and never replays it", () =>
    Effect.gen(function* () {
      const h = yield* harness("rewind-scramble", "scramble");
      const sql = yield* SqlClient.SqlClient;
      yield* h.rewind.run(h.request);
      yield* h.rewind.recover;
      yield* h.rewind.run(h.request);
      assert.equal(h.rollbackCalls(), 1);
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

  it.effect("refuses a replacement Claude identity when the zero-turn boundary is not empty", () =>
    Effect.gen(function* () {
      const h = yield* harness("rewind-claude-nonempty", "disconnect", null, {
        zeroTurnClaude: true,
      });
      yield* h.rewind.run(h.request);
      h.changeIdentity();
      yield* h.rewind.recover;
      assert.equal(h.rollbackCalls(), 1);
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* sql<{
        state: string;
        identity: string;
      }>`SELECT state, provider_session_id AS identity FROM rewind_operations WHERE operation_id = ${h.operationId}`)[0]!;
      // The failed rollback left the history untouched, so the rewind stays retryable;
      // the replacement identity is still never adopted.
      assert.equal(row.state, "prepared");
      assert.equal(row.identity, "provider-session");
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
