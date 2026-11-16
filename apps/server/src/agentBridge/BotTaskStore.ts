/**
 * Task board persistence and state machine.
 *
 * Every mutation runs in one transaction that:
 * 1. rechecks the client's grant generation, the task's version and epoch;
 * 2. checks the idempotency receipt (a matching retry returns the saved result,
 *    reusing an operation id with different arguments fails);
 * 3. applies the change and appends its activity;
 * 4. stores the result;
 * 5. increments the workspace revision.
 *
 * | Action          | Allowed from                         | Result                         |
 * |-----------------|--------------------------------------|--------------------------------|
 * | create          | –                                    | queued                         |
 * | claim           | queued                               | running, new epoch             |
 * | progress        | running                              | running                        |
 * | request input   | running                              | waiting-for-user, new question |
 * | reply           | waiting-for-user (question, version) | running, same epoch            |
 * | complete / fail | running                              | completed / failed (immutable) |
 * | pause           | any nonterminal except paused        | paused, new epoch              |
 * | resume          | paused, valid grant                  | queued (a fresh claim)         |
 * | cancel          | any nonterminal                      | cancelled, new epoch           |
 *
 * @module agentBridge/BotTaskStore
 */
import {
  BOT_TASK_PAGE_SIZE,
  BOT_TASK_TERMINAL_STATUSES,
  type BotTask,
  type BotTaskActivity,
  type BotTaskActivityType,
  type BotTaskStatus,
} from "@t3tools/contracts";
import { Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { canonicalJsonHash } from "../canonicalJsonHash.ts";

export const OPERATOR_NAMESPACE = "operator";
/** Progress may be reported at most once per task every 5 s. */
export const BOT_TASK_PROGRESS_INTERVAL_MS = 5_000;
export const MAX_NONTERMINAL_TASKS_PER_CLIENT = 100;

export type BotTaskErrorCode =
  | "not-found"
  | "conflict"
  | "stale-epoch"
  | "stale-version"
  | "invalid-state"
  | "limit"
  | "storage";

export class BotTaskError extends Data.TaggedError("BotTaskError")<{
  readonly code: BotTaskErrorCode;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}> {}

interface TaskRow {
  readonly id: string;
  readonly client_id: string;
  readonly project_id: string;
  readonly source_thread_id: string | null;
  readonly title: string;
  readonly instructions: string;
  readonly status: BotTaskStatus;
  readonly version: number;
  readonly execution_epoch: number;
  readonly latest_progress: string | null;
  readonly pending_question_id: string | null;
  readonly pending_question: string | null;
  readonly pending_question_at: string | null;
  readonly result: string | null;
  readonly failure: string | null;
  readonly next_sequence: number;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_contact_at: string | null;
  readonly last_progress_at: string | null;
}

interface ActivityRow {
  readonly task_id: string;
  readonly sequence: number;
  readonly revision: number;
  readonly type: BotTaskActivityType;
  readonly actor: "bot" | "operator";
  readonly content: string | null;
  readonly operation_id: string;
  readonly question_id: string | null;
  readonly created_at: string;
}

export interface BotTaskRecord extends Omit<
  BotTask,
  "clientName" | "projectId" | "sourceThreadId"
> {
  readonly projectId: string;
  readonly sourceThreadId: string | null;
}

const toTask = (row: TaskRow): BotTaskRecord => ({
  id: row.id,
  clientId: row.client_id,
  projectId: row.project_id,
  sourceThreadId: row.source_thread_id,
  title: row.title,
  instructions: row.instructions,
  status: row.status,
  version: row.version,
  executionEpoch: row.execution_epoch,
  latestProgress: row.latest_progress,
  pendingQuestion:
    row.pending_question_id !== null
      ? {
          questionId: row.pending_question_id,
          text: row.pending_question ?? "",
          askedAt: row.pending_question_at ?? row.updated_at,
        }
      : null,
  result: row.result,
  failure: row.failure,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastContactAt: row.last_contact_at,
  revision: row.revision,
});

const toActivity = (row: ActivityRow): BotTaskActivity => ({
  taskId: row.task_id,
  sequence: row.sequence,
  revision: row.revision,
  type: row.type,
  actor: row.actor,
  content: row.content,
  operationId: row.operation_id,
  questionId: row.question_id,
  createdAt: row.created_at,
});

const isTerminal = (status: BotTaskStatus) => BOT_TASK_TERMINAL_STATUSES.has(status);

const encodeCursor = (row: { created_at: string; id: string }) =>
  Buffer.from(JSON.stringify([row.created_at, row.id]), "utf8").toString("base64url");
const decodeCursor = (cursor: string): readonly [string, string] | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
};

