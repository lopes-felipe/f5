import {
  MessageId,
  type CommandId,
  type OrchestrationLatestTurn,
  type OrchestrationThread,
  type ThreadId,
  TurnId,
  type WorkflowRunKind,
} from "@t3tools/contracts";
import { Cause, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  bestEffortBenchmark,
  findWorkflowTurnAttribution,
} from "./workflowBenchmarkPersistence.ts";
import {
  benchmarkRunKind,
  benchmarkTasks,
  type BenchmarkWorkflow,
} from "./workflowBenchmarkTasks.ts";

import { ProviderTurnDeliveryRepository } from "./Services/ProviderTurnDeliveryRepository.ts";
import type { ProviderTurnDeliveryOutcome } from "./Services/ProviderTurnDeliveryWorker.ts";

/** Continuations can finish a stage, but an unrelated prompt on its thread cannot. */
export const makeWorkflowDeliveryOriginResolver = Effect.gen(function* () {
  const repository = yield* Effect.serviceOption(ProviderTurnDeliveryRepository);
  return (outcome: ProviderTurnDeliveryOutcome) =>
    Effect.gen(function* () {
      if (repository._tag === "None") return outcome.commandId;
      const delivery = yield* repository.value.getByCommandId(outcome.commandId);
      const event = delivery?.event;
      return event?.type === "thread.turn-start-requested"
        ? (event.payload.workflowAttribution?.originCommandId ?? outcome.commandId)
        : outcome.commandId;
    }).pipe(Effect.orElseSucceed(() => outcome.commandId));
});

/**
 * Which provider turn may complete a running workflow stage.
 *
 * - `any`: the stage has no recorded dispatch (a legacy stage) or the server
 *   runs without a delivery outbox, so any finished turn on the stage thread
 *   counts, as before.
 * - `pending`: the stage's turn has not been accepted by the provider yet, its
 *   delivery failed, or its delivery row does not exist yet. Stages save their
 *   dispatch id before dispatching, and the row is written with the
 *   turn-start event, so in that window no finished turn belongs to the stage.
 * - `turn`: only the provider turn accepted for the stage's dispatch counts.
 */
export type WorkflowStageDispatchTurn =
  | { readonly kind: "any" }
  | { readonly kind: "pending" }
  | { readonly kind: "turn"; readonly turnId: TurnId; readonly attributed?: true };

/**
 * Upper bound for the startup recheck of a finished stage's delivery. It runs
 * before the workflow services subscribe to domain events and can call the
 * provider, so it must not stretch that window.
 */
export const STARTUP_DISPATCH_RECHECK_TIMEOUT = "5 seconds";

const ANY: WorkflowStageDispatchTurn = { kind: "any" };
const PENDING: WorkflowStageDispatchTurn = { kind: "pending" };

export function stageDispatchAllowsTurn(
  dispatch: WorkflowStageDispatchTurn,
  turnId: string,
): boolean {
  switch (dispatch.kind) {
    case "any":
      return true;
    case "pending":
      return false;
    case "turn":
      return dispatch.turnId === turnId;
  }
}

/**
 * Resolves a stage's dispatch command to the provider turn it started, using
 * the durable delivery row written with the turn-start event. Read failures
 * are treated as `pending` so a transient error never completes a stage with
 * the wrong turn; the next thread event or delivery outcome retries.
 */
