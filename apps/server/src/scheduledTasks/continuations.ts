import { makeScheduledTaskStore, scheduleError } from "./Store.ts";
import { Effect, Clock } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export interface ScheduledContinuationContext {
  readonly runId: string;
  readonly parentSubmissionId: string;
  readonly kind: "usage_limit" | "restart" | "user_input";
}
export const scheduledContinuationFor = (
  threadId: string,
  turnId: string | null | undefined,
  kind: ScheduledContinuationContext["kind"],
) =>
  Effect.gen(function* () {
    if (!turnId) return undefined;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      runId: string;
      parentSubmissionId: string;
      owner: number;
      canceled: number;
    }>`SELECT r.id AS "runId",s.submission_id AS "parentSubmissionId",r.owns_execution AS owner,r.canceled FROM scheduled_task_runs r JOIN scheduled_run_submissions s ON s.run_id=r.id WHERE r.thread_id=${threadId} AND s.turn_id=${turnId} LIMIT 1`;
    // A human answer after a canceled/terminal scheduled execution is ordinary
    // user work. Automatic recovery must never lose its scheduling association.
    if (kind === "user_input" && rows[0] && (!rows[0].owner || rows[0].canceled)) return undefined;
    if (rows[0] && (!rows[0].owner || rows[0].canceled))
      return yield* scheduleError(
        "forbidden",
        "The scheduled execution is no longer authorized to continue.",
      );
    return rows[0]
      ? { runId: rows[0].runId, parentSubmissionId: rows[0].parentSubmissionId, kind }
      : undefined;
  });
/** Inserted in the same queue transaction as the continuation; ownership is never released between turns. */
export const linkScheduledContinuation = (
  context: ScheduledContinuationContext,
  input: {
    submissionId: string;
    messageId: string;
    threadId: string;
    notBefore?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const store = yield* makeScheduledTaskStore;
    const { sql } = store;
    const run = yield* store.run(context.runId);
    if (!run?.owner || run.canceled)
      return yield* scheduleError(
        "forbidden",
        "The scheduled execution was canceled before continuation admission.",
      );
    yield* sql`INSERT OR IGNORE INTO scheduled_run_submissions(submission_id,run_id,thread_id,message_id,parent_submission_id,kind,recovery_decision) VALUES(${input.submissionId},${context.runId},${input.threadId},${input.messageId},${context.parentSubmissionId},${context.kind},'continue')`;
    yield* store.transition(
      context.runId,
      "pending",
      "recovery_pending",
      yield* Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString())),
    );
    yield* sql`UPDATE scheduled_task_runs SET capacity=CASE WHEN ${context.kind}='user_input' THEN capacity ELSE 0 END,retry_at=${input.notBefore ?? null} WHERE id=${context.runId} AND owns_execution=1 AND canceled=0`;
  });
/** Continuations preserve the admitted provider/model/options and approval mode. */
export const freezeScheduledContinuationCommand = (
  context: ScheduledContinuationContext,
  command: import("@t3tools/contracts").ThreadTurnStartCommand,
) =>
  Effect.gen(function* () {
    const store = yield* makeScheduledTaskStore;
    const run = yield* store.run(context.runId);
    if (!run?.owner || run.canceled)
      return yield* scheduleError("forbidden", "This scheduled execution cannot continue.");
    const { modelOptions: _legacyOptions, providerOptions: _providerOptions, ...rest } = command;
    return {
      ...rest,
      model: run.snapshot.modelSelection.model,
      modelSelection: run.snapshot.modelSelection,
      runtimeMode: run.snapshot.runtimeMode,
      ...(run.command?.provider ? { provider: run.command.provider } : {}),
    } satisfies import("@t3tools/contracts").ThreadTurnStartCommand;
  });