export interface MutationIdentity {
  /** The client id, or `operator` for F5 UI operations. */
  readonly namespace: string;
  readonly operationId: string;
  readonly tool: string;
  /** Arguments that identify the operation (excluding the operation id). */
  readonly args: unknown;
}

export interface MutationOutcome<A> {
  readonly result: A;
  readonly replayed: boolean;
  readonly revision: number;
  readonly taskId: string;
}

/** Recheck of the acting client inside the transaction. */
export interface ClientFence {
  readonly clientId: string;
  readonly grantGeneration: number;
}

export interface BotTaskStore {
  readonly getTask: (taskId: string) => Effect.Effect<BotTaskRecord | null, BotTaskError>;
  readonly listTasks: (input: {
    readonly clientId?: string | undefined;
    readonly projectIds?: ReadonlySet<string> | undefined;
    readonly statuses?: ReadonlyArray<BotTaskStatus> | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<
    { readonly tasks: ReadonlyArray<BotTaskRecord>; readonly nextCursor: string | null },
    BotTaskError
  >;
  readonly listActivities: (input: {
    readonly taskId: string;
    readonly beforeSequence?: number | undefined;
    readonly limit: number;
    readonly types?: ReadonlyArray<BotTaskActivityType>;
  }) => Effect.Effect<
    { readonly activities: ReadonlyArray<BotTaskActivity>; readonly hasOlder: boolean },
    BotTaskError
  >;
  /** A stored receipt for this operation, if any (identical retries skip rate limits). */
  readonly hasReceipt: (
    namespace: string,
    operationId: string,
  ) => Effect.Effect<boolean, BotTaskError>;
  readonly countNonterminal: (clientId: string) => Effect.Effect<number, BotTaskError>;
  readonly touchContact: (taskId: string, at: string) => Effect.Effect<void, BotTaskError>;

  readonly create: (
    identity: MutationIdentity,
    input: {
      readonly clientId: string;
      readonly projectId: string;
      readonly sourceThreadId: string | null;
      readonly title: string;
      readonly instructions: string;
      readonly taskId: string;
      readonly at: string;
    },
  ) => Effect.Effect<MutationOutcome<{ readonly taskId: string }>, BotTaskError>;
  readonly claim: (
    identity: MutationIdentity,
    input: { readonly taskId: string; readonly fence: ClientFence; readonly at: string },
  ) => Effect.Effect<
    MutationOutcome<{ readonly taskId: string; readonly executionEpoch: number }>,
    BotTaskError
  >;
  readonly reportProgress: (
    identity: MutationIdentity,
    input: {
      readonly taskId: string;
      readonly fence: ClientFence;
      readonly executionEpoch: number;
      readonly summary: string;
      readonly detail: string | null;
      readonly at: string;
    },
  ) => Effect.Effect<
    MutationOutcome<{ readonly taskId: string; readonly sequence: number }>,
    BotTaskError
  >;
  readonly requestInput: (
    identity: MutationIdentity,
    input: {
      readonly taskId: string;
      readonly fence: ClientFence;
      readonly executionEpoch: number;
      readonly question: string;
      readonly questionId: string;
      readonly at: string;
    },
  ) => Effect.Effect<
    MutationOutcome<{ readonly taskId: string; readonly questionId: string }>,
    BotTaskError
  >;
  readonly finish: (
    identity: MutationIdentity,
    input: {
      readonly taskId: string;
      readonly fence: ClientFence;
      readonly executionEpoch: number;
      readonly outcome: "completed" | "failed";
      readonly text: string;
      readonly at: string;
    },
  ) => Effect.Effect<
    MutationOutcome<{ readonly taskId: string; readonly status: BotTaskStatus }>,
    BotTaskError
  >;
  readonly reply: (
    identity: MutationIdentity,
    input: {
      readonly taskId: string;
      readonly questionId: string;
      readonly expectedVersion: number;
      readonly text: string;
      readonly at: string;
    },
  ) => Effect.Effect<
    MutationOutcome<{ readonly taskId: string; readonly version: number }>,
    BotTaskError
  >;
  readonly control: (
    identity: MutationIdentity,
    input: {
      readonly taskId: string;
      readonly action: "pause" | "resume" | "cancel";
      readonly expectedVersion?: number | undefined;
      /** Resume requires a valid grant. */
      readonly clientIsValid?: (clientId: string) => boolean;
      readonly reason?: string;
      readonly at: string;
    },
  ) => Effect.Effect<
    MutationOutcome<{ readonly taskId: string; readonly status: BotTaskStatus }>,
    BotTaskError
  >;
  /** Fences every nonterminal task matching the filter: pauses it and advances its epoch. */
  readonly fenceTasks: (input: {
    readonly clientId?: string;
    readonly projectId?: string;
    readonly reason: string;
    readonly at: string;
  }) => Effect.Effect<ReadonlyArray<string>, BotTaskError>;
  readonly clearSourceThread: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<string>, BotTaskError>;
  /** Removes progress-only entries older than `before`. Questions, replies, controls, and results stay. */
  readonly pruneProgress: (before: string) => Effect.Effect<number, BotTaskError>;
}

export const makeBotTaskStore = (sql: SqlClient.SqlClient): BotTaskStore => {
  const storageError = (operation: string) => (cause: unknown) =>
    cause instanceof BotTaskError
      ? cause
      : new BotTaskError({
          code: "storage",
          message: `Task storage failed during ${operation}.`,
        });
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, BotTaskError, R> =>
      effect.pipe(Effect.mapError(storageError(operation)));

  const fail = (code: BotTaskErrorCode, message: string, retryAfterSeconds?: number) =>
    Effect.fail(
      new BotTaskError({
        code,
        message,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      }),
    );

  const selectTask = (taskId: string) =>
    sql<TaskRow>`SELECT * FROM bot_tasks WHERE id = ${taskId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );

  const bumpRevision = Effect.gen(function* () {
    yield* sql`UPDATE agent_bridge_revision SET revision = revision + 1 WHERE id = 1`;
    const rows = yield* sql<{
      revision: number;
    }>`SELECT revision FROM agent_bridge_revision WHERE id = 1`;
    return rows[0]?.revision ?? 0;
  });

  const appendActivity = (input: {
    readonly task: TaskRow;
    readonly revision: number;
    readonly type: BotTaskActivityType;
    readonly actor: "bot" | "operator";
    readonly content: string | null;
    readonly operationId: string;
    readonly questionId?: string | null;
    readonly at: string;
    /** Sequence to use; defaults to the task's next sequence. */
    readonly sequence?: number;
  }) => {
    const sequence = input.sequence ?? input.task.next_sequence;
    return sql`INSERT INTO bot_task_activities
        (task_id, sequence, revision, type, actor, content, operation_id, question_id, created_at)
      VALUES (${input.task.id}, ${sequence}, ${input.revision}, ${input.type}, ${input.actor},
        ${input.content}, ${input.operationId}, ${input.questionId ?? null}, ${input.at})`.pipe(
      Effect.as(sequence),
    );
  };

  /** Steps 2–5 of the mutation transaction around `apply` (step 3). */
  const mutate = <A extends { readonly taskId: string }, E>(
    identity: MutationIdentity,
    apply: (revision: number) => Effect.Effect<A, E>,
  ): Effect.Effect<MutationOutcome<A>, BotTaskError> => {
    const argsHash = canonicalJsonHash({ tool: identity.tool, args: identity.args });
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const receipts = yield* sql<{
            tool: string;
            args_hash: string;
            result_json: string | null;
          }>`SELECT tool, args_hash, result_json FROM agent_bridge_requests
            WHERE namespace = ${identity.namespace} AND request_id = ${identity.operationId}`;
          const receipt = receipts[0];
          if (receipt) {
            if (receipt.tool !== identity.tool || receipt.args_hash !== argsHash)
              return yield* fail(
                "conflict",
                "That operationId was already used with different arguments. Use a new operationId.",
              );
            const result = JSON.parse(receipt.result_json ?? "null") as A;
            const revisionRows = yield* sql<{ revision: number }>`SELECT revision
              FROM agent_bridge_revision WHERE id = 1`;
            return {
              result,
              replayed: true,
              revision: revisionRows[0]?.revision ?? 0,
              taskId: result.taskId,
            };
          }
          const revision = yield* bumpRevision;
          const result = yield* apply(revision);
          const at = new Date().toISOString();
          yield* sql`INSERT INTO agent_bridge_requests
              (namespace, request_id, tool, args_hash, command_json, related_ids_json,
               result_json, status, created_at, updated_at)
            VALUES (${identity.namespace}, ${identity.operationId}, ${identity.tool}, ${argsHash},
              NULL, ${JSON.stringify({ taskId: result.taskId })}, ${JSON.stringify(result)},
              'completed', ${at}, ${at})`;
          return { result, replayed: false, revision, taskId: result.taskId };
        }),
      )
      .pipe(Effect.mapError(storageError(identity.tool)));
  };

  /** Step 1 for bot writes: the task belongs to the client, the grant and epoch are current. */
  const requireBotTask = (input: {
    readonly taskId: string;
    readonly fence: ClientFence;
    readonly executionEpoch?: number;
  }) =>
    Effect.gen(function* () {
      const clients = yield* sql<{ grant_generation: number; revoked_at: string | null }>`SELECT
          grant_generation, revoked_at FROM agent_bridge_clients WHERE id = ${input.fence.clientId}`;
      const client = clients[0];
      if (
        !client ||
        client.revoked_at !== null ||
        client.grant_generation !== input.fence.grantGeneration
      )
        return yield* fail(
          "stale-epoch",
          "This connection's grant changed. Reconnect and try again.",
        );
      const task = yield* selectTask(input.taskId);
      if (!task || task.client_id !== input.fence.clientId)
        return yield* fail("not-found", "Task not found.");
      if (input.executionEpoch !== undefined && task.execution_epoch !== input.executionEpoch)
        return yield* fail(
          "stale-epoch",
          "This task's execution epoch changed (it was paused, resumed, or cancelled). Read it again with get_task.",
        );
      return task;
    });

  const requireStatus = (task: TaskRow, allowed: ReadonlyArray<BotTaskStatus>, action: string) =>
    allowed.includes(task.status)
      ? Effect.void
      : fail("invalid-state", `Cannot ${action} a task that is ${task.status}.`);

  const updateTask = (
    task: TaskRow,
    revision: number,
    changes: {
      readonly status?: BotTaskStatus;
      readonly epochDelta?: number;
      readonly latestProgress?: string | null;
      readonly pendingQuestion?: { id: string; text: string; at: string } | null;
      readonly result?: string | null;
      readonly failure?: string | null;
      readonly lastContactAt?: string;
      readonly lastProgressAt?: string;
      readonly sequenceDelta: number;
      readonly at: string;
    },
  ) => {
    const pending =
      changes.pendingQuestion === undefined
        ? {
            id: task.pending_question_id,
            text: task.pending_question,
            at: task.pending_question_at,
          }
        : changes.pendingQuestion === null
          ? { id: null, text: null, at: null }
          : changes.pendingQuestion;
    return sql`UPDATE bot_tasks SET
        status = ${changes.status ?? task.status},
        version = ${task.version + 1},
        execution_epoch = ${task.execution_epoch + (changes.epochDelta ?? 0)},
        latest_progress = ${changes.latestProgress === undefined ? task.latest_progress : changes.latestProgress},
        pending_question_id = ${pending.id},
        pending_question = ${pending.text},
        pending_question_at = ${pending.at},
        result = ${changes.result === undefined ? task.result : changes.result},
        failure = ${changes.failure === undefined ? task.failure : changes.failure},
        next_sequence = ${task.next_sequence + changes.sequenceDelta},
        revision = ${revision},
        updated_at = ${changes.at},
        last_contact_at = ${changes.lastContactAt ?? task.last_contact_at},
        last_progress_at = ${changes.lastProgressAt ?? task.last_progress_at}
      WHERE id = ${task.id} AND version = ${task.version}`;
  };

  return {
    getTask: (taskId) =>
      selectTask(taskId).pipe(
        Effect.map((row) => (row ? toTask(row) : null)),
        wrap("getTask"),
      ),
    listTasks: (input) =>
      Effect.gen(function* () {
        const limit = Math.min(input.limit ?? BOT_TASK_PAGE_SIZE, BOT_TASK_PAGE_SIZE);
        const cursor = input.cursor ? decodeCursor(input.cursor) : null;
        if (input.cursor && !cursor) return yield* fail("invalid-state", "Invalid cursor.");
        const conditions = [
          input.clientId !== undefined ? sql`client_id = ${input.clientId}` : sql`1 = 1`,
          input.statuses && input.statuses.length > 0
            ? sql.in("status", input.statuses)
            : sql`1 = 1`,
          input.projectIds !== undefined
            ? input.projectIds.size > 0
              ? sql.in("project_id", [...input.projectIds])
              : sql`1 = 0`
            : sql`1 = 1`,
          cursor
            ? sql`(created_at < ${cursor[0]} OR (created_at = ${cursor[0]} AND id < ${cursor[1]}))`
            : sql`1 = 1`,
        ];
        const rows = yield* sql<TaskRow>`SELECT * FROM bot_tasks WHERE ${sql.and(conditions)}
          ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;
        const page = rows.slice(0, limit);
        return {
          tasks: page.map(toTask),
          nextCursor: rows.length > limit && page.length > 0 ? encodeCursor(page.at(-1)!) : null,
        };
      }).pipe(wrap("listTasks")),
    listActivities: (input) =>
      Effect.gen(function* () {
        const conditions = [
          sql`task_id = ${input.taskId}`,
          input.beforeSequence !== undefined ? sql`sequence < ${input.beforeSequence}` : sql`1 = 1`,
          input.types && input.types.length > 0 ? sql.in("type", input.types) : sql`1 = 1`,
        ];
        const rows = yield* sql<ActivityRow>`SELECT * FROM bot_task_activities
          WHERE ${sql.and(conditions)} ORDER BY sequence DESC LIMIT ${input.limit + 1}`;
        return {
          activities: rows.slice(0, input.limit).map(toActivity),
          hasOlder: rows.length > input.limit,
        };
      }).pipe(wrap("listActivities")),
    hasReceipt: (namespace, operationId) =>
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_bridge_requests
        WHERE namespace = ${namespace} AND request_id = ${operationId}`.pipe(
        Effect.map((rows) => (rows[0]?.n ?? 0) > 0),
        wrap("hasReceipt"),
      ),
    countNonterminal: (clientId) =>
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM bot_tasks
        WHERE client_id = ${clientId} AND status NOT IN ('completed', 'failed', 'cancelled')`.pipe(
        Effect.map((rows) => rows[0]?.n ?? 0),
        wrap("countNonterminal"),
      ),
    touchContact: (taskId, at) =>
      sql`UPDATE bot_tasks SET last_contact_at = ${at} WHERE id = ${taskId}`.pipe(
        Effect.asVoid,
        wrap("touchContact"),
      ),

