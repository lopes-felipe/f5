import {
  ApprovalRequestId,
  type ChatAttachment,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  estimateModelContextWindowTokens,
  estimateContextTokensAfterMessageUpdate,
  estimateMessageContextCharacters,
  roughTokenEstimateFromCharacters,
} from "@t3tools/shared/model";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionCodeReviewWorkflowRepository } from "../../persistence/Services/ProjectionCodeReviewWorkflows.ts";
import { ProjectionPlanningWorkflowRepository } from "../../persistence/Services/ProjectionPlanningWorkflows.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectMemoryRepository } from "../../persistence/Services/ProjectionProjectMemories.ts";
import { ProjectionProjectSkillRepository } from "../../persistence/Services/ProjectionProjectSkills.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadCommandExecutionRepository } from "../../persistence/Services/ProjectionThreadCommandExecutions.ts";
import { ProjectionThreadFileChangeRepository } from "../../persistence/Services/ProjectionThreadFileChanges.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionCodeReviewWorkflowRepositoryLive } from "../../persistence/Layers/ProjectionCodeReviewWorkflows.ts";
import { ProjectionPlanningWorkflowRepositoryLive } from "../../persistence/Layers/ProjectionPlanningWorkflows.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectMemoryRepositoryLive } from "../../persistence/Layers/ProjectionProjectMemories.ts";
import { ProjectionProjectSkillRepositoryLive } from "../../persistence/Layers/ProjectionProjectSkills.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadCommandExecutionRepositoryLive } from "../../persistence/Layers/ProjectionThreadCommandExecutions.ts";
import { ProjectionThreadFileChangeRepositoryLive } from "../../persistence/Layers/ProjectionThreadFileChanges.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  projectMemories: "projection.project-memories",
  projectSkills: "projection.project-skills",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadCommandExecutions: "projection.thread-command-executions",
  threadFileChanges: "projection.thread-file-changes",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
  planningWorkflows: "projection.planning-workflows",
  codeReviewWorkflows: "projection.code-review-workflows",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const MAX_COMMAND_TRANSCRIPT_BYTES = 256 * 1024;
const COMMAND_TRANSCRIPT_HEAD_BYTES = 96 * 1024;
const COMMAND_TRANSCRIPT_TRUNCATION_MARKER =
  "\n\n[... transcript truncated; middle output omitted ...]\n\n";

