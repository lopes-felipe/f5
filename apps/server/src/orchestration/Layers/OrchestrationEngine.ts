import { makeCommitSideEffects } from "../commitSideEffects.ts";
import { hydrateDeciderReadModel, withoutDeletedThreadDetails } from "../deciderReadModel.ts";
import { ProviderControlTarget } from "../../provider/controlTarget.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  makeCommandAdmission,
  LosslessCommandAdmission,
  isControlCommand,
  isControlEvent,
} from "../commandAdmission.ts";
import { readPersistedSessionGeneration } from "../../provider/sessionCapabilities.ts";
import { registerShutdown, AcceptedShutdownWork } from "../../shutdown.ts";
import {
  WorkspaceWriteContext,
  type WorkspaceWrite,
} from "../../project/workspaceTransitionContext.ts";
import { WorkspaceTransitions } from "../../persistence/Services/WorkspaceTransitions.ts";
import { assertWorktreeReady, WorktreeInspectionError } from "../../project/worktreeReadiness.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import type { OrchestrationReadModel, ProjectId, ThreadId } from "@t3tools/contracts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationCommand,
  OrchestrationEvent,
} from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  PubSub,
  Schema,
  ServiceMap,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import {
  isScratchProject,
  isScratchThreadFolder,
  scratchThreadFolderName,
} from "@t3tools/shared/scratchProject";

import {
  PerformanceStageProbe,
  measurePerformanceStage,
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationOverloadError,
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  ThreadTurnNotReadyError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand, GLOBAL_PIN_AGGREGATE_ID } from "../decider.ts";
import { observeReadModelRetention } from "../readModelRetention.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
  type ControlOrigin,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { DiskSpaceMonitor } from "../../storage/DiskSpaceMonitor.ts";
import { makeStorageMaintenanceLock } from "../../storage/StorageMaintenanceLock.ts";
import { withStartupPhaseTiming } from "../../startupTiming.ts";

interface CommandEnvelope {
  command: OrchestrationCommand;
  workspaceWrite?: WorkspaceWrite | null;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
  admissionOrder: number;
  controlCommitted?: boolean;
  controlCommittedAt?: number;
  controlClaimed?: boolean;
  controlExpired?: boolean;
  controlOrigin?: ControlOrigin;
  controlFinished?: Deferred.Deferred<void, OrchestrationOverloadError>;
  workspace?: { path: string; branch: string | null; projectCwd: string };
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.scratch.create":
    case "project.meta.update":
    case "project.delete":
    case "project.memory.save":
    case "project.memory.update":
    case "project.memory.delete":
    case "project.skills.replace":
    case "project.workflow.create":
    case "project.workflow.delete":
    case "project.workflow.upsert":
    case "project.workflow.archive":
    case "project.workflow.unarchive":
    case "project.code-review-workflow.create":
    case "project.code-review-workflow.delete":
    case "project.code-review-workflow.upsert":
    case "project.investigation-workflow.create":
    case "project.investigation-workflow.delete":
    case "project.investigation-workflow.upsert":
    case "project.debug-workflow.create":
    case "project.debug-workflow.delete":
    case "project.debug-workflow.upsert":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

function controlCommandConflict(existing: CommandEnvelope, command: OrchestrationCommand) {
  const accepted = commandToAggregateRef(existing.command);
  const incoming = commandToAggregateRef(command);
  return accepted.aggregateKind === incoming.aggregateKind &&
    accepted.aggregateId === incoming.aggregateId
    ? undefined
    : new OrchestrationCommandIdConflictError({
        commandId: command.commandId,
        receiptAggregateKind: accepted.aggregateKind,
        receiptAggregateId: accepted.aggregateId,
        commandAggregateKind: incoming.aggregateKind,
        commandAggregateId: incoming.aggregateId,
      });
}

/** Only unclaimed control delivery expires; a running side effect keeps its lease. */
export const ControlDeliveryClock = ServiceMap.Reference<() => number>(
  "f5/orchestration/ControlDeliveryClock",
  { defaultValue: () => Date.now },
);
const CONTROL_DELIVERY_TIMEOUT_MS = 30_000;

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const transitions = yield* Effect.serviceOption(WorkspaceTransitions);
  const queueStore = yield* Effect.serviceOption(NextTurnQueueStore);
  const commitSideEffects = makeCommitSideEffects({ sql, transitions, queueStore });
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const workspaceGit = yield* Effect.serviceOption(GitCore);
  const maintenanceLock = yield* makeStorageMaintenanceLock;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const sessionDirectory = yield* Effect.serviceOption(ProviderSessionDirectory);
  const diskSpaceMonitor = yield* Effect.serviceOption(DiskSpaceMonitor);

  let readModel = createEmptyReadModel(new Date().toISOString());
  const nativeReconciledThreads = new Set<string>();
  let hasDeletedThreads = false;

