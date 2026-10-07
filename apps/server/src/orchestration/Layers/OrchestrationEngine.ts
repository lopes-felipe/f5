import type { OrchestrationReadModel, ProjectId, ThreadId } from "@t3tools/contracts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { canonicalRequestHash } from "../../nextTurnQueue/canonicalRequestHash.ts";
import { OrchestrationCommand, OrchestrationEvent } from "@t3tools/contracts";
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
  Queue,
  Schema,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  ThreadTurnNotReadyError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand, GLOBAL_PIN_AGGREGATE_ID } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { makeStorageMaintenanceLock } from "../../storage/StorageMaintenanceLock.ts";
import { withStartupPhaseTiming } from "../../startupTiming.ts";

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
    case "project.memory.save":
    case "project.memory.update":
    case "project.memory.delete":
    case "project.skills.replace":
    case "project.workflow.create":
    case "project.workflow.delete":
    case "project.workflow.upsert":
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

/** Queue pauses the user or environment chose, which a conversation revert must not undo. */
const QUEUE_PAUSES_KEPT_ACROSS_REVERT: ReadonlySet<string> = new Set([
  "manual_pause",
  "thread_archived",
  "worktree_missing",
]);

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queueStore = yield* Effect.serviceOption(NextTurnQueueStore);
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const maintenanceLock = yield* makeStorageMaintenanceLock;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = readModel.snapshotSequence;
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

      let nextReadModel = readModel;
      for (const persistedEvent of persistedEvents) {
        nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
      }
      readModel = nextReadModel;

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
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
        const fallbackRows =
          (envelope.command.type === "thread.turn.start" ||
            envelope.command.type === "thread.turn.steer") &&
          Option.isSome(existingReceipt)
            ? yield* sql<{
                readonly event: string;
              }>`SELECT d.event_json AS event FROM provider_turn_deliveries d JOIN next_turn_queue q ON q.command_id = d.command_id WHERE d.command_id = ${envelope.command.commandId} AND d.thread_id = ${envelope.command.threadId} AND d.state = 'rejected' AND d.certainty = 'not_sent' AND q.last_error_code = 'steer_queued' AND q.deleted_at IS NULL`
            : [];
        const steerFallback = fallbackRows.some(
          (row) =>
            Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationEvent))(row.event).type ===
            "thread.turn-steer-requested",
        );
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

        if (
          envelope.command.type === "thread.turn.start" ||
          envelope.command.type === "thread.turn.steer" ||
          envelope.command.type === "thread.conversation.revert"
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
        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel,
          ...(envelope.command.type === "thread.turn.start" && providerRegistry._tag === "Some"
            ? { providerInstances: yield* providerRegistry.value.getProviders }
            : {}),
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              let nextReadModel = readModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                if (savedEvent.type === "thread.message-sent") {
                  yield* Effect.forEach(
                    savedEvent.payload.attachments ?? [],
                    (attachment) =>
                      Effect.gen(function* () {
                        yield* sql`
                          DELETE FROM attachment_owners
                          WHERE attachment_id = ${attachment.id}
                            AND owner_kind IN ('ingress', 'queue_item')
                        `;
                        yield* sql`
                          INSERT OR IGNORE INTO attachment_owners (
                            attachment_id, owner_kind, owner_id, created_at
                          ) VALUES (
                            ${attachment.id}, 'message', ${savedEvent.payload.messageId},
                            ${savedEvent.occurredAt}
                          )
                        `;
                      }),
                    { concurrency: 1, discard: true },
                  );
                }
                if (
                  savedEvent.type === "thread.turn-start-requested" ||
                  savedEvent.type === "thread.turn-steer-requested"
                ) {
                  const eventJson = Schema.encodeSync(Schema.fromJsonString(OrchestrationEvent))(
                    savedEvent,
                  );
                  if (steerFallback)
                    yield* sql`UPDATE provider_turn_deliveries SET event_json = ${eventJson}, state = 'pending', provider_turn_id = NULL, attempt = 0, error_code = NULL, error_detail = NULL, certainty = NULL, not_before = NULL, outcome_projected_at = NULL WHERE command_id = ${savedEvent.commandId} AND state = 'rejected' AND certainty = 'not_sent'`;
                  yield* sql`
                    INSERT OR IGNORE INTO provider_turn_deliveries (
                      delivery_id, thread_id, command_id, message_id, state, attempt,
                      pre_send_turn_ids_json, event_json, created_at, updated_at
                    ) VALUES (
                      ${savedEvent.commandId}, ${savedEvent.payload.threadId},
                      ${savedEvent.commandId}, ${savedEvent.payload.messageId}, 'pending', 0,
                      '[]', ${eventJson}, ${savedEvent.occurredAt}, ${savedEvent.occurredAt}
                    )
                  `;
                }
                if (savedEvent.type === "thread.user-input-resolved") {
                  const command = savedEvent.payload.command;
                  if (command) {
                    if (Option.isNone(queueStore))
                      return yield* new OrchestrationCommandInvariantError({
                        commandType: envelope.command.type,
                        detail: "The durable answer queue is unavailable.",
                      });
                    yield* queueStore.value
                      .insertSubmission({
                        submissionId: command.commandId,
                        itemId: command.commandId,
                        requestHash: canonicalRequestHash(command),
                        command,
                        atHead: command.expectedTurnId !== undefined,
                      })
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new OrchestrationCommandInvariantError({
                              commandType: envelope.command.type,
                              detail: error.message,
                            }),
                        ),
                      );
                    for (const attachment of savedEvent.payload.attachments ?? [])
                      yield* sql`DELETE FROM attachment_owners WHERE attachment_id = ${attachment.id} AND owner_kind = 'ingress' AND owner_id = ${savedEvent.commandId}`;
                  } else
                    for (const attachment of savedEvent.payload.attachments ?? []) {
                      yield* sql`DELETE FROM attachment_owners WHERE attachment_id = ${attachment.id} AND owner_kind = 'ingress' AND owner_id = ${savedEvent.commandId}`;
                      yield* sql`INSERT OR IGNORE INTO attachment_owners VALUES (${attachment.id}, 'user_input', ${savedEvent.payload.requestId}, ${savedEvent.occurredAt})`;
                    }
                }
                if (savedEvent.type === "thread.rewind-draft-resolved") {
                  const { operationId, threadId } = savedEvent.payload;
                  if (savedEvent.payload.intent === "cancel") {
                    // Cancel a rewind the provider never applied (`prepared` is only kept
                    // when that is proven). Give the prompt's attachments back to its
                    // message, restore the queue, and unblock the thread. Deleting the
                    // request row also stops a Retry still queued behind the rewind
                    // gate, and a run that already loaded the operation loses its
                    // conditional claim of `provider-pending` against this delete.
                    const pending = (yield* sql<{
                      target_message_id: string;
                    }>`SELECT target_message_id FROM rewind_operations WHERE operation_id = ${operationId} AND thread_id = ${threadId} AND state = 'prepared'`)[0];
                    if (!pending)
                      return yield* new OrchestrationCommandInvariantError({
                        commandType: envelope.command.type,
                        detail:
                          "This rewind is already in progress or finished and can no longer be cancelled.",
                      });
                    yield* sql`INSERT OR IGNORE INTO attachment_owners(attachment_id, owner_kind, owner_id, created_at) SELECT attachment_id, 'message', ${pending.target_message_id}, ${savedEvent.occurredAt} FROM attachment_owners WHERE owner_kind = 'rewind_draft' AND owner_id = ${operationId}`;
                    yield* sql`DELETE FROM attachment_owners WHERE owner_kind = 'rewind_draft' AND owner_id = ${operationId}`;
                    const saved = (yield* sql<{
                      state: string | null;
                    }>`SELECT queue_state_json AS state FROM rewind_requests WHERE operation_id = ${operationId}`)[0];
                    const prior = saved?.state
                      ? (JSON.parse(saved.state) as {
                          paused: number;
                          pause_reason_code: string | null;
                          pause_detail: string | null;
                        })
                      : { paused: 0, pause_reason_code: null, pause_detail: null };
                    // Only the pauses this rewind set; another pause (for example a
                    // checkpoint revert) must survive the cancel.
                    yield* sql`UPDATE next_turn_queue_state SET paused = ${prior.paused}, pause_reason_code = ${prior.pause_reason_code}, pause_detail = ${prior.pause_detail}, revision = revision + 1 WHERE thread_id = ${threadId} AND pause_reason_code IN ('rewind_in_progress', 'reconciliation_required')`;
                    yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${operationId}`;
                    yield* sql`DELETE FROM rewind_operations WHERE operation_id = ${operationId} AND state = 'prepared'`;
                  } else {
                    const draft =
                      yield* sql`SELECT operation_id FROM rewind_operations WHERE operation_id = ${operationId} AND thread_id = ${threadId} AND state = 'completed'`;
                    if (!draft.length)
                      return yield* new OrchestrationCommandInvariantError({
                        commandType: envelope.command.type,
                        detail: "This rewind draft is not ready.",
                      });
                    yield* sql`DELETE FROM attachment_owners WHERE owner_kind = 'rewind_draft' AND owner_id = ${operationId} AND attachment_id IN (SELECT attachment_id FROM attachments WHERE thread_id = ${threadId})`;
                    yield* sql`UPDATE rewind_operations SET draft_resolved_at = ${savedEvent.occurredAt} WHERE operation_id = ${operationId} AND thread_id = ${threadId} AND state = 'completed'`;
                  }
                }
                if (savedEvent.type === "thread.reverted" && savedEvent.payload.operationId) {
                  const { operationId, threadId } = savedEvent.payload;
                  yield* sql`DELETE FROM restart_turn_markers WHERE thread_id = ${threadId}`;
                  const saved = (yield* sql<{
                    state: string | null;
                  }>`SELECT queue_state_json AS state FROM rewind_requests WHERE operation_id = ${operationId}`)[0];
                  const prior = saved?.state
                    ? (JSON.parse(saved.state) as {
                        paused: number;
                        pause_reason_code: string | null;
                        pause_detail: string | null;
                      })
                    : { paused: 0, pause_reason_code: null, pause_detail: null };
                  const queued =
                    yield* sql`SELECT 1 FROM next_turn_queue WHERE thread_id = ${threadId} AND deleted_at IS NULL LIMIT 1`;
                  // A pause the user or the environment chose outlives the revert. Pauses
                  // about turns (failed, interrupted, ...) described turns the revert just
                  // deleted, so they go. Queued prompts were written against the discarded
                  // conversation and wait for review; with nothing queued the queue runs.
                  const next =
                    prior.paused &&
                    prior.pause_reason_code !== null &&
                    QUEUE_PAUSES_KEPT_ACROSS_REVERT.has(prior.pause_reason_code)
                      ? prior
                      : queued.length > 0
                        ? { paused: 1, pause_reason_code: "thread_reverted", pause_detail: null }
                        : { paused: 0, pause_reason_code: null, pause_detail: null };
                  // Only replaces the pause this rewind set; one set meanwhile survives.
                  yield* sql`UPDATE next_turn_queue_state SET paused = ${next.paused}, pause_reason_code = ${next.pause_reason_code}, pause_detail = ${next.pause_detail}, revision = revision + 1 WHERE thread_id = ${threadId} AND pause_reason_code IN ('rewind_in_progress', 'reconciliation_required')`;
                  yield* sql`UPDATE rewind_operations SET state = 'completed', updated_at = ${savedEvent.occurredAt} WHERE operation_id = ${savedEvent.payload.operationId} AND thread_id = ${savedEvent.payload.threadId} AND state = 'files-confirmed'`;
                  yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${savedEvent.payload.operationId}`;
                }
                if (savedEvent.type === "thread.conversation-revert-requested") {
                  const priorQueueState =
                    (yield* sql`SELECT paused, pause_reason_code, pause_detail FROM next_turn_queue_state WHERE thread_id = ${savedEvent.payload.threadId}`)[0] ?? {
                      paused: 0,
                      pause_reason_code: null,
                      pause_detail: null,
                    };
                  yield* sql`INSERT OR IGNORE INTO rewind_requests(operation_id, thread_id, payload_json, created_at, queue_state_json) VALUES (${savedEvent.payload.operationId}, ${savedEvent.payload.threadId}, ${JSON.stringify(savedEvent.payload)}, ${savedEvent.occurredAt}, ${JSON.stringify(priorQueueState)})`;
                  yield* sql`INSERT INTO next_turn_queue_state(thread_id, paused, pause_reason_code, revision, updated_at) VALUES (${savedEvent.payload.threadId}, 1, 'rewind_in_progress', 1, ${savedEvent.occurredAt}) ON CONFLICT(thread_id) DO UPDATE SET paused = 1, pause_reason_code = 'rewind_in_progress', revision = revision + 1`;
                }
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

        readModel = committedCommand.nextReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
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
          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* withStartupPhaseTiming("orchestration.projection.bootstrap", projectionPipeline.bootstrap);

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

  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(
      Effect.flatMap((envelope) => maintenanceLock.withShared(processEnvelope(envelope))),
    ),
  );
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

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result, startedAtMs: Date.now() });
      return yield* Deferred.await(result);
    });

  return {
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
