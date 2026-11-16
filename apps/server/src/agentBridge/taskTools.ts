/**
 * Agent Bridge task tools: an agent lists the tasks an F5 user assigned to it,
 * claims one, reports progress, asks questions, and finishes it.
 *
 * Task payloads carry only what the user typed, project display names, and bot
 * activity — never workspace paths, repository contents, transcripts, or settings.
 *
 * @module agentBridge/taskTools
 */
import {
  BOT_TASK_CONTENT_MAX_BYTES,
  BOT_TASK_STATUSES,
  BOT_TASK_SUMMARY_MAX_BYTES,
  type BotTaskActivity,
} from "@t3tools/contracts";
import { Effect, Schema, SchemaIssue } from "effect";

import type { AgentBridgeHostShape } from "./AgentBridgeHost.ts";
import {
  BotTaskError,
  type BotTaskRecord,
  type BotTaskStore,
  type ClientFence,
  type MutationIdentity,
} from "./BotTaskStore.ts";
import type { AgentBridgeLimiters } from "./rateLimits.ts";
import {
  AgentBridgeToolError,
  type AgentBridgeCaller,
  type AgentBridgeToolDefinition,
} from "./threadTools.ts";

const WORKSPACE_NOTE =
  "F5 is a coding-workspace service. Tasks are assigned by the F5 user; this tool does not control your computer.";
const HISTORY_LIMIT = 50;

export interface TaskToolsDeps {
  readonly host: AgentBridgeHostShape;
  readonly tasks: BotTaskStore;
  readonly limiters: AgentBridgeLimiters;
  readonly mintId?: () => string;
  readonly now?: () => Date;
  readonly onWorkspaceChanged?: (revision: number, affectedIds: ReadonlyArray<string>) => void;
}

const toolError = (message: string, retryAfterSeconds?: number) =>
  new AgentBridgeToolError({
    message,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });

export const fromTaskError = (error: BotTaskError) =>
  toolError(error.message, error.retryAfterSeconds);

const decodeArgs =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (args: unknown): Effect.Effect<S["Type"], AgentBridgeToolError> =>
    Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
      Effect.mapError((error) =>
        toolError(`Invalid arguments: ${SchemaIssue.makeFormatterDefault()(error.issue)}`),
      ),
    );

const maxBytes = (limit: number) =>
  Schema.makeFilter(
    (value: string) =>
      Buffer.byteLength(value, "utf8") <= limit || `Limited to ${Math.round(limit / 1024)} KB.`,
  );
const Content = Schema.String.check(Schema.isMinLength(1), maxBytes(BOT_TASK_CONTENT_MAX_BYTES));
const Summary = Schema.String.check(Schema.isMinLength(1), maxBytes(BOT_TASK_SUMMARY_MAX_BYTES));
const OperationId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/u),
);
const Epoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const ListTasksArgs = Schema.Struct({
  statuses: Schema.optional(Schema.Array(Schema.Literals(BOT_TASK_STATUSES))),
  cursor: Schema.optional(Schema.String),
});
const TaskArgs = Schema.Struct({ taskId: Schema.String });
const ClaimArgs = Schema.Struct({ taskId: Schema.String, operationId: OperationId });
const ProgressArgs = Schema.Struct({
  taskId: Schema.String,
  executionEpoch: Epoch,
  operationId: OperationId,
  summary: Summary,
  detail: Schema.optional(Content),
});
const QuestionArgs = Schema.Struct({
  taskId: Schema.String,
  executionEpoch: Epoch,
  operationId: OperationId,
  question: Content,
});
const CompleteArgs = Schema.Struct({
  taskId: Schema.String,
  executionEpoch: Epoch,
  operationId: OperationId,
  result: Content,
});
const FailArgs = Schema.Struct({
  taskId: Schema.String,
  executionEpoch: Epoch,
  operationId: OperationId,
  reason: Content,
});

const prop = (type: string, description: string, extra: Record<string, unknown> = {}) => ({
  type,
  description,
  ...extra,
});
const objectSchema = (
  properties: Record<string, unknown>,
  required: ReadonlyArray<string> = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});
