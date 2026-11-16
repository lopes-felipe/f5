/**
 * Operator (F5 UI) side of the task board: create tasks, reply to questions,
 * and pause, resume, or cancel. Operator writes use the `operator` receipt
 * namespace, so a retried UI request with the same operation id is idempotent.
 *
 * @module agentBridge/taskOperator
 */
import {
  BOT_TASK_PROGRESS_RETENTION_DAYS,
  ProjectId,
  ThreadId,
  type AgentBridgeCreateTaskInput,
  type AgentBridgeGetTaskActivitiesInput,
  type AgentBridgeGetTaskActivitiesResult,
  type AgentBridgeGetTasksInput,
  type AgentBridgeGetTasksResult,
  type AgentBridgeReplyToTaskInput,
  type AgentBridgeSettings,
  type AgentBridgeTaskControlInput,
  type BotTask,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { AgentBridgeHostShape } from "./AgentBridgeHost.ts";
import type { AgentBridgeClientRecord, AgentBridgeStore } from "./AgentBridgeStore.ts";
import {
  BotTaskError,
  OPERATOR_NAMESPACE,
  type BotTaskRecord,
  type BotTaskStore,
  type MutationOutcome,
} from "./BotTaskStore.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TaskOperatorShape {
  readonly getTasks: (
    input: AgentBridgeGetTasksInput,
  ) => Effect.Effect<AgentBridgeGetTasksResult, BotTaskError>;
  readonly getTask: (taskId: string) => Effect.Effect<BotTask, BotTaskError>;
  readonly getTaskActivities: (
    input: AgentBridgeGetTaskActivitiesInput,
  ) => Effect.Effect<AgentBridgeGetTaskActivitiesResult, BotTaskError>;
  readonly createTask: (input: AgentBridgeCreateTaskInput) => Effect.Effect<BotTask, BotTaskError>;
  readonly replyToTask: (
    input: AgentBridgeReplyToTaskInput,
  ) => Effect.Effect<BotTask, BotTaskError>;
  readonly controlTask: (
    action: "pause" | "resume" | "cancel",
    input: AgentBridgeTaskControlInput,
  ) => Effect.Effect<BotTask, BotTaskError>;
}

export const progressRetentionBoundary = (now: Date) =>
  new Date(now.getTime() - BOT_TASK_PROGRESS_RETENTION_DAYS * DAY_MS).toISOString();

