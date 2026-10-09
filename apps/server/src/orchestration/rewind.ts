import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { CheckpointRef, CommandId, EventId, type OrchestrationEvent } from "@t3tools/contracts";
import { Cause, Effect, Exit, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { checkSessionAction } from "../provider/sessionCapabilities.ts";
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
  error: string | null;
}
export interface RewindRunOptions {
  /**
   * True when the run comes from an explicit user request (rewind, Retry, Recheck).
   * Only such runs may re-send a rollback that read-back proved was never applied;
   * startup recovery only verifies.
   */
  readonly userInitiated?: boolean;
}

const MAX_REWIND_ERROR_LENGTH = 400;
const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** Short, user-facing description of a rewind failure. The full cause is only logged. */
export const describeRewindFailure = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("only supports paginated threads") ||
    message.includes("ephemeral threads do not support")
  )
    return "Codex can't rewind this conversation because of how its history is stored. Nothing was changed.";
  const unknownMethod = /unknown variant `([^`]+)`/.exec(message);
  if (unknownMethod)
    return `The installed provider CLI does not support ${unknownMethod[1]}. Update the CLI and retry.`;
  if (error instanceof Error && error.name === "TimeoutError")
    return "The rewind timed out before the provider confirmed it.";
  const firstLine = message.split("\n")[0]!.trim();
  return firstLine.length > MAX_REWIND_ERROR_LENGTH
    ? `${firstLine.slice(0, MAX_REWIND_ERROR_LENGTH - 1)}…`
    : firstLine;
};

const contains = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

/**
 * A rollback is only re-sent after read-back proves the provider history is
 * unchanged, and only on an explicit user request. Recovery verifies read-back
 * before doing anything else and never re-sends.
 */
export const makeConversationRewind = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const provider = yield* ProviderService;
  const checkpoints = yield* CheckpointStore;
  const turns = yield* ProjectionTurnRepository;
  const engine = yield* OrchestrationEngineService;
  const fail = (message: string) => Effect.fail(new Error(message));
  const update = (id: string, state: string) =>
    sql`UPDATE rewind_operations SET state = ${state}, error = NULL, updated_at = ${new Date().toISOString()} WHERE operation_id = ${id}`;
  // Startup recovery and new requests share serialization, including no-Git rewinds.
  const gate = yield* Semaphore.make(1);
  const listHistory = (threadId: Request["threadId"]) =>
    turns
      .listByThreadId({ threadId })
      .pipe(
        Effect.map((rows) =>
          rows
            .filter((turn) => turn.turnId !== null)
            .toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
        ),
      );
  const execute = (request: Request, options: RewindRunOptions) =>
    Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      const thread = model.threads.find((thread) => thread.id === request.threadId);
      if (!thread) return yield* fail("The conversation no longer exists.");
      // Re-check against the routed session generation (instance and executable
      // version), not only the adapter-wide default for the provider kind.
      const sessionCapabilities = yield* provider
        .getSessionCapabilities(thread.id)
        .pipe(Effect.orElseSucceed(() => null));
      // A browser that saw an older generation is refused before anything changes.
      const rollbackRefusal = sessionCapabilities
        ? checkSessionAction({
            capabilities: sessionCapabilities,
            action: "rollback",
            expectedGeneration: request.expectedSessionGeneration,
          })
        : undefined;
      if (rollbackRefusal) return yield* fail(rollbackRefusal.message);
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
      const nativeFiles =
        request.restoreFiles &&
        thread.session?.providerName === "claudeAgent" &&
        !!workspace &&
        !(yield* checkpoints.isGitRepository(workspace));
      if (
        nativeFiles &&
        !sessionCapabilities?.actions.some(
          (action) => action.action === "fileCheckpointing" && action.supported,
        )
      )
        return yield* fail("Native file checkpointing is unavailable for this session.");
      const requiresWorkspace = request.restoreFiles || caps.rollbackAffectsFiles;
      if (requiresWorkspace && !workspace) return yield* fail("This rewind needs a workspace.");
      if (requiresWorkspace) {
        if (!thread.worktreePath && !nativeFiles)
          return yield* fail("File rollback requires an isolated worktree.");
        const cwd = yield* Effect.tryPromise(() => realpath(workspace!));
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
        // A prepared operation with an error already failed once. Leave the retry
        // (or cancel) to the user instead of re-sending it on every startup.
        if (op?.state === "prepared" && op.error !== null && !options.userInitiated) return;
        // Cancel deletes the operation and its request together. A Retry that was
        // queued behind the rewind gate must not recreate the operation afterwards.
        if (
          !op &&
          (yield* sql`SELECT 1 FROM rewind_requests WHERE operation_id = ${request.operationId}`)
            .length === 0
        )
          return;
        const snapshot = yield* provider.readThread(thread.id);
        const session = (yield* provider.listSessions()).find(
          (session) => session.threadId === thread.id,
        );
        // readThread may recover a session. Validate its actual workspace under
        // the lifecycle lock before preparing checkpoints or invoking rollback.
        if (requiresWorkspace) {
          if (!session?.cwd) return yield* fail("The provider workspace could not be verified.");
          const providerCwd = yield* Effect.tryPromise(() => realpath(session.cwd!));
          const worktreeCwd = yield* Effect.tryPromise(() => realpath(workspace!));
          if (providerCwd !== worktreeCwd)
            return yield* fail("The provider workspace differs from the worktree.");
        }
        const cursor = session?.resumeCursor as
          | { resume?: string; threadId?: string; rewindSourceThreadId?: string }
          | undefined;
        const identity = cursor?.resume ?? cursor?.threadId ?? snapshot.threadId;
        const history = yield* listHistory(thread.id);
        if (!op) {
          if (
            (yield* sql`SELECT operation_id FROM rewind_operations WHERE thread_id = ${thread.id} AND state <> 'completed'`)
              .length > 0
          )
            return yield* fail(
              "Another rewind of this conversation is still pending. Retry or cancel it first.",
            );
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
            !nativeFiles &&
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
        const expected = JSON.parse(op.boundary_json) as string[];
        const verified = (ids: readonly string[]) =>
          JSON.stringify(ids) === JSON.stringify(expected);
        if (op.provider_session_id !== identity) {
          // A validated Codex fork and a zero-turn Claude rollback replace the
          // native identity. Recovery must prove the retained boundary before
          // adopting either replacement; a prepared operation sent nothing.
          const replacementAllowed =
            (thread.session?.providerName === "codex" &&
              cursor?.rewindSourceThreadId === op.provider_session_id) ||
            (thread.session?.providerName === "claudeAgent" &&
              op.retained_count === 0 &&
              expected.length === 0);
          if (
            !replacementAllowed ||
            op.state === "prepared" ||
            !verified(snapshot.turns.map((turn) => turn.id))
          ) {
            // Kept in its current state on purpose: from `reconciliation-required` this
            // check can never pass, so the thread would stay blocked with no Cancel. A
            // `prepared` rewind sent nothing, so Cancel only restores the prior state.
            yield* Effect.logWarning("rewind found a different provider session", {
              threadId: request.threadId,
              operationId: request.operationId,
              state: op.state,
              expectedSession: op.provider_session_id,
              actualSession: identity,
            });
            return yield* fail(
              "The provider session changed; verify the rewind before continuing.",
            );
          }
          yield* sql`UPDATE rewind_operations SET provider_session_id = ${identity} WHERE operation_id = ${op.operation_id}`;
          op = { ...op, provider_session_id: identity };
        }
        const keepFilesRef = CheckpointRef.makeUnsafe(`refs/f5/rewind/${request.operationId}`);
        // The thread stays blocked while a rewind is open, so the projection still
        // holds the turns being dropped. Prepare proved they equal the provider tail.
        const removed = history
          .slice(op.retained_count)
          .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId as string]));
        const original = removed.length === op.relative_count ? [...expected, ...removed] : null;
        // True only when the provider history is exactly what it was before the rewind.
        const untouched = (ids: readonly string[]) => original !== null && sameIds(ids, original);
        const currentIds = snapshot.turns.map((turn) => turn.id as string);
        let state = op.state;
        if (
          (state === "provider-pending" || state === "reconciliation-required") &&
          untouched(currentIds)
        ) {
          // The read-back taken at the start of this run proves the rollback never
          // took effect, so the operation is as safe to retry as a prepared one.
          if (!options.userInitiated) {
            // Recovery only records the finding; re-sending is left to the user. The
            // queue says the rewind is waiting on them, not that it is still running.
            const parked =
              "The provider did not apply this rewind, so nothing was changed. Retry or cancel it.";
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE rewind_operations SET state = 'prepared', error = ${parked}, updated_at = ${new Date().toISOString()} WHERE operation_id = ${op!.operation_id}`;
                yield* sql`UPDATE next_turn_queue_state SET paused = 1, pause_reason_code = 'reconciliation_required', pause_detail = ${parked}, revision = revision + 1 WHERE thread_id = ${request.threadId}`;
              }),
            );
            return;
          }
          yield* update(op.operation_id, "prepared");
          state = "prepared";
        }
        if (state === "prepared" && !verified(currentIds)) {
          if (!untouched(currentIds)) {
            // Stays `prepared` on purpose: this history can never verify, so in
            // `reconciliation-required` the thread would stay blocked with no Cancel.
            // Nothing was sent, so Cancel only restores the pre-rewind state; the
            // divergence predates the rewind. Keep the evidence in the log.
            yield* Effect.logWarning("rewind found provider history changed after prepare", {
              threadId: request.threadId,
              operationId: request.operationId,
              providerTurnIds: currentIds,
              expectedTurnIds: original,
            });
            return yield* fail(
              "The provider history changed after this rewind was prepared. Cancel the rewind and start it again.",
            );
          }
          const captureKeepFiles = caps.rollbackAffectsFiles && !request.restoreFiles;
          if (captureKeepFiles)
            yield* checkpoints.captureCheckpoint({ cwd: workspace!, checkpointRef: keepFilesRef });
          // Persist before the external call. A process death here requires readback,
          // even when the provider never received the rollback. The conditional claim
          // also loses cleanly against a concurrent cancel.
          const claimed =
            yield* sql`UPDATE rewind_operations SET state = 'provider-pending', error = NULL, updated_at = ${new Date().toISOString()} WHERE operation_id = ${op.operation_id} AND state = 'prepared' RETURNING operation_id`;
          if (claimed.length === 0) {
            // The user cancelled while this run was preparing. Cancel already restored
            // the queue and released the thread, so this is not a failure.
            if (captureKeepFiles)
              yield* checkpoints.deleteCheckpointRefs({
                cwd: workspace!,
                checkpointRefs: [keepFilesRef],
              });
            return;
          }
          state = "provider-pending";
          const conversation = provider.rollbackConversation({
            threadId: thread.id,
            numTurns: op.relative_count,
            ...(removed[0] !== undefined ? { beforeTurnId: removed[0] } : {}),
          });
          const attempt = yield* Effect.exit(
            nativeFiles
              ? Effect.gen(function* () {
                  const native = provider.nativeOperations;
                  if (!native?.executeWithApply || !sessionCapabilities)
                    return yield* fail("Native file rewind is unavailable.");
                  const record = yield* native.executeWithApply(
                    {
                      threadId: thread.id,
                      operationId: `native-files:${request.operationId}`,
                      generation: sessionCapabilities.generation,
                      command: { kind: "revertFiles", userMessageId: removed[0]! },
                    },
                    () => conversation,
                  );
                  if (record.state !== "completed" || record.staleGeneration)
                    return yield* fail(
                      record.error ??
                        "Native file rewind needs reconciliation; the conversation was left untouched.",
                    );
                  const result = record.result as { skippedLinks?: number } | undefined;
                  if (result?.skippedLinks)
                    yield* engine.dispatch({
                      type: "thread.activity.append",
                      commandId: CommandId.makeUnsafe(
                        `native-files-warning:${request.operationId}`,
                      ),
                      threadId: thread.id,
                      activity: {
                        id: EventId.makeUnsafe(`native-files-warning:${request.operationId}`),
                        kind: "native.files.warning",
                        tone: "info",
                        summary: `Native file rewind skipped ${result.skippedLinks} unsafe file links.`,
                        payload: { skippedLinks: result.skippedLinks },
                        turnId: null,
                        createdAt: new Date().toISOString(),
                      },
                      createdAt: new Date().toISOString(),
                    });
                })
              : conversation,
          );
          if (Exit.isFailure(attempt)) {
            // A rejected request usually changed nothing. Prove it before marking the
            // operation retryable; anything else still needs reconciliation.
            const readback = yield* Effect.exit(provider.readThread(thread.id));
            if (
              Exit.isSuccess(readback) &&
              untouched(readback.value.turns.map((turn) => turn.id as string))
            )
              yield* update(op.operation_id, "prepared");
            return yield* Effect.failCause(attempt.cause);
          }
        }
        if (
          state === "prepared" ||
          state === "provider-pending" ||
          state === "reconciliation-required"
        ) {
          const after = yield* provider.readThread(thread.id);
          if (!verified(after.turns.map((turn) => turn.id)))
            return yield* fail(
              "The provider rewind boundary could not be verified. No rollback will be replayed automatically.",
            );
          const confirmedSession = (yield* provider.listSessions()).find(
            (session) => session.threadId === thread.id,
          );
          const confirmedCursor = confirmedSession?.resumeCursor as
            | { resume?: string; threadId?: string; rewindSourceThreadId?: string }
            | undefined;
          const confirmedIdentity =
            confirmedCursor?.resume ?? confirmedCursor?.threadId ?? after.threadId;
          yield* sql`UPDATE rewind_operations SET provider_session_id = ${confirmedIdentity}, state = 'provider-confirmed', error = NULL, updated_at = ${new Date().toISOString()} WHERE operation_id = ${op.operation_id}`;
        }
        if (state !== "files-confirmed") {
          if (!nativeFiles && (request.restoreFiles || caps.rollbackAffectsFiles)) {
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
          retainedTurnIds: (yield* listHistory(thread.id))
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
      Effect.timeout("30 seconds"),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
          const detail = describeRewindFailure(cause);
          const failedAt = new Date().toISOString();
          yield* sql`UPDATE rewind_operations SET state = CASE WHEN state = 'prepared' THEN 'prepared' ELSE 'reconciliation-required' END, error = ${detail}, updated_at = ${failedAt} WHERE operation_id = ${request.operationId} AND thread_id = ${request.threadId} AND target_message_id = ${request.targetMessageId} AND state <> 'completed'`;
          const op =
            (yield* sql<Operation>`SELECT * FROM rewind_operations WHERE operation_id = ${request.operationId}`)[0];
          // Unique per attempt so every Retry/Recheck surfaces its own result.
          const failureId = `rewind-failed:${request.operationId}:${op?.state ?? "preflight"}:${randomUUID()}`;
          yield* engine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(failureId),
              threadId: request.threadId,
              activity: {
                id: EventId.makeUnsafe(failureId),
                kind: "conversation.rewind.failed",
                tone: "error",
                summary: op
                  ? op.state === "prepared"
                    ? "Conversation rewind preparation failed; retry is safe"
                    : "Conversation rewind requires reconciliation"
                  : "Conversation rewind could not start",
                // The operation fields let clients tie the failure to its rewind
                // (and hide it once resolved) and offer a keep-files retry.
                payload: {
                  detail,
                  operationId: request.operationId,
                  targetMessageId: request.targetMessageId,
                  restoreFiles: request.restoreFiles,
                  stage: op ? op.state : "preflight",
                },
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
              cause: Cause.pretty(cause),
            });
            return;
          }
          if (op.state === "completed")
            yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${request.operationId}`;
          if (op?.state === "completed") {
            yield* Effect.logWarning("Rewind completed; checkpoint cleanup failed", {
              detail,
              cause: Cause.pretty(cause),
            });
            return;
          }
          yield* sql`UPDATE next_turn_queue_state SET paused = 1, pause_reason_code = ${op ? "reconciliation_required" : "thread_reverted"}, pause_detail = ${detail}, revision = revision + 1 WHERE thread_id = ${request.threadId}`;
          yield* Effect.logError("conversation rewind requires attention", {
            threadId: request.threadId,
            operationId: request.operationId,
            state: op.state,
            detail,
            cause: Cause.pretty(cause),
          });
        }),
      ),
    );
  const run = (request: Request, options: RewindRunOptions = { userInitiated: true }) =>
    gate.withPermit(execute(request, options));
  const recover = Effect.gen(function* () {
    const requests = yield* sql<{
      readonly payload: string;
    }>`SELECT payload_json AS payload FROM rewind_requests ORDER BY created_at`;
    for (const request of requests)
      yield* run(JSON.parse(request.payload) as Request, { userInitiated: false });
  });
  return { run, recover };
});