const TASK_ID_PROP = prop("string", "The task id.");
const EPOCH_PROP = prop(
  "integer",
  "The task's current executionEpoch from claim_task or get_task. Writes with an old epoch are rejected.",
  { minimum: 0 },
);
const OPERATION_ID_PROP = prop(
  "string",
  "Idempotency key for this write. Retrying with the same key returns the original result; reusing it with different arguments fails.",
  { minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
);

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const writes = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function makeTaskTools(deps: TaskToolsDeps): ReadonlyArray<AgentBridgeToolDefinition> {
  const { host, tasks, limiters } = deps;
  const mintId = deps.mintId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());
  const taskError = Effect.mapError(fromTaskError);

  const projectNames = host.readSnapshot.pipe(
    Effect.map(
      (model) =>
        new Map(
          model.projects
            .filter((project) => project.deletedAt === null)
            .map((project) => [project.id as string, project.title]),
        ),
    ),
    Effect.orElseSucceed(() => new Map<string, string>()),
  );

  const fenceOf = (caller: AgentBridgeCaller): ClientFence => ({
    clientId: caller.client.id,
    grantGeneration: caller.client.grantGeneration,
  });

  /** The caller's task in a project that still exists and is still shared with it. */
  const requireTask = (caller: AgentBridgeCaller, taskId: string) =>
    Effect.gen(function* () {
      const task = yield* tasks.getTask(taskId).pipe(taskError);
      const live = yield* projectNames;
      if (
        !task ||
        task.clientId !== caller.client.id ||
        !caller.visibleProjectIds.has(task.projectId) ||
        !live.has(task.projectId)
      )
        return yield* toolError("Task not found.");
      return task;
    });

  const summarize = (task: BotTaskRecord, names: ReadonlyMap<string, string>) => ({
    taskId: task.id,
    title: task.title,
    project: names.get(task.projectId) ?? "Unknown project",
    status: task.status,
    executionEpoch: task.executionEpoch,
    latestProgress: task.latestProgress,
    pendingQuestion: task.pendingQuestion,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });

  /** Rate limits run before admission; an identical retry of a stored write is free. */
  const write = <A extends { readonly taskId: string }>(
    caller: AgentBridgeCaller,
    identity: MutationIdentity,
    run: Effect.Effect<
      { readonly result: A; readonly replayed: boolean; readonly revision: number },
      BotTaskError
    >,
  ) =>
    Effect.gen(function* () {
      const stored = yield* tasks
        .hasReceipt(identity.namespace, identity.operationId)
        .pipe(taskError);
      if (!stored) {
        const rejected = limiters.taskWrites.take(caller.client.id);
        if (rejected)
          return yield* toolError(
            "Task writes are limited to 1 per second (burst 10).",
            rejected.retryAfterSeconds,
          );
      }
      const outcome = yield* run.pipe(taskError);
      if (!outcome.replayed)
        yield* Effect.sync(() =>
          deps.onWorkspaceChanged?.(outcome.revision, [outcome.result.taskId, caller.client.id]),
        );
      return outcome.result;
    });

  const identity = (
    caller: AgentBridgeCaller,
    tool: string,
    input: { readonly operationId: string } & Record<string, unknown>,
  ): MutationIdentity => {
    const { operationId, ...args } = input;
    return { namespace: caller.client.id, operationId, tool, args };
  };

  const listTasks: AgentBridgeToolDefinition = {
    name: "list_tasks",
    title: "List tasks",
    description: `List tasks the F5 user assigned to you, newest first (50 per page). Claim a queued task with claim_task before working on it. ${WORKSPACE_NOTE}`,
    scope: "f5.tasks",
    inputSchema: objectSchema({
      statuses: prop("array", "Only tasks in these statuses.", {
        items: { type: "string", enum: [...BOT_TASK_STATUSES] },
      }),
      cursor: prop("string", "nextCursor from the previous page."),
    }),
    annotations: readOnly,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(ListTasksArgs)(args);
        const names = yield* projectNames;
        const page = yield* tasks
          .listTasks({
            clientId: caller.client.id,
            projectIds: new Set([...caller.visibleProjectIds].filter((id) => names.has(id))),
            statuses: input.statuses,
            cursor: input.cursor,
          })
          .pipe(taskError);
        return {
          tasks: page.tasks.map((task) => summarize(task, names)),
          nextCursor: page.nextCursor,
        };
      }),
  };

  const historyEntry = (activity: BotTaskActivity) => ({
    sequence: activity.sequence,
    type: activity.type,
    actor: activity.actor === "bot" ? "you" : "user",
    content: activity.content,
    questionId: activity.questionId,
    at: activity.createdAt,
  });

  const getTask: AgentBridgeToolDefinition = {
    name: "get_task",
    title: "Get task",
    description: `Read a task: its instructions, the user's replies, progress, any open question, and the result. ${WORKSPACE_NOTE}`,
    scope: "f5.tasks",
    inputSchema: objectSchema({ taskId: TASK_ID_PROP }, ["taskId"]),
    annotations: readOnly,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(TaskArgs)(args);
        const task = yield* requireTask(caller, input.taskId);
        const history = yield* tasks
          .listActivities({
            taskId: task.id,
            limit: HISTORY_LIMIT,
            types: [
              "question",
              "reply",
              "question-withdrawn",
              "paused",
              "resumed",
              "cancelled",
              "completed",
              "failed",
            ],
          })
          .pipe(taskError);
        yield* tasks.touchContact(task.id, now().toISOString()).pipe(Effect.ignore);
        const names = yield* projectNames;
        return {
          ...summarize(task, names),
          instructions: task.instructions,
          result: task.result,
          failure: task.failure,
          history: history.activities.toReversed().map(historyEntry),
          olderHistory: history.hasOlder,
        };
      }),
  };

  const claimTask: AgentBridgeToolDefinition = {
    name: "claim_task",
    title: "Claim task",
    description: `Start a queued task. Returns the executionEpoch that every later write for this task must carry. ${WORKSPACE_NOTE}`,
    scope: "f5.tasks",
    inputSchema: objectSchema({ taskId: TASK_ID_PROP, operationId: OPERATION_ID_PROP }, [
      "taskId",
      "operationId",
    ]),
    annotations: writes,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(ClaimArgs)(args);
        yield* requireTask(caller, input.taskId);
        const id = identity(caller, "claim_task", input);
        return yield* write(
          caller,
          id,
          tasks.claim(id, {
            taskId: input.taskId,
            fence: fenceOf(caller),
            at: now().toISOString(),
          }),
        );
      }),
  };

  const reportProgress: AgentBridgeToolDefinition = {
    name: "report_task_progress",
    title: "Report task progress",
    description: `Report progress on a running task (at most once every 5 seconds). The summary is shown to the user. ${WORKSPACE_NOTE}`,
    scope: "f5.tasks",
    inputSchema: objectSchema(
      {
        taskId: TASK_ID_PROP,
        executionEpoch: EPOCH_PROP,
        operationId: OPERATION_ID_PROP,
        summary: prop("string", "Short progress summary, up to 1 KB.", { minLength: 1 }),
        detail: prop("string", "Optional detail, up to 32 KB.", { minLength: 1 }),
      },
      ["taskId", "executionEpoch", "operationId", "summary"],
    ),
    annotations: writes,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(ProgressArgs)(args);
        yield* requireTask(caller, input.taskId);
        const id = identity(caller, "report_task_progress", input);
        return yield* write(
          caller,
          id,
          tasks.reportProgress(id, {
            taskId: input.taskId,
            fence: fenceOf(caller),
            executionEpoch: input.executionEpoch,
            summary: input.summary,
            detail: input.detail ?? null,
            at: now().toISOString(),
          }),
        );
      }),
  };

  const requestInput: AgentBridgeToolDefinition = {
    name: "request_task_input",
    title: "Ask the user",
    description: `Ask the F5 user a question about a running task. The task waits until they reply; read the reply with get_task. A reply is never approval for purchases, messages, or account changes. ${WORKSPACE_NOTE}`,
    scope: "f5.tasks",
    inputSchema: objectSchema(
      {
        taskId: TASK_ID_PROP,
        executionEpoch: EPOCH_PROP,
        operationId: OPERATION_ID_PROP,
        question: prop("string", "The question, up to 32 KB.", { minLength: 1 }),
      },
      ["taskId", "executionEpoch", "operationId", "question"],
    ),
    annotations: writes,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(QuestionArgs)(args);
        yield* requireTask(caller, input.taskId);
        const id = identity(caller, "request_task_input", input);
        return yield* write(
          caller,
          id,
          tasks.requestInput(id, {
            taskId: input.taskId,
            fence: fenceOf(caller),
            executionEpoch: input.executionEpoch,
            question: input.question,
            questionId: mintId(),
            at: now().toISOString(),
          }),
        );
      }),
  };

  const finishTool = (
    name: "complete_task" | "fail_task",
    outcome: "completed" | "failed",
  ): AgentBridgeToolDefinition => ({
    name,
    title: outcome === "completed" ? "Complete task" : "Fail task",
    description:
      outcome === "completed"
        ? `Finish a running task with its result. Finished tasks cannot change. ${WORKSPACE_NOTE}`
        : `Finish a running task as failed, explaining why. Finished tasks cannot change. ${WORKSPACE_NOTE}`,
    scope: "f5.tasks",
    inputSchema: objectSchema(
      {
        taskId: TASK_ID_PROP,
        executionEpoch: EPOCH_PROP,
        operationId: OPERATION_ID_PROP,
        ...(outcome === "completed"
          ? { result: prop("string", "The result, up to 32 KB.", { minLength: 1 }) }
          : { reason: prop("string", "What went wrong, up to 32 KB.", { minLength: 1 }) }),
      },
      ["taskId", "executionEpoch", "operationId", outcome === "completed" ? "result" : "reason"],
    ),
    annotations: writes,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input =
          outcome === "completed"
            ? yield* decodeArgs(CompleteArgs)(args).pipe(
                Effect.map((value) => ({ ...value, text: value.result })),
              )
            : yield* decodeArgs(FailArgs)(args).pipe(
                Effect.map((value) => ({ ...value, text: value.reason })),
              );
        yield* requireTask(caller, input.taskId);
        const id = identity(caller, name, input);
        return yield* write(
          caller,
          id,
          tasks.finish(id, {
            taskId: input.taskId,
            fence: fenceOf(caller),
            executionEpoch: input.executionEpoch,
            outcome,
            text: input.text,
            at: now().toISOString(),
          }),
        );
      }),
  });

  return [
    listTasks,
    getTask,
    claimTask,
    reportProgress,
    requestInput,
    finishTool("complete_task", "completed"),
    finishTool("fail_task", "failed"),
  ];
}