  const controlNow = yield* ControlDeliveryClock;
  const admission = yield* makeCommandAdmission<CommandEnvelope>();
  const controlReservations = new Map<string, CommandEnvelope>();
  let admissionOrder = 0;
  let accepting = true;
  const stoppedSequences = new Map<string, number>();
  const releaseControl = (commandId: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const envelope = controlReservations.get(commandId);
        if (!envelope) return;
        controlReservations.delete(commandId);
        yield* admission.release(envelope);
        if (envelope.controlFinished) yield* Deferred.succeed(envelope.controlFinished, undefined);
      }),
    );
  const releaseEnvelopeAdmission = (envelope: CommandEnvelope) =>
    envelope.controlCommitted
      ? Effect.void
      : isControlCommand(envelope.command)
        ? releaseControl(envelope.command.commandId)
        : admission.release(envelope);
  yield* registerShutdown("orchestration-admission", "admission", () =>
    Effect.sync(() => {
      accepting = false;
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* admission.close;
      for (const envelope of admission.pending()) {
        yield* Deferred.fail(
          envelope.result,
          new OrchestrationOverloadError({
            lane: isControlCommand(envelope.command) ? "control" : "ordinary",
            reason: "closed",
          }),
        );
        if (envelope.controlFinished)
          yield* Deferred.fail(
            envelope.controlFinished,
            new OrchestrationOverloadError({ lane: "control", reason: "closed" }),
          );
        yield* admission.release(envelope);
      }
      controlReservations.clear();
    }),
  );
  const probe = yield* PerformanceStageProbe;
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const readSteerFallback = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      if (command.type !== "thread.turn.start" && command.type !== "thread.turn.steer")
        return false;
      const rows = yield* sql<{
        readonly event: string;
      }>`SELECT d.event_json AS event FROM provider_turn_deliveries d JOIN next_turn_queue q ON q.command_id = d.command_id WHERE d.command_id = ${command.commandId} AND d.thread_id = ${command.threadId} AND d.state = 'rejected' AND d.certainty = 'not_sent' AND q.last_error_code = 'steer_queued' AND q.deleted_at IS NULL`;
      return rows.some(
        (row) =>
          Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationEvent))(row.event).type ===
          "thread.turn-steer-requested",
      );
    }).pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEngine.readSteerFallback")));
  const workspaceWaitError = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" | "thread.turn.steer" }>,
    detail: string,
  ) => new ThreadTurnNotReadyError({ threadId: command.threadId, detail });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = readModel.snapshotSequence;
    // Events this dispatch appended. Reconcile republishes only these: a
    // shared state directory can contain events another server already
    // handled, and republishing them starts a second provider turn.
    const appendedEventIds = new Set<OrchestrationEvent["eventId"]>();
    let commandReadModel = readModel;
    const processingStartedAtMs = Date.now();
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence, Number.MAX_SAFE_INTEGER),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      let nextReadModel = commandReadModel;
      for (const persistedEvent of persistedEvents) {
        nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
      }
      hasDeletedThreads ||= persistedEvents.some((event) => event.type === "thread.deleted");
      readModel = hasDeletedThreads ? withoutDeletedThreadDetails(nextReadModel) : nextReadModel;

      for (const persistedEvent of persistedEvents) {
        if (appendedEventIds.has(persistedEvent.eventId)) {
          yield* PubSub.publish(eventPubSub, persistedEvent);
        }
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        const steerFallback =
          Option.isSome(existingReceipt) && (yield* readSteerFallback(envelope.command));
        if (Option.isSome(existingReceipt) && !steerFallback) {
          const receipt = existingReceipt.value;
          let matchesAggregate =
            receipt.aggregateKind === aggregateRef.aggregateKind &&
            receipt.aggregateId === aggregateRef.aggregateId;
          // Old accepted pin receipts used the global event aggregate. Verify the
          // original event's anchor instead of trusting that shared aggregate.
          if (
            !matchesAggregate &&
            receipt.status === "accepted" &&
            receipt.aggregateKind === "project" &&
            receipt.aggregateId === GLOBAL_PIN_AGGREGATE_ID &&
            (envelope.command.type === "thread.pins.replace" ||
              envelope.command.type === "thread.pins.import-legacy")
          ) {
            const events = yield* Stream.runCollect(
              eventStore.readFromSequence(receipt.resultSequence - 1, 1),
            );
            const event = events[0];
            matchesAggregate =
              event !== undefined &&
              event.sequence === receipt.resultSequence &&
              event.commandId === envelope.command.commandId &&
              ((envelope.command.type === "thread.pins.replace" &&
                event.type === "thread.pins-replaced") ||
                (envelope.command.type === "thread.pins.import-legacy" &&
                  event.type === "thread.legacy-pins-imported")) &&
              event.payload.threadId === envelope.command.threadId;
          }
          if (!matchesAggregate) {
            return yield* new OrchestrationCommandIdConflictError({
              commandId: envelope.command.commandId,
              receiptAggregateKind: existingReceipt.value.aggregateKind,
              receiptAggregateId: existingReceipt.value.aggregateId,
              commandAggregateKind: aggregateRef.aggregateKind,
              commandAggregateId: aggregateRef.aggregateId,
            });
          }
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const command = envelope.command;
        if ("threadId" in command && nativeReconciledThreads.has(command.threadId)) {
          const turnId =
            "turnId" in command
              ? command.turnId
              : command.type === "thread.activity.append"
                ? command.activity.turnId
                : command.type === "thread.proposed-plan.upsert"
                  ? command.proposedPlan.turnId
                  : command.type === "thread.command-execution.record"
                    ? command.commandExecution.turnId
                    : command.type === "thread.file-change.record"
                      ? command.fileChange.turnId
                      : command.type === "thread.session.set"
                        ? (command.session.activeTurnId ?? command.settledTurnId)
                        : undefined;
          if (
            turnId &&
            (yield* sql`SELECT 1 FROM native_history_retired_turns WHERE thread_id = ${command.threadId} AND turn_id = ${turnId}`)
              .length
          )
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "This turn was retired by verified native history reconciliation.",
            });
        }

        if (
          envelope.command.type === "thread.turn.start" ||
          envelope.command.type === "thread.turn.steer" ||
          envelope.command.type === "thread.conversation.revert" ||
          envelope.command.type === "thread.native-history.reconcile"
        ) {
          const active = yield* sql<{
            readonly operationId: string;
          }>`SELECT operation_id AS "operationId" FROM rewind_requests WHERE thread_id = ${envelope.command.threadId}`;
          if (
            active.length &&
            !(
              envelope.command.type === "thread.conversation.revert" &&
              active[0]?.operationId === envelope.command.operationId
            )
          ) {
            if (
              envelope.command.type === "thread.turn.start" &&
              envelope.command.dispatchSource === "next-turn-queue"
            )
              return yield* new ThreadTurnNotReadyError({
                threadId: envelope.command.threadId,
                detail: "A conversation rewind is awaiting completion or reconciliation.",
              });
            return yield* new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail: "A conversation rewind is awaiting completion or reconciliation.",
            });
          }
        }
        if (envelope.command.type === "thread.turn.start" && diskSpaceMonitor._tag === "Some") {
          // A CLI that runs out of disk mid-turn drops transcript entries and
          // the thread cannot resume, so a new turn waits for free space.
          // Queued turns retry on their own; anything else is rejected for
          // good and must be sent again.
          const hold = yield* diskSpaceMonitor.value.turnStartHold;
          if (hold !== null) {
            if (envelope.command.dispatchSource === "next-turn-queue")
              return yield* new ThreadTurnNotReadyError({
                threadId: envelope.command.threadId,
                detail: `${hold} The queued turn starts once there is room.`,
              });
            return yield* new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail: `${hold} Then send the turn again.`,
            });
          }
        }
        if (envelope.command.type === "thread.conversation.revert") {
          const command = envelope.command;
          const operations = yield* sql<{
            threadId: string;
            targetMessageId: string;
            mode: string;
          }>`SELECT thread_id AS "threadId", target_message_id AS "targetMessageId", mode FROM rewind_operations WHERE operation_id = ${command.operationId}`;
          const requests = yield* sql<{
            payload: string;
          }>`SELECT payload_json AS payload FROM rewind_requests WHERE operation_id = ${command.operationId}`;
          if (
            operations.some(
              (operation) =>
                operation.threadId !== command.threadId ||
                operation.targetMessageId !== command.targetMessageId ||
                (operation.mode === "conversation-and-files") !== command.restoreFiles,
            ) ||
            requests.some((row) => {
              const request = JSON.parse(row.payload);
              return (
                request.threadId !== command.threadId ||
                request.targetMessageId !== command.targetMessageId ||
                request.restoreFiles !== command.restoreFiles
              );
            })
          )
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "That rewind identifier belongs to a different request.",
            });
        }
        if (
          envelope.command.type === "thread.turn.start" ||
          envelope.command.type === "thread.turn.steer"
        ) {
          const command = envelope.command;
          const thread = readModel.threads.find((entry) => entry.id === command.threadId);
          if (
            Option.isSome(queueStore) &&
            (yield* queueStore.value.listByThread(command.threadId)).state.worktreeBlockToken
          )
            return yield* workspaceWaitError(
              command,
              "Workspace preparation is still in progress. Wait for it to finish.",
            );
          if (thread?.worktreePath || envelope.workspace) {
            const project = readModel.projects.find(
              (entry) => entry.id === thread?.projectId && entry.deletedAt === null,
            );
            if (
              !thread ||
              !envelope.workspace ||
              envelope.workspace.path !== thread.worktreePath ||
              envelope.workspace.branch !== thread.branch ||
              envelope.workspace.projectCwd !== project?.workspaceRoot
            )
              return yield* workspaceWaitError(
                command,
                "The workspace changed during verification. Retry the request.",
              );
          }
        }

        const checkWorkspaceBarrier = Effect.gen(function* () {
          const command = envelope.command;
          if (!("threadId" in command)) return;
          const changingWorkspace =
            command.type === "thread.meta.update" &&
            (command.branch !== undefined || command.worktreePath !== undefined);
          const executing =
            command.type === "thread.turn.start" ||
            command.type === "thread.turn.steer" ||
            command.type === "thread.checkpoint.revert" ||
            command.type === "thread.conversation.revert" ||
            command.type === "thread.compact.request" ||
            command.type === "thread.approval.respond" ||
            command.type === "thread.user-input.respond";
          if (!changingWorkspace && !executing) return;
          const active = Option.isSome(transitions)
            ? yield* transitions.value.forThread(command.threadId, true).pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: error.message,
                    }),
                ),
              )
            : null;
          if (active && active.operationId !== envelope.workspaceWrite?.operationId)
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "A workspace transition must be resolved before continuing.",
            });
          if (!changingWorkspace || command.type !== "thread.meta.update") return;
          const thread = readModel.threads.find((entry) => entry.id === command.threadId);
          const changed =
            thread &&
            ((command.branch !== undefined && command.branch !== thread.branch) ||
              (command.worktreePath !== undefined && command.worktreePath !== thread.worktreePath));
          if (!changed) return;
          const write = envelope.workspaceWrite;
          if (
            !write ||
            !thread ||
            thread.branch !== write.expected.branch ||
            thread.worktreePath !== write.expected.worktreePath ||
            (!write.operationId &&
              !write.observation &&
              (thread.session?.updatedAt ?? null) !== write.expected.sessionUpdatedAt)
          )
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Workspace changes require a verified transition and unchanged context.",
            });
          const token =
            write.operationId && active && Option.isSome(queueStore)
              ? (yield* queueStore.value.listByThread(command.threadId)).state.worktreeBlockToken
              : undefined;
          if (
            token !== undefined &&
            active &&
            token !== active.setupOwnerToken &&
            !(token === null && active.setupOwnerToken !== null && active.setupOwnerOperationId)
          )
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Workspace setup ownership changed before metadata commit.",
            });
          if (
            write.operationId &&
            (!active || active.phase !== "applied" || active.version !== write.version)
          )
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "The workspace transition changed before metadata commit.",
            });
        });
        yield* checkWorkspaceBarrier;

        if (
          envelope.command.type === "project.meta.update" &&
          envelope.command.workspaceRoot !== undefined
        ) {
          const command = envelope.command;
          const project = readModel.projects.find((entry) => entry.id === command.projectId);
          if (
            project &&
            project.workspaceRoot !== command.workspaceRoot &&
            readModel.threads.some(
              (thread) => thread.projectId === project.id && thread.deletedAt === null,
            )
          )
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail:
                "Conversations still reference this project workspace. Create a separate project for the new workspace.",
            });
        }
        const nativeRemovedMessageIds =
          envelope.command.type === "thread.native-history.reconcile" &&
          envelope.command.removedTurnIds.length
            ? (yield* sql<{ pendingMessageId: string | null; assistantMessageId: string | null }>`
              SELECT pending_message_id AS "pendingMessageId", assistant_message_id AS "assistantMessageId"
              FROM projection_turns WHERE thread_id = ${envelope.command.threadId}
                AND ${sql.in("turn_id", envelope.command.removedTurnIds)}
            `).flatMap((row) =>
                [row.pendingMessageId, row.assistantMessageId].flatMap((id) =>
                  id ? [MessageId.make(id)] : [],
                ),
              )
            : [];
        if (hasDeletedThreads && projectionSnapshotQuery.getRetainedThreadDetails)
          commandReadModel = yield* hydrateDeciderReadModel(
            readModel,
            envelope.command,
            projectionSnapshotQuery.getRetainedThreadDetails,
          );
        const eventBase = yield* decideOrchestrationCommand({
          nativeRemovedMessageIds,
          command: envelope.command,
          readModel: commandReadModel,
          ...(envelope.command.type === "thread.turn.start" && providerRegistry._tag === "Some"
            ? { providerInstances: yield* providerRegistry.value.getProviders }
            : {}),
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* checkWorkspaceBarrier;
              if (envelope.command.type === "thread.settle") {
                const command = envelope.command;
                const [blocked] = yield* sql<{
                  request: number;
                  queued: number;
                  background: number;
                  scripts: number;
                  watch: number;
                }>`SELECT
                  (EXISTS(SELECT 1 FROM projection_pending_approvals WHERE thread_id=${command.threadId} AND status='pending')
                    OR EXISTS(SELECT 1 FROM projection_pending_user_inputs WHERE thread_id=${command.threadId} AND resolution IS NULL)) AS request,
                  (EXISTS(SELECT 1 FROM next_turn_queue WHERE thread_id=${command.threadId} AND deleted_at IS NULL)
                    OR EXISTS(SELECT 1 FROM next_turn_queue_quarantine WHERE thread_id=${command.threadId})
                    OR EXISTS(SELECT 1 FROM next_turn_queue_state WHERE thread_id=${command.threadId} AND worktree_block_token IS NOT NULL)) AS queued,
                  EXISTS(SELECT 1 FROM projection_thread_background_work WHERE thread_id=${command.threadId} AND active=1) AS background,
                  EXISTS(SELECT 1 FROM thread_settlement_hooks WHERE thread_id=${command.threadId} AND state IN ('pending','running','orphaned')) AS scripts,
                  (${command.settledBy === "auto" ? 1 : 0}=1 AND EXISTS(SELECT 1 FROM thread_pull_request_watches WHERE thread_id=${command.threadId})) AS watch`;
                // The reason is shown to the user, so it names what to clear first.
                const blocker = blocked?.request
                  ? "This thread is waiting on an approval or question. Answer it before settling."
                  : blocked?.queued
                    ? "This thread has a queued message. Send it or remove it from the queue before settling."
                    : blocked?.background
                      ? "This thread still has background work running. Stop it before settling."
                      : blocked?.scripts
                        ? "Settlement scripts from an earlier settle are still running or need attention."
                        : blocked?.watch
                          ? "This thread is watching a pull request."
                          : null;
                if (blocker !== null)
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: blocker,
                  });
              }
              if (
                envelope.command.type === "thread.turn.start" &&
                envelope.command.dispatchSource === "next-turn-queue"
              ) {
                const recovery = yield* sql<{ state: string | null }>`
                  SELECT l.state FROM next_turn_queue q
                  LEFT JOIN usage_limit_resumes l ON l.thread_id = q.thread_id
                    AND l.limit_key = q.schedule_limit_key
                  WHERE q.command_id = ${envelope.command.commandId}
                    AND q.schedule_reason = 'usage_limit_reset'
                `;
                if (recovery.length > 0 && recovery[0]?.state !== "scheduled")
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail:
                      "The scheduled usage-limit continuation was cancelled before acceptance.",
                  });
              }
              const committedEvents: OrchestrationEvent[] = [];
              let nextReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                appendedEventIds.add(savedEvent.eventId);
                nextReadModel = yield* measurePerformanceStage(
                  probe,
                  "engine.readModelProjection",
                  projectEvent(nextReadModel, savedEvent),
                );
                yield* projectionPipeline.projectEvent(savedEvent, {
                  deferCursor: projectionPipeline.commitCursors !== undefined,
                });
                yield* commitSideEffects(savedEvent, {
                  commandType: envelope.command.type,
                  steerFallback,
                  readModel: nextReadModel,
                });
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: aggregateRef.aggregateKind,
                aggregateId: aggregateRef.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              if (Option.isSome(transitions) && envelope.workspaceWrite?.operationId) {
                const record = yield* transitions.value
                  .get(envelope.workspaceWrite.operationId)
                  .pipe(Effect.orDie);
                if (
                  !record ||
                  record.phase !== "applied" ||
                  record.version !== envelope.workspaceWrite.version
                )
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Workspace transition completion lost its reservation.",
                  });
                if (
                  record.intent === "use_project_checkout" &&
                  record.setupOwnerOperationId &&
                  record.operationId === `work-locally:${record.setupOwnerOperationId}` &&
                  record.result?.worktreePath === null
                ) {
                  // Consume only this setup handoff's ownership in the completion transaction.
                  // Manual and unrelated pauses remain untouched.
                  yield* sql`UPDATE next_turn_queue_state SET
                    worktree_block_token=NULL,
                    paused=CASE WHEN pause_reason_code IN ('worktree_setup','worktree_setup_failed','worktree_setup_cancelled','worktree_setup_cancelled_kept') THEN 0 ELSE paused END,
                    pause_detail=CASE WHEN pause_reason_code IN ('worktree_setup','worktree_setup_failed','worktree_setup_cancelled','worktree_setup_cancelled_kept') THEN NULL ELSE pause_detail END,
                    resumed_at=CASE WHEN pause_reason_code IN ('worktree_setup','worktree_setup_failed','worktree_setup_cancelled','worktree_setup_cancelled_kept') THEN ${lastSavedEvent.occurredAt} ELSE resumed_at END,
                    pause_reason_code=CASE WHEN pause_reason_code IN ('worktree_setup','worktree_setup_failed','worktree_setup_cancelled','worktree_setup_cancelled_kept') THEN NULL ELSE pause_reason_code END,
                    revision=revision+1
                    WHERE thread_id=${record.threadId} AND (worktree_block_token IS NULL OR worktree_block_token=${record.setupOwnerOperationId})`;
                }
                yield* transitions.value
                  .update(record, { phase: "completed", error: null })
                  .pipe(Effect.orDie);
              }
              if (projectionPipeline.commitCursors)
                yield* projectionPipeline.commitCursors(lastSavedEvent);
              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        for (const event of committedCommand.committedEvents)
          if (event.type === "thread.reverted" && event.payload.removedTurnIds?.length)
            nativeReconciledThreads.add(event.payload.threadId);
        hasDeletedThreads ||= committedCommand.committedEvents.some(
          (event) => event.type === "thread.deleted",
        );
        readModel = hasDeletedThreads
          ? withoutDeletedThreadDetails(committedCommand.nextReadModel)
          : committedCommand.nextReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          if (isControlEvent(event)) {
            envelope.controlCommitted = true;
            envelope.controlCommittedAt = controlNow();
          }
          if (
            event.type === "thread.session-stop-requested" ||
            event.type === "thread.archived" ||
            (event.type === "thread.turn-interrupt-requested" && event.payload.turnId === undefined)
          ) {
            stoppedSequences.set(event.payload.threadId, event.sequence);
            const cancelled = yield* admission.cancelQueued(
              (queued) =>
                (queued.command.type === "thread.turn.start" ||
                  queued.command.type === "thread.turn.steer") &&
                queued.command.threadId === event.payload.threadId &&
                queued.admissionOrder < envelope.admissionOrder,
            );
            for (const pending of cancelled)
              yield* Deferred.fail(
                pending.result,
                new OrchestrationOverloadError({ lane: "ordinary", reason: "superseded" }),
              );
          }
          if (event.type === "thread.deleted") stoppedSequences.delete(event.payload.threadId);
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, Date.now() - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, Date.now() - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            // Release a completed continuation before its caller can submit the next.
            yield* releaseEnvelopeAdmission(envelope);
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            !Schema.is(OrchestrationCommandPreviouslyRejectedError)(error) &&
            !Schema.is(OrchestrationCommandIdConflictError)(error)
          ) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: readModel.snapshotSequence,
                  }),
                ),
              ),
            );
          }

          if (
            Schema.is(OrchestrationCommandInvariantError)(error) &&
            envelope.command.type !== "thread.turn.steer"
          ) {
            yield* commandReceiptRepository
              .upsert({
                commandId: envelope.command.commandId,
                aggregateKind: aggregateRef.aggregateKind,
                aggregateId: aggregateRef.aggregateId,
                acceptedAt: new Date().toISOString(),
                resultSequence: readModel.snapshotSequence,
                status: "rejected",
                error: error.message,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
          yield* releaseEnvelopeAdmission(envelope);
          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* withStartupPhaseTiming("orchestration.projection.bootstrap", projectionPipeline.bootstrap);
  for (const row of yield* sql<{
    threadId: string;
  }>`SELECT DISTINCT thread_id AS "threadId" FROM native_history_retired_turns`)
    nativeReconciledThreads.add(row.threadId);

  let replayFromSequence = 0;
  let bootstrapSource: "projection-snapshot" | "event-replay" = "event-replay";
  const projectionSnapshotExit = yield* Effect.exit(
    withStartupPhaseTiming(
      "orchestration.snapshot.hydrate",
      projectionSnapshotQuery.getBootstrapSnapshot(),
    ),
  );
  if (Exit.isSuccess(projectionSnapshotExit)) {
    const projectionSnapshot = projectionSnapshotExit.value;
    if (projectionSnapshot.snapshotSequence > 0) {
      readModel = projectionSnapshot;
      replayFromSequence = projectionSnapshot.snapshotSequence;
      bootstrapSource = "projection-snapshot";
    } else {
      const hasPersistedEvents = yield* Stream.runCollect(eventStore.readFromSequence(0, 1)).pipe(
        Effect.map((chunk) => chunk.length > 0),
      );
      if (hasPersistedEvents) {
        yield* Effect.logWarning(
          "projection snapshot missing required projector state; falling back to full event replay",
        );
      } else {
        readModel = projectionSnapshot;
        bootstrapSource = "projection-snapshot";
      }
    }
  } else {
    yield* Effect.logWarning("failed to hydrate orchestration engine from projection snapshot", {
      cause: projectionSnapshotExit.cause,
    });
  }

  // Bootstrap the in-memory read model from projections when available, then
  // catch up from any newer persisted events.
  yield* Stream.runForEach(
    eventStore.readFromSequence(replayFromSequence, Number.MAX_SAFE_INTEGER),
    (event) =>
      Effect.gen(function* () {
        readModel = yield* projectEvent(readModel, event);
      }),
  );

  hasDeletedThreads = readModel.threads.some((thread) => thread.deletedAt !== null);
  if (hasDeletedThreads) readModel = withoutDeletedThreadDetails(readModel);
  yield* observeReadModelRetention(readModel);

  const worker = Effect.gen(function* () {
    for (;;) {
      const envelope = yield* admission.take;
      if (!envelope) return;
      yield* maintenanceLock
        .withShared(processEnvelope(envelope))
        .pipe(Effect.ensuring(Effect.suspend(() => releaseEnvelopeAdmission(envelope))));
    }
  });
  yield* Effect.forkScoped(worker);
  yield* Effect.log("orchestration engine started").pipe(
    Effect.annotateLogs({
      sequence: readModel.snapshotSequence,
      bootstrapSource,
      replayFromSequence,
    }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Effect.sync((): OrchestrationReadModel => readModel);

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  // Every thread of the scratch project gets its own folder before it is created, whichever
  // path creates it. The name depends only on the command, so a retried create reuses it.
  // A folder the decider would refuse is never created, and one created for a command that is
  // then rejected is removed again while it is still empty.
  const withScratchFolder = (
    command: OrchestrationCommand,
    created: { folder: string | undefined },
  ) =>
    Effect.gen(function* () {
      if (command.type !== "thread.create") return command;
      const project = readModel.projects.find(
        (entry) => entry.id === command.projectId && entry.deletedAt === null,
      );
      if (!isScratchProject(project) || !project) return command;
      const { scratchFolderWords, ...rest } = command;
      const folder = NodePath.join(
        project.workspaceRoot,
        scratchThreadFolderName({
          threadId: command.threadId,
          createdAt: command.createdAt,
          text: scratchFolderWords ?? command.title,
        }),
      );
      if (
        !isScratchThreadFolder(project.workspaceRoot, folder) ||
        command.worktreePath !== null ||
        command.branch !== null
      )
        return { ...rest, scratchPath: folder };
      const existed = yield* Effect.promise(() =>
        NodeFS.stat(folder).then(
          () => true,
          () => false,
        ),
      );
      yield* Effect.tryPromise({
        try: () => NodeFS.mkdir(folder, { recursive: true }),
        catch: () =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Failed to create the folder for this thread.",
          }),
      });
      if (!existed) created.folder = folder;
      return { ...rest, scratchPath: folder };
    });
  const removeEmptyScratchFolder = (created: { folder: string | undefined }) =>
    created.folder === undefined
      ? Effect.void
      : Effect.promise(() => NodeFS.rmdir(created.folder!).catch(() => undefined));

  const dispatch: OrchestrationEngineShape["dispatch"] = (incoming) =>
    Effect.gen(function* () {
      const created: { folder: string | undefined } = { folder: undefined };
      const command = yield* withScratchFolder(incoming, created);
      // Git I/O must not occupy the serialized projection worker. The worker
      // revalidates this metadata fingerprint before accepting the command.
      let workspace: CommandEnvelope["workspace"];
      if (
        (command.type === "thread.turn.start" || command.type === "thread.turn.steer") &&
        (Option.isNone(
          yield* commandReceiptRepository.getByCommandId({ commandId: command.commandId }),
        ) ||
          (yield* readSteerFallback(command)))
      ) {
        const thread = readModel.threads.find((entry) => entry.id === command.threadId);
        if (thread?.worktreePath) {
          const project = readModel.projects.find(
            (entry) => entry.id === thread.projectId && entry.deletedAt === null,
          );
          if (!project || Option.isNone(workspaceGit))
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Workspace identity cannot be verified.",
            });
          workspace = {
            path: thread.worktreePath,
            branch: thread.branch,
            projectCwd: project.workspaceRoot,
          };
          yield* assertWorktreeReady(
            workspaceGit.value,
            {
              projectCwd: workspace.projectCwd,
              worktreePath: workspace.path,
              branch: workspace.branch,
            },
            command.type === "thread.turn.start",
            {
              allowBranchDrift:
                command.expectedTurnId !== undefined &&
                thread.session?.activeTurnId === command.expectedTurnId,
            },
          ).pipe(
            Effect.mapError((error) =>
              error instanceof WorktreeInspectionError
                ? workspaceWaitError(command, error.message)
                : new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: error.message,
                  }),
            ),
          );
        }
      }
      const control = isControlCommand(command);
      const inheritedControl =
        command.type === "thread.session.set" || command.type === "thread.activity.append"
          ? yield* ProviderControlTarget
          : undefined;
      const existingControl = controlReservations.get(command.commandId);
      if (control && existingControl) {
        const conflict = controlCommandConflict(existingControl, command);
        if (conflict) return yield* conflict;
        return yield* Deferred.await(existingControl.result);
      }
      let controlOrigin: ControlOrigin | undefined;
      if (control && "threadId" in command) {
        let binding: { provider: string; instanceId: string | null; payload: unknown } | undefined;
        if (Option.isSome(sessionDirectory)) {
          const current = Option.getOrUndefined(
            yield* sessionDirectory.value
              .getBinding(command.threadId)
              .pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEngine.controlOrigin"))),
          );
          if (current)
            binding = {
              provider: current.provider,
              instanceId: current.providerInstanceId ?? current.provider,
              payload: current.runtimePayload,
            };
        } else {
          const rows = yield* sql<{
            provider: string;
            instanceId: string | null;
            payload: string | null;
          }>`SELECT provider_name AS provider, provider_instance_id AS instanceId, runtime_payload_json AS payload FROM provider_session_runtime WHERE thread_id = ${command.threadId}`.pipe(
            Effect.mapError(toPersistenceSqlError("OrchestrationEngine.controlOrigin")),
          );
          if (rows[0])
            binding = {
              ...rows[0],
              instanceId: rows[0].instanceId ?? rows[0].provider,
              payload: rows[0].payload ? JSON.parse(rows[0].payload) : null,
            };
        }
        controlOrigin = {
          threadId: command.threadId,
          provider: binding?.provider ?? null,
          instanceId: binding?.instanceId ?? null,
          generation: binding ? readPersistedSessionGeneration(binding.payload) : null,
          activeTurnId:
            readModel.threads.find((thread) => thread.id === command.threadId)?.session
              ?.activeTurnId ?? null,
        };
      }
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      const envelope: CommandEnvelope = {
        command,
        result,
        startedAtMs: Date.now(),
        admissionOrder: 0,
        workspaceWrite: yield* WorkspaceWriteContext,
        ...(controlOrigin
          ? {
              controlOrigin,
              controlFinished: yield* Deferred.make<void, OrchestrationOverloadError>(),
            }
          : {}),
        ...(workspace ? { workspace } : {}),
      };
      const bytes = Buffer.byteLength(JSON.stringify(command));
      const lossless = yield* LosslessCommandAdmission;
      const admittedResult = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (
            !accepting &&
            !(yield* AcceptedShutdownWork) &&
            !(
              inheritedControl &&
              [...controlReservations.values()].some(
                (pending) => pending.controlOrigin === inheritedControl,
              )
            )
          )
            return yield* new OrchestrationOverloadError({
              lane: control ? "control" : "ordinary",
              reason: "closed",
            });
          const existing = control ? controlReservations.get(command.commandId) : undefined;
          if (existing) {
            const conflict = controlCommandConflict(existing, command);
            if (conflict) return yield* conflict;
            return existing.result;
          }
          envelope.admissionOrder = ++admissionOrder;
          const owner =
            inheritedControl &&
            "threadId" in command &&
            command.threadId === inheritedControl.threadId
              ? [...controlReservations.values()].find(
                  (pending) => pending.controlOrigin === inheritedControl,
                )
              : undefined;
          // Publish the identity before waking the engine/consumer. Admission may yield.
          if (control) controlReservations.set(command.commandId, envelope);
          yield* (
            owner
              ? admission.offerContinuation(envelope, bytes, owner)
              : lossless && !control
                ? restore(admission.enqueue(envelope, bytes))
                : admission.offer(envelope, bytes, control)
          ).pipe(
            Effect.onError((cause) =>
              Effect.gen(function* () {
                if (controlReservations.get(command.commandId) === envelope)
                  controlReservations.delete(command.commandId);
                // A duplicate may already be waiting on this temporarily published
                // reservation. Admission failure must settle that waiter as well.
                yield* Deferred.failCause(result, cause);
              }),
            ),
          );
          return result;
        }),
      );
      return yield* Deferred.await(admittedResult).pipe(
        Effect.tapError(() => removeEmptyScratchFolder(created)),
      );
    });

  // PubSub is intentionally not replayed. Detect a missing/dead consumer without
  // releasing controls that have already begun a potentially ambiguous side effect.
  yield* Effect.forever(
    Effect.sleep("1 second").pipe(
      Effect.andThen(
        Effect.gen(function* () {
          for (const envelope of controlReservations.values()) {
            if (
              envelope.controlClaimed ||
              envelope.controlExpired ||
              envelope.controlCommittedAt === undefined ||
              controlNow() - envelope.controlCommittedAt < CONTROL_DELIVERY_TIMEOUT_MS
            )
              continue;
            envelope.controlExpired = true;
            const error = new OrchestrationOverloadError({ lane: "control", reason: "closed" });
            if (envelope.controlFinished) yield* Deferred.fail(envelope.controlFinished, error);
            const command = envelope.command;
            if (!isControlCommand(command) || !("threadId" in command)) continue;
            const createdAt = new Date().toISOString();
            yield* Effect.logWarning("provider control was not consumed; action was not sent", {
              commandId: command.commandId,
              commandType: command.type,
            });
            yield* dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(`${command.commandId}:unconsumed`),
              threadId: command.threadId,
              activity: {
                id: EventId.makeUnsafe(`${command.commandId}:unconsumed`),
                tone: "error",
                kind:
                  command.type === "thread.session.stop"
                    ? "provider.session.stop.failed"
                    : command.type === "thread.turn.interrupt"
                      ? "provider.turn.interrupt.failed"
                      : command.type === "thread.approval.respond"
                        ? "provider.approval.respond.failed"
                        : "provider.user-input.respond.failed",
                summary: "The provider action could not start",
                payload: {
                  detail:
                    "The action was not sent because the provider command consumer did not start it. Retry the action after recovery.",
                },
                turnId: null,
                createdAt,
              },
              createdAt,
            }).pipe(
              Effect.provideService(ProviderControlTarget, envelope.controlOrigin),
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to record unconsumed control", {
                  cause: Cause.pretty(cause),
                }),
              ),
              Effect.ensuring(releaseControl(command.commandId)),
            );
          }
        }),
      ),
    ),
  ).pipe(Effect.forkScoped);

  return {
    completeControl: releaseControl,
    claimControl: (commandId) =>
      Effect.sync(() => {
        const envelope = controlReservations.get(commandId);
        if (!envelope || envelope.controlExpired || envelope.controlClaimed) return false;
        envelope.controlClaimed = true;
        return true;
      }),
    waitForControlProgress: (threadId) =>
      Effect.suspend(() =>
        Effect.forEach(
          [...controlReservations.values()].filter(
            (envelope) => envelope.controlOrigin?.threadId === threadId,
          ),
          (envelope) =>
            envelope.controlFinished ? Deferred.await(envelope.controlFinished) : Effect.void,
          { concurrency: "unbounded", discard: true },
        ),
      ),
    controlOrigin: (commandId) => controlReservations.get(commandId)?.controlOrigin,
    isTurnStartSuperseded: (event) =>
      event.aggregateKind === "thread" &&
      event.sequence < (stoppedSequences.get(event.aggregateId) ?? 0),
    inspectQueue: admission.snapshot,
    getReadModel,
    readEvents,
    dispatch,
    acquireMaintenanceLock: maintenanceLock.acquireExclusive,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