    create: (identity, input) =>
      mutate(identity, (revision) =>
        Effect.gen(function* () {
          const count = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM bot_tasks
            WHERE client_id = ${input.clientId} AND status NOT IN ('completed', 'failed', 'cancelled')`;
          if ((count[0]?.n ?? 0) >= MAX_NONTERMINAL_TASKS_PER_CLIENT)
            return yield* fail(
              "limit",
              `This client already has ${MAX_NONTERMINAL_TASKS_PER_CLIENT} open tasks.`,
            );
          yield* sql`INSERT INTO bot_tasks (id, client_id, project_id, source_thread_id, title,
              instructions, status, version, execution_epoch, next_sequence, revision,
              created_at, updated_at)
            VALUES (${input.taskId}, ${input.clientId}, ${input.projectId}, ${input.sourceThreadId},
              ${input.title}, ${input.instructions}, 'queued', 0, 0, 2, ${revision},
              ${input.at}, ${input.at})`;
          const task = (yield* selectTask(input.taskId))!;
          yield* appendActivity({
            task,
            revision,
            type: "created",
            actor: "operator",
            content: null,
            operationId: identity.operationId,
            at: input.at,
            sequence: 1,
          });
          return { taskId: input.taskId };
        }),
      ),

    claim: (identity, input) =>
      mutate(identity, (revision) =>
        Effect.gen(function* () {
          const task = yield* requireBotTask(input);
          yield* requireStatus(task, ["queued"], "claim");
          yield* updateTask(task, revision, {
            status: "running",
            epochDelta: 1,
            lastContactAt: input.at,
            sequenceDelta: 1,
            at: input.at,
          });
          yield* appendActivity({
            task,
            revision,
            type: "claimed",
            actor: "bot",
            content: null,
            operationId: identity.operationId,
            at: input.at,
          });
          return { taskId: task.id, executionEpoch: task.execution_epoch + 1 };
        }),
      ),

    reportProgress: (identity, input) =>
      mutate(identity, (revision) =>
        Effect.gen(function* () {
          const task = yield* requireBotTask(input);
          yield* requireStatus(task, ["running"], "report progress on");
          if (task.last_progress_at !== null) {
            const elapsed = Date.parse(input.at) - Date.parse(task.last_progress_at);
            if (elapsed < BOT_TASK_PROGRESS_INTERVAL_MS)
              return yield* fail(
                "limit",
                "Progress may be reported at most once every 5 seconds per task.",
                Math.max(1, Math.ceil((BOT_TASK_PROGRESS_INTERVAL_MS - elapsed) / 1000)),
              );
          }
          yield* updateTask(task, revision, {
            latestProgress: input.summary,
            lastContactAt: input.at,
            lastProgressAt: input.at,
            sequenceDelta: 1,
            at: input.at,
          });
          const sequence = yield* appendActivity({
            task,
            revision,
            type: "progress",
            actor: "bot",
            content: input.detail === null ? input.summary : `${input.summary}\n\n${input.detail}`,
            operationId: identity.operationId,
            at: input.at,
          });
          return { taskId: task.id, sequence };
        }),
      ),

    requestInput: (identity, input) =>
      mutate(identity, (revision) =>
        Effect.gen(function* () {
          const task = yield* requireBotTask(input);
          yield* requireStatus(task, ["running"], "ask a question on");
          yield* updateTask(task, revision, {
            status: "waiting-for-user",
            pendingQuestion: { id: input.questionId, text: input.question, at: input.at },
            lastContactAt: input.at,
            sequenceDelta: 1,
            at: input.at,
          });
          yield* appendActivity({
            task,
            revision,
            type: "question",
            actor: "bot",
            content: input.question,
            operationId: identity.operationId,
            questionId: input.questionId,
            at: input.at,
          });
          return { taskId: task.id, questionId: input.questionId };
        }),
      ),

    finish: (identity, input) =>
      mutate(identity, (revision) =>
        Effect.gen(function* () {
          const task = yield* requireBotTask(input);
          yield* requireStatus(
            task,
            ["running"],
            input.outcome === "completed" ? "complete" : "fail",
          );
          yield* updateTask(task, revision, {
            status: input.outcome,
            ...(input.outcome === "completed" ? { result: input.text } : { failure: input.text }),
            lastContactAt: input.at,
            sequenceDelta: 1,
            at: input.at,
          });
          yield* appendActivity({
            task,
            revision,
            type: input.outcome,
            actor: "bot",
            content: input.text,
            operationId: identity.operationId,
            at: input.at,
          });
          return { taskId: task.id, status: input.outcome as BotTaskStatus };
        }),
      ),

    reply: (identity, input) =>
      mutate(identity, (revision) =>
        Effect.gen(function* () {
          const task = yield* selectTask(input.taskId);
          if (!task) return yield* fail("not-found", "Task not found.");
          if (task.status !== "waiting-for-user" || task.pending_question_id !== input.questionId)
            return yield* fail(
              "invalid-state",
              "That question was withdrawn, superseded, or already answered.",
            );
          if (task.version !== input.expectedVersion)
            return yield* fail("stale-version", "The task changed. Review it and reply again.");
          yield* updateTask(task, revision, {
            status: "running",
            pendingQuestion: null,
            sequenceDelta: 1,
            at: input.at,
          });
          yield* appendActivity({
            task,
            revision,
            type: "reply",
            actor: "operator",
            content: input.text,
            operationId: identity.operationId,
            questionId: input.questionId,
            at: input.at,
          });
          return { taskId: task.id, version: task.version + 1 };
        }),
      ),

    control: (identity, input) =>
      mutate(identity, (revision) =>
        Effect.gen(function* () {
          const task = yield* selectTask(input.taskId);
          if (!task) return yield* fail("not-found", "Task not found.");
          if (input.expectedVersion !== undefined && task.version !== input.expectedVersion)
            return yield* fail("stale-version", "The task changed. Review it and try again.");
          if (isTerminal(task.status))
            return yield* fail("invalid-state", `The task is already ${task.status}.`);
          let sequenceDelta = 1;
          const withdraw = task.pending_question_id !== null && input.action !== "resume";
          if (input.action === "pause") {
            if (task.status === "paused")
              return yield* fail("invalid-state", "The task is already paused.");
          } else if (input.action === "resume") {
            if (task.status !== "paused")
              return yield* fail("invalid-state", "Only paused tasks resume.");
            if (input.clientIsValid && !input.clientIsValid(task.client_id))
              return yield* fail(
                "invalid-state",
                "The assigned client is revoked or no longer has access to this project.",
              );
          }
          if (withdraw) sequenceDelta += 1;
          const status: BotTaskStatus =
            input.action === "pause"
              ? "paused"
              : input.action === "resume"
                ? "queued"
                : "cancelled";
          yield* updateTask(task, revision, {
            status,
            epochDelta: input.action === "resume" ? 0 : 1,
            ...(withdraw ? { pendingQuestion: null } : {}),
            sequenceDelta,
            at: input.at,
          });
          let sequence = task.next_sequence;
          if (withdraw) {
            yield* appendActivity({
              task,
              revision,
              type: "question-withdrawn",
              actor: "operator",
              content: null,
              operationId: identity.operationId,
              questionId: task.pending_question_id,
              at: input.at,
              sequence,
            });
            sequence += 1;
          }
          yield* appendActivity({
            task,
            revision,
            type:
              input.action === "pause"
                ? "paused"
                : input.action === "resume"
                  ? "resumed"
                  : "cancelled",
            actor: "operator",
            content: input.reason ?? null,
            operationId: identity.operationId,
            at: input.at,
            sequence,
          });
          return { taskId: task.id, status };
        }),
      ),

    fenceTasks: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const conditions = [
              sql`status NOT IN ('completed', 'failed', 'cancelled', 'paused')`,
              input.clientId !== undefined ? sql`client_id = ${input.clientId}` : sql`1 = 1`,
              input.projectId !== undefined ? sql`project_id = ${input.projectId}` : sql`1 = 1`,
            ];
            const tasks = yield* sql<TaskRow>`SELECT * FROM bot_tasks WHERE ${sql.and(conditions)}`;
            if (tasks.length === 0) return [];
            const revision = yield* bumpRevision;
            for (const task of tasks) {
              const withdraw = task.pending_question_id !== null;
              yield* updateTask(task, revision, {
                status: "paused",
                epochDelta: 1,
                ...(withdraw ? { pendingQuestion: null } : {}),
                sequenceDelta: withdraw ? 2 : 1,
                at: input.at,
              });
              let sequence = task.next_sequence;
              const operationId = `fence:${revision}`;
              if (withdraw) {
                yield* appendActivity({
                  task,
                  revision,
                  type: "question-withdrawn",
                  actor: "operator",
                  content: null,
                  operationId,
                  questionId: task.pending_question_id,
                  at: input.at,
                  sequence,
                });
                sequence += 1;
              }
              yield* appendActivity({
                task,
                revision,
                type: "paused",
                actor: "operator",
                content: input.reason,
                operationId,
                at: input.at,
                sequence,
              });
            }
            return tasks.map((task) => task.id);
          }),
        )
        .pipe(wrap("fenceTasks")),

    clearSourceThread: (threadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
        }>`SELECT id FROM bot_tasks WHERE source_thread_id = ${threadId}`;
        if (rows.length === 0) return [];
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const revision = yield* bumpRevision;
            yield* sql`UPDATE bot_tasks SET source_thread_id = NULL, revision = ${revision}
              WHERE source_thread_id = ${threadId}`;
          }),
        );
        return rows.map((row) => row.id);
      }).pipe(wrap("clearSourceThread")),

    pruneProgress: (before) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM bot_task_activities
          WHERE type = 'progress' AND created_at < ${before}`;
        yield* sql`DELETE FROM bot_task_activities WHERE type = 'progress' AND created_at < ${before}`;
        return rows[0]?.n ?? 0;
      }).pipe(wrap("pruneProgress")),
  };
};