export const makeWorkflowStageDispatchResolver = Effect.gen(function* () {
  const repository = yield* Effect.serviceOption(ProviderTurnDeliveryRepository);
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  return (
    dispatchCommandId: CommandId | null | undefined,
    threadId?: ThreadId | null,
    stage?: {
      readonly runKind: WorkflowRunKind;
      readonly workflowId: string;
      readonly taskId: string;
    },
  ): Effect.Effect<WorkflowStageDispatchTurn> => {
    if (repository._tag === "None" || (!dispatchCommandId && !(stage && threadId))) {
      return Effect.succeed(ANY);
    }
    const store = repository.value;
    return Effect.gen(function* () {
      const registered = dispatchCommandId
        ? yield* store.getByCommandId(dispatchCommandId)
        : stage && threadId && store.getWorkflowStageDelivery
          ? yield* store.getWorkflowStageDelivery({ ...stage, threadId })
          : null;
      if (!registered) return dispatchCommandId ? PENDING : ANY;
      if (threadId && registered.threadId !== threadId) return PENDING;
      const event = registered.event;
      const originCommandId =
        event?.type === "thread.turn-start-requested" ||
        event?.type === "thread.turn-steer-requested"
          ? event.payload.workflowAttribution?.originCommandId
          : undefined;
      const delivery =
        originCommandId && store.getWorkflowAttemptDelivery
          ? yield* store.getWorkflowAttemptDelivery(originCommandId, registered.threadId)
          : registered;
      if (delivery?.state === "accepted" && delivery.providerTurnId !== null) {
        if (originCommandId && sqlOption._tag === "Some") {
          const owner = yield* findWorkflowTurnAttribution(
            sqlOption.value,
            delivery.threadId,
            delivery.providerTurnId,
          );
          if (owner?.originCommandId !== originCommandId) return PENDING;
          const sql = sqlOption.value;
          const [queued] = yield* sql`
            SELECT 1 FROM next_turn_queue q
            WHERE q.thread_id = ${delivery.threadId} AND q.deleted_at IS NULL
              AND q.status IN ('queued','dispatching')
              AND json_extract(q.command_json,'$.workflowContinuationTurnId') = ${delivery.providerTurnId}
              AND NOT EXISTS (SELECT 1 FROM provider_turn_deliveries next
                WHERE next.command_id = q.command_id AND next.state = 'accepted')
            LIMIT 1
          `;
          if (queued) return PENDING;
        }
        return {
          kind: "turn",
          turnId: delivery.providerTurnId,
          ...(originCommandId ? ({ attributed: true } as const) : {}),
        } as const;
      }
      return PENDING;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("workflow stage dispatch lookup failed", {
          dispatchCommandId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(PENDING)),
      ),
    );
  };
});

/** A shared thread can move on before delivery acceptance reaches the workflow. */
export const makeWorkflowStageThreadResolver = Effect.gen(function* () {
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  return (
    thread: OrchestrationThread | undefined,
    dispatch: WorkflowStageDispatchTurn,
    pinnedMessageId?: string | null,
    pinnedPlanId?: string | null,
  ) =>
    Effect.gen(function* () {
      if (!thread || dispatch.kind === "pending") return undefined;
      if (dispatch.kind === "any") return thread;
      if (
        dispatch.turnId === thread.latestTurn?.turnId &&
        (pinnedMessageId === undefined ||
          thread.messages.some((message) => message.id === pinnedMessageId)) &&
        (!pinnedPlanId || thread.proposedPlans.some((plan) => plan.id === pinnedPlanId))
      ) {
        return dispatch.attributed &&
          thread.latestTurn.state === "completed" &&
          thread.latestTurn.processingQuiescedAt === null
          ? undefined
          : thread;
      }
      if (sqlOption._tag === "None") return undefined;
      const sql = sqlOption.value;
      const [turn] = yield* sql<OrchestrationLatestTurn>`
        SELECT turn_id AS turnId, state, requested_at AS requestedAt, started_at AS startedAt,
          completed_at AS completedAt, processing_quiesced_at AS processingQuiescedAt,
          assistant_message_id AS assistantMessageId
        FROM projection_turns
        WHERE thread_id = ${thread.id} AND turn_id = ${dispatch.turnId} AND state = 'completed'
      `;
      if (!turn) return undefined;
      if (
        dispatch.attributed &&
        turn.processingQuiescedAt === null &&
        (!thread.latestTurn ||
          thread.latestTurn.requestedAt <= (turn.completedAt ?? turn.requestedAt))
      ) {
        return undefined;
      }
      const messages = yield* sql<{
        id: string;
        text: string;
        reasoningText: string | null;
        createdAt: string;
        updatedAt: string;
      }>`
        SELECT message_id AS id, text, reasoning_text AS reasoningText, created_at AS createdAt, updated_at AS updatedAt
        FROM projection_thread_messages
        WHERE thread_id = ${thread.id} AND turn_id = ${dispatch.turnId} AND role = 'assistant' AND is_streaming = 0
        ORDER BY (message_id = ${pinnedMessageId ?? turn.assistantMessageId}) DESC, created_at DESC, message_id DESC LIMIT 1
      `;
      const plans = yield* sql<{
        id: string;
        planMarkdown: string;
        createdAt: string;
        updatedAt: string;
      }>`
        SELECT plan_id AS id, plan_markdown AS planMarkdown, created_at AS createdAt, updated_at AS updatedAt
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${thread.id} AND turn_id = ${dispatch.turnId}
          AND (${pinnedPlanId ?? null} IS NULL OR plan_id = ${pinnedPlanId ?? null})
        ORDER BY created_at DESC, plan_id DESC LIMIT 1
      `;
      return {
        ...thread,
        latestTurn: turn,
        messages: [
          ...thread.messages.filter((message) => message.turnId !== dispatch.turnId),
          ...messages.map((message) => ({
            id: MessageId.make(message.id),
            role: "assistant" as const,
            turnId: dispatch.turnId,
            streaming: false,
            text: message.text,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            ...(message.reasoningText !== null ? { reasoningText: message.reasoningText } : {}),
          })),
        ],
        proposedPlans: [
          ...thread.proposedPlans.filter((plan) => plan.turnId !== dispatch.turnId),
          ...plans.map((plan) => ({
            ...plan,
            turnId: dispatch.turnId,
            implementedAt: null,
            implementationThreadId: null,
          })),
        ],
      } satisfies OrchestrationThread;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Workflow stage output lookup failed", {
          threadId: thread?.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
});

export const makeWorkflowPinnedOutputHydrator = Effect.gen(function* () {
  const resolveStageThread = yield* makeWorkflowStageThreadResolver;
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  return (run: BenchmarkWorkflow, snapshot: import("@t3tools/contracts").OrchestrationReadModel) =>
    Effect.gen(function* () {
      const pins =
        sqlOption._tag === "Some"
          ? yield* sqlOption.value<{
              taskId: string;
              turnId: string;
              messageId: string | null;
              planId: string | null;
            }>`
            SELECT task_id AS taskId, turn_id AS turnId, message_id AS messageId, plan_id AS planId
            FROM workflow_benchmark_outputs
            WHERE run_kind = ${benchmarkRunKind(run)} AND workflow_id = ${run.id} AND kind = 'findings'
          `.pipe(bestEffortBenchmark("read pinned review reports", []))
          : [];
      const recovered = new Map<ThreadId, OrchestrationThread>();
      for (const task of benchmarkTasks(run)) {
        if (!task.threadId || !task.turnId) continue;
        const thread =
          recovered.get(task.threadId) ??
          snapshot.threads.find((entry) => entry.id === task.threadId);
        if (!thread) continue;
        const pin = pins.find((entry) => entry.taskId === task.id && entry.turnId === task.turnId);
        const messageId = pin?.messageId ?? task.messageId;
        const hasMessage = messageId && thread.messages.some((message) => message.id === messageId);
        const hasPlan = thread.proposedPlans.some((plan) =>
          pin?.planId ? plan.id === pin.planId : plan.turnId === task.turnId,
        );
        const hydrated = (pin?.planId ? hasPlan : hasMessage || (!messageId && hasPlan))
          ? thread
          : ((yield* resolveStageThread(
              thread,
              { kind: "turn", turnId: TurnId.make(task.turnId) },
              messageId ?? null,
              pin?.planId,
            )) ?? thread);
        const plans = pin
          ? hydrated.proposedPlans.filter(
              (plan) => plan.turnId !== task.turnId || plan.id === pin.planId,
            )
          : hydrated.proposedPlans;
        if (hydrated !== thread || plans.length !== thread.proposedPlans.length)
          recovered.set(thread.id, {
            ...hydrated,
            latestTurn: thread.latestTurn,
            proposedPlans: plans,
          });
      }
      return recovered.size
        ? {
            ...snapshot,
            threads: snapshot.threads.map((thread) => recovered.get(thread.id) ?? thread),
          }
        : snapshot;
    });
});

export const makeWorkflowPromptReader = Effect.gen(function* () {
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  return (threadId: ThreadId, messageId: MessageId) =>
    sqlOption._tag === "None"
      ? Effect.succeed(null)
      : sqlOption.value<{ text: string }>`
          SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
            AND message_id = ${messageId} AND role = 'user'
        `.pipe(Effect.map((rows) => rows[0]?.text ?? null));
});