const materializeAttachmentsForProjection = Effect.fn(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.makeUnsafe(requestId) : null;
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function projectionMessageCharacters(
  message:
    | Pick<ProjectionThreadMessage, "text" | "reasoningText" | "attachments">
    | {
        readonly text: string;
        readonly reasoningText?: string | undefined;
        readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
      },
): number {
  return estimateMessageContextCharacters({
    text: message.text,
    reasoningText: message.reasoningText,
    attachmentNames: message.attachments?.map((attachment) => attachment.name),
  });
}

function resolveProjectedMessageState(
  existingMessage: ProjectionThreadMessage | undefined,
  payload: Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"],
): {
  readonly text: string;
  readonly reasoningText?: string | undefined;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
} {
  const text =
    existingMessage && payload.streaming
      ? `${existingMessage.text}${payload.text}`
      : existingMessage && payload.text.length === 0
        ? existingMessage.text
        : payload.text;
  const reasoningText =
    payload.reasoningText !== undefined
      ? existingMessage && payload.streaming
        ? `${existingMessage.reasoningText ?? ""}${payload.reasoningText}`
        : existingMessage && payload.reasoningText.length === 0
          ? existingMessage.reasoningText
          : payload.reasoningText
      : existingMessage?.reasoningText;
  const attachments = payload.attachments ?? existingMessage?.attachments;

  return {
    text,
    ...(reasoningText !== undefined ? { reasoningText } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
}

function previousProjectedMessageCharacters(
  currentMessage: ProjectionThreadMessage | undefined,
  payload: Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"],
): number {
  if (!currentMessage) {
    return 0;
  }

  if (!payload.streaming && (payload.role === "user" || payload.createdAt === payload.updatedAt)) {
    return 0;
  }

  if (!payload.streaming) {
    return projectionMessageCharacters(currentMessage);
  }

  const currentReasoningText = currentMessage.reasoningText ?? "";
  const previousText = currentMessage.text.endsWith(payload.text)
    ? currentMessage.text.slice(0, Math.max(0, currentMessage.text.length - payload.text.length))
    : currentMessage.text;
  const previousReasoningText =
    payload.reasoningText !== undefined && currentReasoningText.endsWith(payload.reasoningText)
      ? currentReasoningText.slice(
          0,
          Math.max(0, currentReasoningText.length - payload.reasoningText.length),
        )
      : currentMessage.reasoningText;

  return estimateMessageContextCharacters({
    text: previousText,
    reasoningText: previousReasoningText,
    attachmentNames: currentMessage.attachments?.map((attachment) => attachment.name),
  });
}

function estimateThreadContextTokensForMessageEvent(input: {
  readonly currentMessages: ReadonlyArray<ProjectionThreadMessage>;
  readonly payload: Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"];
  readonly estimatedContextTokens: number | null;
}): number {
  const currentMessage = input.currentMessages.find(
    (message) => message.messageId === input.payload.messageId,
  );
  const shouldRecomputeFromMessages = input.estimatedContextTokens === null;

  if (shouldRecomputeFromMessages) {
    return roughTokenEstimateFromCharacters(
      input.currentMessages.reduce((sum, message) => sum + projectionMessageCharacters(message), 0),
    );
  }

  return estimateContextTokensAfterMessageUpdate({
    previousEstimatedContextTokens: input.estimatedContextTokens,
    previousMessageCharacters: previousProjectedMessageCharacters(currentMessage, input.payload),
    nextMessageCharacters: currentMessage ? projectionMessageCharacters(currentMessage) : 0,
  });
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

function truncateCommandTranscriptOutput(output: string): {
  output: string;
  outputTruncated: boolean;
} {
  if (Buffer.byteLength(output, "utf8") <= MAX_COMMAND_TRANSCRIPT_BYTES) {
    return { output, outputTruncated: false };
  }

  const markerBytes = Buffer.byteLength(COMMAND_TRANSCRIPT_TRUNCATION_MARKER, "utf8");
  const headBytes = Math.min(COMMAND_TRANSCRIPT_HEAD_BYTES, MAX_COMMAND_TRANSCRIPT_BYTES);
  const tailBytes = Math.max(0, MAX_COMMAND_TRANSCRIPT_BYTES - headBytes - markerBytes);
  const outputBuffer = Buffer.from(output, "utf8");
  const head = outputBuffer
    .subarray(0, headBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/g, "");
  const tail =
    tailBytes > 0
      ? outputBuffer
          .subarray(outputBuffer.length - tailBytes)
          .toString("utf8")
          .replace(/^\uFFFD+/g, "")
      : "";

  return {
    output: `${head}${COMMAND_TRANSCRIPT_TRUNCATION_MARKER}${tail}`,
    outputTruncated: true,
  };
}

const runAttachmentSideEffects = Effect.fn(function* (sideEffects: AttachmentSideEffects) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;

  yield* Effect.forEach(
    sideEffects.deletedThreadIds,
    (threadId) =>
      Effect.gen(function* () {
        const threadSegment = toSafeThreadAttachmentSegment(threadId);
        if (!threadSegment) {
          yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
            threadId,
          });
          return;
        }
        const entries = yield* fileSystem
          .readDirectory(attachmentsRootDir, { recursive: false })
          .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
        yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
              if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
                return;
              }
              const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
              if (!attachmentId) {
                return;
              }
              const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
              if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
                return;
              }
              yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
                force: true,
              });
            }),
          { concurrency: 1 },
        );
      }),
    { concurrency: 1 },
  );

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) => {
      if (sideEffects.deletedThreadIds.has(threadId)) {
        return Effect.void;
      }
      return Effect.gen(function* () {
        const threadSegment = toSafeThreadAttachmentSegment(threadId);
        if (!threadSegment) {
          yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
          return;
        }
        const entries = yield* fileSystem
          .readDirectory(attachmentsRootDir, { recursive: false })
          .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
        yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
              if (relativePath.length === 0 || relativePath.includes("/")) {
                return;
              }
              const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
              if (!attachmentId) {
                return;
              }
              const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
              if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
                return;
              }

              const absolutePath = path.join(attachmentsRootDir, relativePath);
              const fileInfo = yield* fileSystem
                .stat(absolutePath)
                .pipe(Effect.catch(() => Effect.succeed(null)));
              if (!fileInfo || fileInfo.type !== "File") {
                return;
              }

              if (!keptThreadRelativePaths.has(relativePath)) {
                yield* fileSystem.remove(absolutePath, { force: true });
              }
            }),
          { concurrency: 1 },
        );
      });
    },
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const projectionProjectRepository = yield* ProjectionProjectRepository;
  const projectionProjectMemoryRepository = yield* ProjectionProjectMemoryRepository;
  const projectionProjectSkillRepository = yield* ProjectionProjectSkillRepository;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const projectionThreadCommandExecutionRepository =
    yield* ProjectionThreadCommandExecutionRepository;
  const projectionThreadFileChangeRepository = yield* ProjectionThreadFileChangeRepository;
  const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
  const projectionPlanningWorkflowRepository = yield* ProjectionPlanningWorkflowRepository;
  const projectionCodeReviewWorkflowRepository = yield* ProjectionCodeReviewWorkflowRepository;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  const applyProjectsProjection: ProjectorDefinition["apply"] = (event, _attachmentSideEffects) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModel: event.payload.defaultModel,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModel !== undefined
              ? { defaultModel: event.payload.defaultModel }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

  const applyPlanningWorkflowsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "project.workflow-created":
        case "project.workflow-upserted":
          yield* projectionPlanningWorkflowRepository.upsert(event.payload.workflow);
          return;

        case "project.workflow-deleted":
          yield* projectionPlanningWorkflowRepository.deleteById({
            workflowId: event.payload.workflowId,
            deletedAt: event.payload.deletedAt,
          });
          return;

        default:
          return;
      }
    });

  const applyProjectMemoriesProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "project.memory-saved":
        case "project.memory-updated":
          yield* projectionProjectMemoryRepository.upsert({
            memoryId: event.payload.memory.id,
            projectId: event.payload.projectId,
            scope: event.payload.memory.scope,
            type: event.payload.memory.type,
            name: event.payload.memory.name,
            description: event.payload.memory.description,
            body: event.payload.memory.body,
            createdAt: event.payload.memory.createdAt,
            updatedAt: event.payload.memory.updatedAt,
            deletedAt: event.payload.memory.deletedAt,
          });
          return;

        case "project.memory-deleted": {
          const existingRow = yield* projectionProjectMemoryRepository.getById({
            memoryId: event.payload.memoryId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectMemoryRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

  const applyProjectSkillsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "project.skills-replaced":
          yield* projectionProjectSkillRepository.replaceForProject({
            projectId: event.payload.projectId,
            skills: event.payload.skills,
          });
          return;

        case "project.deleted":
          yield* projectionProjectSkillRepository.deleteByProjectId({
            projectId: event.payload.projectId,
          });
          return;

        default:
          return;
      }
    });

  const applyCodeReviewWorkflowsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "project.code-review-workflow-created":
        case "project.code-review-workflow-upserted":
          yield* projectionCodeReviewWorkflowRepository.upsert(event.payload.workflow);
          return;

        case "project.code-review-workflow-deleted":
          yield* projectionCodeReviewWorkflowRepository.deleteById({
            workflowId: event.payload.workflowId,
            deletedAt: event.payload.deletedAt,
          });
          return;

        default:
          return;
      }
    });

  const applyThreadsProjection: ProjectorDefinition["apply"] = (event, attachmentSideEffects) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            model: event.payload.model,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            latestTurnId: null,
            tasks: [],
            tasksTurnId: null,
            tasksUpdatedAt: null,
            compaction: null,
            estimatedContextTokens: null,
            modelContextWindowTokens: estimateModelContextWindowTokens(event.payload.model),
            sessionNotes: null,
            threadReferences: event.payload.threadReferences ?? [],
            archivedAt: null,
            createdAt: event.payload.createdAt,
            lastInteractionAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
            ...(event.payload.model !== undefined
              ? {
                  modelContextWindowTokens: estimateModelContextWindowTokens(event.payload.model),
                }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.compacted":
        case "thread.command-execution-recorded":
        case "thread.command-execution-output-appended":
        case "thread.file-change-recorded": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.type === "thread.compacted"
              ? {
                  compaction: event.payload.compaction,
                  estimatedContextTokens: event.payload.compaction.estimatedTokens,
                }
              : {}),
            lastInteractionAt: event.occurredAt,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.message-sent": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const currentMessages = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const estimatedContextTokens = estimateThreadContextTokensForMessageEvent({
            currentMessages,
            payload: event.payload,
            estimatedContextTokens: existingRow.value.estimatedContextTokens,
          });

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            estimatedContextTokens,
            lastInteractionAt: event.occurredAt,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.tasks.updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            tasks: event.payload.tasks,
            tasksTurnId: event.payload.turnId,
            tasksUpdatedAt: event.payload.updatedAt,
            lastInteractionAt: event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.turn-interrupt-requested":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested":
        case "thread.session-stop-requested":
        case "thread.compact-requested":
        case "thread.checkpoint-revert-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            lastInteractionAt: event.occurredAt,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.session-notes-recorded": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            sessionNotes: event.payload.sessionNotes,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.session.activeTurnId,
            ...(event.payload.session.estimatedContextTokens !== undefined
              ? { estimatedContextTokens: event.payload.session.estimatedContextTokens }
              : {}),
            ...(event.payload.session.modelContextWindowTokens !== undefined
              ? { modelContextWindowTokens: event.payload.session.modelContextWindowTokens }
              : {}),
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            lastInteractionAt: event.occurredAt,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: null,
            // TodoWrite tasks are stored as the latest runtime snapshot.
            // Revert clears them so discarded-turn tasks do not remain visible.
            tasks: [],
            tasksTurnId: null,
            tasksUpdatedAt: null,
            compaction: null,
            estimatedContextTokens: null,
            lastInteractionAt: event.occurredAt,
            updatedAt: event.occurredAt,
          });
          return;
        }

        default:
          return;
      }
    });

  const applyThreadMessagesProjection: ProjectorDefinition["apply"] = (
    event,
    attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.message-sent": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const existingMessage = existingRows.find(
            (row) => row.messageId === event.payload.messageId,
          );
          const nextMessage = resolveProjectedMessageState(existingMessage, event.payload);
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : nextMessage.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextMessage.text,
            ...(nextMessage.reasoningText !== undefined
              ? { reasoningText: nextMessage.reasoningText }
              : {}),
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            isStreaming: event.payload.streaming,
            createdAt: existingMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

  const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyThreadCommandExecutionsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.command-execution-recorded": {
          const existingRow = yield* projectionThreadCommandExecutionRepository.getById({
            commandExecutionId: event.payload.commandExecution.id,
          });
          const nextRow = existingRow
            ? {
                ...existingRow,
                cwd: event.payload.commandExecution.cwd ?? existingRow.cwd,
                title: event.payload.commandExecution.title,
                status: event.payload.commandExecution.status,
                detail: event.payload.commandExecution.detail,
                exitCode: event.payload.commandExecution.exitCode,
                completedAt: event.payload.commandExecution.completedAt,
                updatedAt: event.payload.commandExecution.updatedAt,
                lastUpdatedSequence: event.sequence,
              }
            : {
                id: event.payload.commandExecution.id,
                threadId: event.payload.threadId,
                turnId: event.payload.commandExecution.turnId,
                providerItemId: event.payload.commandExecution.providerItemId,
                command: event.payload.commandExecution.command,
                ...(event.payload.commandExecution.cwd
                  ? { cwd: event.payload.commandExecution.cwd }
                  : {}),
                title: event.payload.commandExecution.title,
                status: event.payload.commandExecution.status,
                detail: event.payload.commandExecution.detail,
                output: "",
                outputTruncated: false,
                exitCode: event.payload.commandExecution.exitCode,
                startedAt: event.payload.commandExecution.startedAt,
                completedAt: event.payload.commandExecution.completedAt,
                updatedAt: event.payload.commandExecution.updatedAt,
                startedSequence: event.sequence,
                lastUpdatedSequence: event.sequence,
              };

          yield* projectionThreadCommandExecutionRepository.upsert(nextRow);
          return;
        }

        case "thread.command-execution-output-appended": {
          const existingRow = yield* projectionThreadCommandExecutionRepository.getById({
            commandExecutionId: event.payload.commandExecutionId,
          });
          if (!existingRow) {
            return;
          }

          const nextOutput = truncateCommandTranscriptOutput(
            `${existingRow.output}${event.payload.chunk}`,
          );
          yield* projectionThreadCommandExecutionRepository.upsert({
            ...existingRow,
            output: nextOutput.output,
            outputTruncated: existingRow.outputTruncated || nextOutput.outputTruncated,
            updatedAt: event.payload.updatedAt,
            lastUpdatedSequence: event.sequence,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadCommandExecutionRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const retainedTurnIds = new Set(
            existingTurns
              .filter(
                (turn) =>
                  turn.turnId !== null &&
                  turn.checkpointTurnCount !== null &&
                  turn.checkpointTurnCount <= event.payload.turnCount,
              )
              .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
          );
          const removedTurnIds = [
            ...new Set(
              existingRows
                .filter((row) => !retainedTurnIds.has(row.turnId))
                .map((row) => row.turnId),
            ),
          ];
          if (removedTurnIds.length === 0) {
            return;
          }

          yield* projectionThreadCommandExecutionRepository.deleteByThreadIdAndTurnIds({
            threadId: event.payload.threadId,
            turnIds: removedTurnIds,
          });
          return;
        }

        case "thread.deleted":
          yield* projectionThreadCommandExecutionRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        default:
          return;
      }
    });

  const applyThreadFileChangesProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.file-change-recorded":
          yield* projectionThreadFileChangeRepository.upsert({
            ...event.payload.fileChange,
            threadId: event.payload.threadId,
            startedSequence: event.sequence,
            lastUpdatedSequence: event.sequence,
            hasPatch: event.payload.fileChange.patch.length > 0,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadFileChangeRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const retainedTurnIds = new Set(
            existingTurns
              .filter(
                (turn) =>
                  turn.turnId !== null &&
                  turn.checkpointTurnCount !== null &&
                  turn.checkpointTurnCount <= event.payload.turnCount,
              )
              .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
          );
          const removedTurnIds = existingRows
            .filter((row) => !retainedTurnIds.has(row.turnId))
            .map((row) => row.turnId);
          if (removedTurnIds.length === 0) {
            return;
          }

          yield* projectionThreadFileChangeRepository.deleteByThreadIdAndTurnIds({
            threadId: event.payload.threadId,
            turnIds: removedTurnIds,
          });
          return;
        }

        default:
          return;
      }
    });

  const applyThreadSessionsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.session-set": {
          const existingRow = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          yield* projectionThreadSessionRepository.upsert({
            threadId: event.payload.threadId,
            status: event.payload.session.status,
            providerName: event.payload.session.providerName,
            runtimeMode: event.payload.session.runtimeMode,
            activeTurnId: event.payload.session.activeTurnId,
            lastError: event.payload.session.lastError,
            estimatedContextTokens:
              event.payload.session.estimatedContextTokens ??
              (Option.isSome(existingRow) ? existingRow.value.estimatedContextTokens : null),
            modelContextWindowTokens:
              event.payload.session.modelContextWindowTokens ??
              (Option.isSome(existingRow) ? existingRow.value.modelContextWindowTokens : null),
            tokenUsageSource:
              event.payload.session.tokenUsageSource ??
              (Option.isSome(existingRow) ? existingRow.value.tokenUsageSource : null),
            updatedAt: event.payload.session.updatedAt,
          });
          return;
        }

        case "thread.message-sent": {
          const existingRow = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const currentMessages = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const existingThreadRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          const estimatedContextTokens = estimateThreadContextTokensForMessageEvent({
            currentMessages,
            payload: event.payload,
            estimatedContextTokens:
              existingRow.value.estimatedContextTokens ??
              (Option.isSome(existingThreadRow)
                ? existingThreadRow.value.estimatedContextTokens
                : null),
          });
          yield* projectionThreadSessionRepository.upsert({
            ...existingRow.value,
            estimatedContextTokens,
            tokenUsageSource: "estimated",
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.compacted": {
          const existingRow = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadSessionRepository.upsert({
            ...existingRow.value,
            estimatedContextTokens: event.payload.compaction.estimatedTokens,
            tokenUsageSource: "estimated",
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadSessionRepository.upsert({
            ...existingRow.value,
            estimatedContextTokens: null,
            tokenUsageSource: null,
            updatedAt: event.occurredAt,
          });
          return;
        }

        default:
          return;
      }
    });

  const applyThreadTurnsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (event.payload.session.status === "running" && turnId !== null) {
            const existingTurn = yield* projectionTurnRepository.getByTurnId({
              threadId: event.payload.threadId,
              turnId,
            });
            const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
              threadId: event.payload.threadId,
            });
            if (Option.isSome(existingTurn)) {
              const nextState =
                existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                  ? existingTurn.value.state
                  : "running";
              yield* projectionTurnRepository.upsertByTurnId({
                ...existingTurn.value,
                state: nextState,
                pendingMessageId:
                  existingTurn.value.pendingMessageId ??
                  (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
                startedAt:
                  existingTurn.value.startedAt ??
                  (Option.isSome(pendingTurnStart)
                    ? pendingTurnStart.value.requestedAt
                    : event.occurredAt),
                requestedAt:
                  existingTurn.value.requestedAt ??
                  (Option.isSome(pendingTurnStart)
                    ? pendingTurnStart.value.requestedAt
                    : event.occurredAt),
              });
            } else {
              yield* projectionTurnRepository.upsertByTurnId({
                turnId,
                threadId: event.payload.threadId,
                pendingMessageId: Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.messageId
                  : null,
                assistantMessageId: null,
                state: "running",
                requestedAt: Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt,
                startedAt: Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt,
                completedAt: null,
                checkpointTurnCount: null,
                checkpointRef: null,
                checkpointStatus: null,
                checkpointFiles: [],
              });
            }

            yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
              threadId: event.payload.threadId,
            });
            return;
          }

          if (
            event.payload.session.status !== "ready" &&
            event.payload.session.status !== "error" &&
            event.payload.session.status !== "stopped"
          ) {
            return;
          }

          const runningTurn = yield* projectionTurnRepository.getLatestRunningByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(runningTurn)) {
            return;
          }
          const runningTurnId = runningTurn.value.turnId;

          const terminalState =
            event.payload.session.status === "ready"
              ? "completed"
              : event.payload.session.status === "error"
                ? "error"
                : "interrupted";
          yield* projectionTurnRepository.upsertByTurnId({
            ...runningTurn.value,
            turnId: runningTurnId,
            state: terminalState,
            startedAt: runningTurn.value.startedAt ?? runningTurn.value.requestedAt,
            completedAt: runningTurn.value.completedAt ?? event.payload.session.updatedAt,
          });
          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "interrupted"
                ? "interrupted"
                : existingTurn.value.state === "error"
                  ? "error"
                  : existingTurn.value.state === "completed"
                    ? "completed"
                    : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: event.payload.streaming ? existingTurn.value.state : nextState,
              completedAt:
                event.payload.streaming || nextState === "running"
                  ? existingTurn.value.completedAt
                  : (existingTurn.value.completedAt ?? event.payload.updatedAt),
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            assistantMessageId: event.payload.messageId,
            state: "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state: nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

  const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

  const projectors: ReadonlyArray<ProjectorDefinition> = [
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.projects,
      apply: applyProjectsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.projectMemories,
      apply: applyProjectMemoriesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.projectSkills,
      apply: applyProjectSkillsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.planningWorkflows,
      apply: applyPlanningWorkflowsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.codeReviewWorkflows,
      apply: applyCodeReviewWorkflowsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
      apply: applyThreadMessagesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
      apply: applyThreadProposedPlansProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
      apply: applyThreadActivitiesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadCommandExecutions,
      apply: applyThreadCommandExecutionsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadFileChanges,
      apply: applyThreadFileChangesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
      apply: applyThreadSessionsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
      apply: applyThreadTurnsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
      apply: applyCheckpointsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
      apply: applyPendingApprovalsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threads,
      apply: applyThreadsProjection,
    },
  ];

  const runProjectorForEvent = (projector: ProjectorDefinition, event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

  const bootstrapProjector = (projector: ProjectorDefinition) =>
    projectionStateRepository
      .getByProjector({
        projector: projector.name,
      })
      .pipe(
        Effect.flatMap((stateRow) =>
          Stream.runForEach(
            eventStore.readFromSequence(
              Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
            ),
            (event) => runProjectorForEvent(projector, event),
          ),
        ),
      );

  const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
    Effect.forEach(projectors, (projector) => runProjectorForEvent(projector, event), {
      concurrency: 1,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
      ),
    );

  const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
    projectors,
    bootstrapProjector,
    { concurrency: 1 },
  ).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ServerConfig, serverConfig),
    Effect.asVoid,
    Effect.tap(() =>
      Effect.log("orchestration projection pipeline bootstrapped").pipe(
        Effect.annotateLogs({ projectors: projectors.length }),
      ),
    ),
    Effect.catchTag("SqlError", (sqlError) =>
      Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
    ),
  );

  return {
    bootstrap,
    projectEvent,
  } satisfies OrchestrationProjectionPipelineShape;
});

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline,
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ProjectionCodeReviewWorkflowRepositoryLive),
  Layer.provideMerge(ProjectionPlanningWorkflowRepositoryLive),
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionProjectMemoryRepositoryLive),
  Layer.provideMerge(ProjectionProjectSkillRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadCommandExecutionRepositoryLive),
  Layer.provideMerge(ProjectionThreadFileChangeRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
