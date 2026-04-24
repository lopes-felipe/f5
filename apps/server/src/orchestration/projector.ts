import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@t3tools/contracts";
import {
  CodeReviewWorkflow,
  PlanningWorkflow,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import {
  estimateModelContextWindowTokens,
  estimateContextTokensAfterMessageUpdate,
  estimateMessageContextCharacters,
  roughTokenEstimateFromCharacters,
} from "@t3tools/shared/model";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMemoryDeletedPayload,
  ProjectMemorySavedPayload,
  ProjectMemoryUpdatedPayload,
  ProjectSkillsReplacedPayload,
  ProjectWorkflowCreatedPayload,
  ProjectWorkflowDeletedPayload,
  ProjectWorkflowUpsertedPayload,
  ProjectCodeReviewWorkflowCreatedPayload,
  ProjectCodeReviewWorkflowDeletedPayload,
  ProjectCodeReviewWorkflowUpsertedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCompactedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadRevertedPayload,
  ThreadSessionNotesRecordedPayload,
  ThreadSessionSetPayload,
  ThreadTasksUpdatedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadUnarchivedPayload,
} from "./Schemas.ts";
import {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
} from "./readModelRetention.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function messageCharacters(
  message: Pick<OrchestrationMessage, "text" | "reasoningText" | "attachments">,
): number {
  return estimateMessageContextCharacters({
    text: message.text,
    reasoningText: message.reasoningText,
    attachmentNames: message.attachments?.map((attachment) => attachment.name),
  });
}

function totalMessageCharacters(messages: ReadonlyArray<OrchestrationMessage>): number {
  return messages.reduce((sum, message) => sum + messageCharacters(message), 0);
}