export function makeTaskOperator(deps: {
  readonly host: AgentBridgeHostShape;
  readonly store: AgentBridgeStore;
  readonly tasks: BotTaskStore;
  readonly settings: () => AgentBridgeSettings;
  readonly visibleProjectIds: (client: AgentBridgeClientRecord) => ReadonlySet<string>;
  readonly onWorkspaceChanged: (revision: number, affectedIds: ReadonlyArray<string>) => void;
  readonly mintId?: () => string;
  readonly now?: () => Date;
}): TaskOperatorShape {
  const { host, store, tasks } = deps;
  const mintId = deps.mintId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());
  const fail = (code: BotTaskError["code"], message: string) =>
    Effect.fail(new BotTaskError({ code, message }));

  const clientNames = store.listClients.pipe(
    Effect.map((clients) => new Map(clients.map((client) => [client.id, client.name]))),
    Effect.orElseSucceed(() => new Map<string, string>()),
  );

  const toBotTask = (task: BotTaskRecord, names: ReadonlyMap<string, string>): BotTask => ({
    ...task,
    clientName: names.get(task.clientId) ?? task.clientId,
    projectId: ProjectId.makeUnsafe(task.projectId),
    sourceThreadId: task.sourceThreadId === null ? null : ThreadId.makeUnsafe(task.sourceThreadId),
  });

  const readTask = (taskId: string) =>
    Effect.gen(function* () {
      const task = yield* tasks.getTask(taskId);
      if (!task) return yield* fail("not-found", "Task not found.");
      return toBotTask(task, yield* clientNames);
    });

  /** A client that is not revoked and still sees the project. */
  const clientCanWork =
    (clients: ReadonlyArray<AgentBridgeClientRecord>, projectId: string) => (clientId: string) => {
      const client = clients.find((candidate) => candidate.id === clientId);
      return (
        client !== undefined &&
        client.revokedAt === null &&
        client.scopes.includes("f5.tasks") &&
        deps.visibleProjectIds(client).has(projectId)
      );
    };

  const afterWrite = <A extends { readonly taskId: string }>(outcome: MutationOutcome<A>) =>
    Effect.gen(function* () {
      if (!outcome.replayed) deps.onWorkspaceChanged(outcome.revision, [outcome.taskId]);
      return yield* readTask(outcome.taskId);
    });

  const listClients = store.listClients.pipe(
    Effect.mapError(
      () => new BotTaskError({ code: "storage", message: "Could not read clients." }),
    ),
  );

  return {
    getTasks: (input) =>
      Effect.gen(function* () {
        const page = yield* tasks.listTasks({
          clientId: input.clientId,
          statuses: input.statuses,
          cursor: input.cursor,
          limit: input.limit,
        });
        const names = yield* clientNames;
        const revision = yield* store.getRevision.pipe(Effect.orElseSucceed(() => 0));
        return {
          revision,
          tasks: page.tasks.map((task) => toBotTask(task, names)),
          nextCursor: page.nextCursor,
        };
      }),

    getTask: readTask,

    getTaskActivities: (input) =>
      Effect.gen(function* () {
        const page = yield* tasks.listActivities({
          taskId: input.taskId,
          beforeSequence: input.beforeSequence,
          limit: input.limit ?? 100,
        });
        return { ...page, progressPrunedBefore: progressRetentionBoundary(now()) };
      }),

    createTask: (input) =>
      Effect.gen(function* () {
        const { operationId, ...args } = input;
        const identity = { namespace: OPERATOR_NAMESPACE, operationId, tool: "createTask", args };
        // A retry of a stored create skips the checks below and replays the receipt.
        if (!(yield* tasks.hasReceipt(OPERATOR_NAMESPACE, input.operationId))) {
          const clients = yield* listClients;
          if (!clientCanWork(clients, input.projectId)(input.clientId))
            return yield* fail(
              "invalid-state",
              "That client is revoked, lacks task access, or cannot see this project. Share the project in Agent Bridge settings first.",
            );
          const model = yield* host.readSnapshot.pipe(
            Effect.mapError(
              (error) => new BotTaskError({ code: "storage", message: error.message }),
            ),
          );
          if (!model.projects.some((p) => p.id === input.projectId && p.deletedAt === null))
            return yield* fail("not-found", "Project not found.");
          if (
            input.sourceThreadId !== undefined &&
            !model.threads.some(
              (thread) =>
                thread.id === input.sourceThreadId &&
                thread.projectId === input.projectId &&
                thread.deletedAt === null,
            )
          )
            return yield* fail("not-found", "Source thread not found in this project.");
        }
        const outcome = yield* tasks.create(identity, {
          clientId: input.clientId,
          projectId: input.projectId,
          sourceThreadId: input.sourceThreadId ?? null,
          title: input.title.trim(),
          instructions: input.instructions,
          taskId: mintId(),
          at: now().toISOString(),
        });
        return yield* afterWrite(outcome);
      }),

    replyToTask: (input) =>
      Effect.gen(function* () {
        const { operationId, ...args } = input;
        const outcome = yield* tasks.reply(
          { namespace: OPERATOR_NAMESPACE, operationId, tool: "replyToTask", args },
          {
            taskId: input.taskId,
            questionId: input.questionId,
            expectedVersion: input.expectedVersion,
            text: input.text,
            at: now().toISOString(),
          },
        );
        return yield* afterWrite(outcome);
      }),

    controlTask: (action, input) =>
      Effect.gen(function* () {
        const { operationId, ...args } = input;
        const task = yield* tasks.getTask(input.taskId);
        if (!task) return yield* fail("not-found", "Task not found.");
        const clients = action === "resume" ? yield* listClients : [];
        if (action === "resume") {
          const model = yield* host.readSnapshot.pipe(
            Effect.mapError(
              (error) => new BotTaskError({ code: "storage", message: error.message }),
            ),
          );
          if (!model.projects.some((p) => p.id === task.projectId && p.deletedAt === null))
            return yield* fail("invalid-state", "The task's project was deleted.");
        }
        const outcome = yield* tasks.control(
          { namespace: OPERATOR_NAMESPACE, operationId, tool: `${action}Task`, args },
          {
            taskId: input.taskId,
            action,
            expectedVersion: input.expectedVersion,
            clientIsValid: clientCanWork(clients, task.projectId),
            at: now().toISOString(),
          },
        );
        return yield* afterWrite(outcome);
      }),
  };
}
