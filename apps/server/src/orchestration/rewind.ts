import { realpath } from "node:fs/promises";
import path from "node:path";
import { CheckpointRef, CommandId, EventId, type OrchestrationEvent } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { withWorktreeLifecycleLock } from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

type Request = Extract<
  OrchestrationEvent,
  { type: "thread.conversation-revert-requested" }
>["payload"];
interface Operation {
  operation_id: string;
  thread_id: string;
  target_message_id: string;
  target_turn_id: string | null;
  provider_session_id: string;
  mode: "conversation" | "conversation-and-files";
  state: string;
  relative_count: number;
  retained_count: number;
  boundary_json: string;
}
const contains = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

/** Relative rollback is performed once. Recovery verifies readback before doing anything else. */
export const makeConversationRewind = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const provider = yield* ProviderService;
  const checkpoints = yield* CheckpointStore;
  const turns = yield* ProjectionTurnRepository;
  const engine = yield* OrchestrationEngineService;
  const fail = (message: string) => Effect.fail(new Error(message));
  const update = (id: string, state: string) =>
    sql`UPDATE rewind_operations SET state = ${state}, error = NULL, updated_at = ${new Date().toISOString()} WHERE operation_id = ${id}`;
  const run = (request: Request) =>
    Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      const thread = model.threads.find((thread) => thread.id === request.threadId);
      if (!thread) return yield* fail("The conversation no longer exists.");
      const caps = thread.session?.providerName
        ? (yield* provider.getCapabilities(
            thread.session.providerName as import("@t3tools/contracts").ProviderKind,
          )).runtimeCapabilities
        : undefined;
      if (!caps?.conversationRollback || !caps.rollbackReadback)
        return yield* fail(
          "This provider cannot reliably rewind and verify its conversation history.",
        );
      const workspace =
        thread.worktreePath ??
        model.projects.find((project) => project.id === thread.projectId)?.workspaceRoot;
      const requiresWorkspace = request.restoreFiles || caps.rollbackAffectsFiles;
      if (requiresWorkspace && !workspace) return yield* fail("This rewind needs a workspace.");
      if (requiresWorkspace) {
        if (!thread.worktreePath)
          return yield* fail("File rollback requires an isolated worktree.");
        const cwd = yield* Effect.tryPromise(() => realpath(workspace!));
        if (cwd !== (yield* Effect.tryPromise(() => realpath(thread.worktreePath!))))
          return yield* fail("The provider workspace differs from the worktree.");
        const owners = model.threads
          .filter((other) => other.id !== thread.id)
          .map(
            (other) =>
              other.worktreePath ??
              model.projects.find((project) => project.id === other.projectId)?.workspaceRoot,
          );
        for (const session of yield* provider.listSessions())
          if (session.threadId !== thread.id && session.cwd) owners.push(session.cwd);
        for (const owner of owners) {
          if (!owner) continue;
          const other = yield* Effect.tryPromise(() => realpath(owner)).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (other && (contains(cwd, other) || contains(other, cwd)))
            return yield* fail(
              "File rollback requires a worktree isolated from other conversations.",
            );
        }
      }
      const perform = Effect.gen(function* () {
        let op =
          (yield* sql<Operation>`SELECT * FROM rewind_operations WHERE operation_id = ${request.operationId}`)[0];
        if (
          op &&
          (op.thread_id !== request.threadId ||
            op.target_message_id !== request.targetMessageId ||
            (op.mode === "conversation-and-files") !== request.restoreFiles)
        )
          return yield* fail("That rewind identifier belongs to a different request.");
        if (op?.state === "completed") {
          yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${request.operationId}`;
          return;
        }
        const snapshot = yield* provider.readThread(thread.id);
        const session = (yield* provider.listSessions()).find(
          (session) => session.threadId === thread.id,
        );
        const cursor = session?.resumeCursor as { resume?: string; threadId?: string } | undefined;
        const identity = cursor?.resume ?? cursor?.threadId ?? snapshot.threadId;
        if (!op) {
          const history = (yield* turns.listByThreadId({ threadId: thread.id }))
            .filter((turn) => turn.turnId !== null)
            .toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt));
          const target = history.findIndex(
            (turn) => turn.pendingMessageId === request.targetMessageId,
          );
          if (target < 0)
            return yield* fail("The selected message has no verified provider turn boundary.");
          const relativeCount = history.length - target;
          if (relativeCount > snapshot.turns.length)
            return yield* fail("Provider history is incomplete; this rewind cannot be verified.");
          if (
            JSON.stringify(snapshot.turns.slice(-relativeCount).map((turn) => turn.id)) !==
            JSON.stringify(history.slice(target).map((turn) => turn.turnId))
          )
            return yield* fail("The selected turn history does not match the provider boundary.");
          const boundary = snapshot.turns
            .slice(0, snapshot.turns.length - relativeCount)
            .map((turn) => turn.id);
          const source = thread.messages.find((message) => message.id === request.targetMessageId);
          if (!source) return yield* fail("Load the selected prompt before rewinding.");
          const at = new Date().toISOString();
          if (
            request.restoreFiles &&
            !(yield* checkpoints.hasCheckpointRef({
              cwd: workspace!,
              checkpointRef: checkpointRefForThreadTurn(thread.id, target),
            }))
          )
            return yield* fail(
              "The file checkpoint for this boundary is unavailable. Rewind while keeping files instead.",
            );
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO rewind_operations(operation_id, thread_id, target_message_id, target_turn_id, provider_session_id, mode, expected_revision, state, relative_count, retained_count, boundary_json, draft_json, created_at, updated_at)
          VALUES (${request.operationId}, ${thread.id}, ${source.id}, ${boundary.at(-1) ?? null}, ${identity}, ${request.restoreFiles ? "conversation-and-files" : "conversation"}, ${request.expectedRevision ?? model.snapshotSequence}, 'prepared', ${relativeCount}, ${target}, ${JSON.stringify(boundary)}, ${JSON.stringify({ text: source.text, attachments: source.attachments ?? [] })}, ${at}, ${at})`;
              for (const attachment of source.attachments ?? []) {
                yield* sql`INSERT OR IGNORE INTO attachment_owners VALUES (${attachment.id}, 'rewind_draft', ${request.operationId}, ${at})`;
                yield* sql`DELETE FROM attachment_owners WHERE attachment_id = ${attachment.id} AND owner_kind = 'message' AND owner_id = ${source.id}`;
              }
            }),
          );
          op =
            (yield* sql<Operation>`SELECT * FROM rewind_operations WHERE operation_id = ${request.operationId}`)[0]!;
        }
        if (op.provider_session_id !== identity)
          return yield* fail("The provider session changed; verify the rewind before continuing.");
        const expected = JSON.parse(op.boundary_json) as string[];
        const verified = (ids: readonly string[]) =>
          JSON.stringify(ids) === JSON.stringify(expected);
        const keepFilesRef = CheckpointRef.makeUnsafe(`refs/f5/rewind/${request.operationId}`);
        if (op.state === "prepared") {
          if (caps.rollbackAffectsFiles && !request.restoreFiles)
            yield* checkpoints.captureCheckpoint({ cwd: workspace!, checkpointRef: keepFilesRef });
          // Persist before the external call. A process death here requires readback,
          // even when the provider never received the relative rollback.
          yield* update(op.operation_id, "provider-pending");
          yield* provider.rollbackConversation({
            threadId: thread.id,
            numTurns: op.relative_count,
          });
        }
        if (
          op.state === "prepared" ||
          op.state === "provider-pending" ||
          op.state === "reconciliation-required"
        ) {
          const after = yield* provider.readThread(thread.id);
          if (!verified(after.turns.map((turn) => turn.id)))
            return yield* fail(
              "The provider rewind boundary could not be verified. No rollback will be replayed automatically.",
            );
          yield* update(op.operation_id, "provider-confirmed");
        }
        if (op.state !== "files-confirmed") {
          if (request.restoreFiles || caps.rollbackAffectsFiles) {
            const ref = request.restoreFiles
              ? checkpointRefForThreadTurn(thread.id, op.retained_count)
              : keepFilesRef;
            if (!(yield* checkpoints.restoreCheckpoint({ cwd: workspace!, checkpointRef: ref })))
              return yield* fail("The rewind file checkpoint is unavailable.");
          }
          yield* update(op.operation_id, "files-confirmed");
        }
        yield* engine.dispatch({
          type: "thread.revert.complete",
          operationId: request.operationId,
          commandId: CommandId.makeUnsafe(`rewind-complete:${request.operationId}`),
          threadId: thread.id,
          turnCount: op.retained_count,
          retainedTurnIds: (yield* turns.listByThreadId({ threadId: thread.id }))
            .filter((turn) => turn.turnId !== null)
            .toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt))
            .slice(0, op.retained_count)
            .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
          createdAt: new Date().toISOString(),
        });
        yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${request.operationId}`;
        const stale = thread.checkpoints
          .filter((checkpoint) => checkpoint.checkpointTurnCount > op!.retained_count)
          .map((checkpoint) => checkpoint.checkpointRef);
        if (workspace && stale.length)
          yield* checkpoints.deleteCheckpointRefs({ cwd: workspace, checkpointRefs: stale });
        if (workspace && caps.rollbackAffectsFiles && !request.restoreFiles)
          yield* checkpoints.deleteCheckpointRefs({
            cwd: workspace,
            checkpointRefs: [keepFilesRef],
          });
      });
      yield* requiresWorkspace ? withWorktreeLifecycleLock(workspace!, perform) : perform;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const detail = String(cause);
          yield* sql`UPDATE rewind_operations SET state = 'reconciliation-required', error = ${detail}, updated_at = ${new Date().toISOString()} WHERE operation_id = ${request.operationId} AND thread_id = ${request.threadId} AND target_message_id = ${request.targetMessageId} AND state <> 'completed'`;
          const op =
            (yield* sql<Operation>`SELECT * FROM rewind_operations WHERE operation_id = ${request.operationId}`)[0];
          yield* engine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(
                `rewind-failed:${request.operationId}:${op?.state ?? "preflight"}`,
              ),
              threadId: request.threadId,
              activity: {
                id: EventId.makeUnsafe(
                  `rewind-failed:${request.operationId}:${op?.state ?? "preflight"}`,
                ),
                kind: "conversation.rewind.failed",
                tone: "error",
                summary: op
                  ? "Conversation rewind requires reconciliation"
                  : "Conversation rewind could not start",
                payload: { detail },
                turnId: null,
                createdAt: new Date().toISOString(),
              },
              createdAt: new Date().toISOString(),
            })
            .pipe(Effect.catchCause(() => Effect.void));
          if (!op) {
            const saved = (yield* sql<{
              state: string | null;
            }>`SELECT queue_state_json AS state FROM rewind_requests WHERE operation_id = ${request.operationId}`)[0];
            const prior = saved?.state
              ? JSON.parse(saved.state)
              : { paused: 0, pause_reason_code: null, pause_detail: null };
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE next_turn_queue_state SET paused = ${prior.paused}, pause_reason_code = ${prior.pause_reason_code}, pause_detail = ${prior.pause_detail}, revision = revision + 1 WHERE thread_id = ${request.threadId} AND pause_reason_code = 'rewind_in_progress'`;
                yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${request.operationId}`;
              }),
            );
            yield* Effect.logError("Conversation rewind preflight failed", {
              threadId: request.threadId,
              detail,
            });
            return;
          }
          if (op.state === "completed")
            yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${request.operationId}`;
          if (op?.state === "completed") {
            yield* Effect.logWarning("Rewind completed; checkpoint cleanup failed", { detail });
            return;
          }
          yield* sql`UPDATE next_turn_queue_state SET paused = 1, pause_reason_code = ${op ? "reconciliation_required" : "thread_reverted"}, pause_detail = ${detail}, revision = revision + 1 WHERE thread_id = ${request.threadId}`;
          yield* Effect.logError("conversation rewind requires attention", {
            threadId: request.threadId,
            operationId: request.operationId,
            detail,
          });
        }),
      ),
    );
  const recover = Effect.gen(function* () {
    const requests = yield* sql<{
      readonly payload: string;
    }>`SELECT payload_json AS payload FROM rewind_requests ORDER BY created_at`;
    for (const request of requests) yield* run(JSON.parse(request.payload) as Request);
  });
  return { run, recover };
});