function threadProviderName(
  thread: Pick<OrchestrationThread, "session"> | null | undefined,
): "codex" | "claudeAgent" | undefined {
  const providerName = thread?.session?.providerName;
  return providerName === "codex" || providerName === "claudeAgent" ? providerName : undefined;
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModel: payload.defaultModel,
            scripts: payload.scripts,
            memories: [],
            skills: [],
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModel !== undefined
                    ? { defaultModel: payload.defaultModel }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "project.memory-saved":
      return decodeForEvent(ProjectMemorySavedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id !== payload.projectId
              ? project
              : {
                  ...project,
                  memories: project.memories.some((memory) => memory.id === payload.memory.id)
                    ? project.memories.map((memory) =>
                        memory.id === payload.memory.id ? payload.memory : memory,
                      )
                    : [...project.memories, payload.memory],
                  updatedAt: payload.memory.updatedAt,
                },
          ),
        })),
      );

    case "project.memory-updated":
      return decodeForEvent(ProjectMemoryUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id !== payload.projectId
              ? project
              : {
                  ...project,
                  memories: project.memories.some((memory) => memory.id === payload.memory.id)
                    ? project.memories.map((memory) =>
                        memory.id === payload.memory.id ? payload.memory : memory,
                      )
                    : [...project.memories, payload.memory],
                  updatedAt: payload.memory.updatedAt,
                },
          ),
        })),
      );

    case "project.memory-deleted":
      return decodeForEvent(ProjectMemoryDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id !== payload.projectId
              ? project
              : {
                  ...project,
                  memories: project.memories.map((memory) =>
                    memory.id === payload.memoryId
                      ? {
                          ...memory,
                          deletedAt: payload.deletedAt,
                          updatedAt: payload.deletedAt,
                        }
                      : memory,
                  ),
                  updatedAt: payload.deletedAt,
                },
          ),
        })),
      );

    case "project.skills-replaced":
      return decodeForEvent(
        ProjectSkillsReplacedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id !== payload.projectId
              ? project
              : {
                  ...project,
                  skills: payload.skills,
                  updatedAt: payload.updatedAt,
                },
          ),
        })),
      );

    case "project.workflow-created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ProjectWorkflowCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const workflow = yield* decodeForEvent(
          PlanningWorkflow,
          payload.workflow,
          event.type,
          "workflow",
        );
        const existing = nextBase.planningWorkflows.find((entry) => entry.id === workflow.id);
        return {
          ...nextBase,
          planningWorkflows: existing
            ? nextBase.planningWorkflows.map((entry) =>
                entry.id === workflow.id ? workflow : entry,
              )
            : [...nextBase.planningWorkflows, workflow],
        };
      });

    case "project.workflow-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ProjectWorkflowUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const workflow = yield* decodeForEvent(
          PlanningWorkflow,
          payload.workflow,
          event.type,
          "workflow",
        );
        return {
          ...nextBase,
          planningWorkflows: nextBase.planningWorkflows.some((entry) => entry.id === workflow.id)
            ? nextBase.planningWorkflows.map((entry) =>
                entry.id === workflow.id ? workflow : entry,
              )
            : [...nextBase.planningWorkflows, workflow],
        };
      });

    case "project.workflow-deleted":
      return decodeForEvent(
        ProjectWorkflowDeletedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          planningWorkflows: nextBase.planningWorkflows.map((workflow) =>
            workflow.id === payload.workflowId
              ? {
                  ...workflow,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : workflow,
          ),
        })),
      );

    case "project.code-review-workflow-created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ProjectCodeReviewWorkflowCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const workflow = yield* decodeForEvent(
          CodeReviewWorkflow,
          payload.workflow,
          event.type,
          "workflow",
        );
        const existing = nextBase.codeReviewWorkflows.find((entry) => entry.id === workflow.id);
        return {
          ...nextBase,
          codeReviewWorkflows: existing
            ? nextBase.codeReviewWorkflows.map((entry) =>
                entry.id === workflow.id ? workflow : entry,
              )
            : [...nextBase.codeReviewWorkflows, workflow],
        };
      });

    case "project.code-review-workflow-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ProjectCodeReviewWorkflowUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const workflow = yield* decodeForEvent(
          CodeReviewWorkflow,
          payload.workflow,
          event.type,
          "workflow",
        );
        return {
          ...nextBase,
          codeReviewWorkflows: nextBase.codeReviewWorkflows.some(
            (entry) => entry.id === workflow.id,
          )
            ? nextBase.codeReviewWorkflows.map((entry) =>
                entry.id === workflow.id ? workflow : entry,
              )
            : [...nextBase.codeReviewWorkflows, workflow],
        };
      });

    case "project.code-review-workflow-deleted":
      return decodeForEvent(
        ProjectCodeReviewWorkflowDeletedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          codeReviewWorkflows: nextBase.codeReviewWorkflows.map((workflow) =>
            workflow.id === payload.workflowId
              ? {
                  ...workflow,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : workflow,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            model: payload.model,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            archivedAt: null,
            createdAt: payload.createdAt,
            lastInteractionAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
            estimatedContextTokens: null,
            modelContextWindowTokens: estimateModelContextWindowTokens(payload.model),
            messages: [],
            proposedPlans: [],
            tasks: [],
            tasksTurnId: null,
            tasksUpdatedAt: null,
            compaction: null,
            sessionNotes: null,
            threadReferences: payload.threadReferences,
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const currentThread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(payload.title !== undefined ? { title: payload.title } : {}),
              ...(payload.model !== undefined ? { model: payload.model } : {}),
              ...(payload.model !== undefined
                ? {
                    modelContextWindowTokens: estimateModelContextWindowTokens(
                      payload.model,
                      threadProviderName(currentThread),
                    ),
                  }
                : {}),
              ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
              ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            updatedAt: event.occurredAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: event.occurredAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            reasoningText: payload.reasoningText ?? (payload.role === "assistant" ? "" : undefined),
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    reasoningText: message.streaming
                      ? `${entry.reasoningText ?? ""}${message.reasoningText ?? ""}`
                      : (message.reasoningText ?? "").length > 0
                        ? message.reasoningText
                        : entry.reasoningText,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);
        const nextMessage =
          cappedMessages.find((entry) => entry.id === message.id) ??
          thread.messages.find((entry) => entry.id === message.id) ??
          message;
        const shouldRecomputeFromMessages = thread.estimatedContextTokens === null;
        const estimatedContextTokens = shouldRecomputeFromMessages
          ? roughTokenEstimateFromCharacters(totalMessageCharacters(cappedMessages))
          : estimateContextTokensAfterMessageUpdate({
              previousEstimatedContextTokens: thread.estimatedContextTokens,
              previousMessageCharacters: existingMessage ? messageCharacters(existingMessage) : 0,
              nextMessageCharacters: messageCharacters(nextMessage),
            });
        const session =
          thread.session !== null && thread.session.tokenUsageSource !== "estimated"
            ? {
                ...thread.session,
                estimatedContextTokens,
                tokenUsageSource: "estimated" as const,
              }
            : thread.session !== null &&
                thread.session.estimatedContextTokens !== estimatedContextTokens
              ? {
                  ...thread.session,
                  estimatedContextTokens,
                }
              : thread.session;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            ...(session !== thread.session ? { session } : {}),
            estimatedContextTokens,
            lastInteractionAt: event.occurredAt,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.tasks.updated":
      return decodeForEvent(ThreadTasksUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            tasks: payload.tasks,
            tasksTurnId: payload.turnId,
            tasksUpdatedAt: payload.updatedAt,
            lastInteractionAt: payload.updatedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.compacted":
      return decodeForEvent(ThreadCompactedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          const session =
            thread?.session === null || thread?.session === undefined
              ? (thread?.session ?? null)
              : {
                  ...thread.session,
                  estimatedContextTokens: payload.compaction.estimatedTokens,
                  tokenUsageSource: "estimated" as const,
                };
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              compaction: payload.compaction,
              ...(session !== thread?.session ? { session } : {}),
              estimatedContextTokens: payload.compaction.estimatedTokens,
              lastInteractionAt: event.occurredAt,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.session-notes-recorded":
      return decodeForEvent(
        ThreadSessionNotesRecordedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            sessionNotes: payload.sessionNotes,
            updatedAt: event.occurredAt,
          }),
        })),
      );

    case "thread.turn-interrupt-requested":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.session-stop-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.compact-requested":
      return Effect.succeed({
        ...nextBase,
        threads: updateThread(nextBase.threads, event.payload.threadId, {
          lastInteractionAt: event.occurredAt,
          updatedAt: event.occurredAt,
        }),
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );
        const nextSession: OrchestrationSession = {
          ...session,
          ...(session.estimatedContextTokens === undefined &&
          thread.session?.estimatedContextTokens !== undefined
            ? { estimatedContextTokens: thread.session.estimatedContextTokens }
            : {}),
          ...(session.modelContextWindowTokens === undefined &&
          thread.session?.modelContextWindowTokens !== undefined
            ? { modelContextWindowTokens: thread.session.modelContextWindowTokens }
            : {}),
          ...(session.tokenUsageSource === undefined &&
          thread.session?.tokenUsageSource !== undefined
            ? { tokenUsageSource: thread.session.tokenUsageSource }
            : {}),
        };

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session: nextSession,
            estimatedContextTokens:
              nextSession.estimatedContextTokens ?? thread.estimatedContextTokens ?? null,
            modelContextWindowTokens:
              nextSession.modelContextWindowTokens ?? thread.modelContextWindowTokens ?? null,
            latestTurn:
              nextSession.status === "running" && nextSession.activeTurnId !== null
                ? {
                    turnId: nextSession.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === nextSession.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : nextSession.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === nextSession.activeTurnId
                        ? (thread.latestTurn.startedAt ?? nextSession.updatedAt)
                        : nextSession.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === nextSession.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            lastInteractionAt: event.occurredAt,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);
        const shouldPreserveRunningLatestTurn =
          thread.latestTurn?.turnId === payload.turnId && thread.latestTurn.state === "running";
        const nextLatestTurn = shouldPreserveRunningLatestTurn
          ? {
              ...thread.latestTurn,
              assistantMessageId:
                payload.assistantMessageId ?? thread.latestTurn.assistantMessageId,
            }
          : {
              turnId: payload.turnId,
              state: checkpointStatusToLatestTurnState(payload.status),
              requestedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? thread.latestTurn.requestedAt
                  : payload.completedAt,
              startedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? (thread.latestTurn.startedAt ?? payload.completedAt)
                  : payload.completedAt,
              completedAt: payload.completedAt,
              assistantMessageId: payload.assistantMessageId,
            };

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: nextLatestTurn,
            lastInteractionAt: event.occurredAt,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };
          const session =
            thread.session === null
              ? null
              : {
                  ...thread.session,
                  estimatedContextTokens: undefined,
                  tokenUsageSource: undefined,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              // TodoWrite tasks are stored as the latest runtime snapshot.
              // Revert clears them so discarded-turn tasks do not remain visible.
              tasks: [],
              tasksTurnId: null,
              tasksUpdatedAt: null,
              compaction: null,
              ...(session !== thread.session ? { session } : {}),
              estimatedContextTokens: null,
              activities,
              latestTurn,
              lastInteractionAt: event.occurredAt,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-MAX_THREAD_ACTIVITIES);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              lastInteractionAt: event.occurredAt,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.command-execution-recorded":
      return Effect.succeed(nextBase);

    case "thread.command-execution-output-appended":
      return Effect.succeed(nextBase);

    case "thread.file-change-recorded":
      return Effect.succeed(nextBase);

    default:
      return Effect.succeed(nextBase);
  }
}
