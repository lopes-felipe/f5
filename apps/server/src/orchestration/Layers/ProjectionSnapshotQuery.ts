import {
  ChatAttachment,
  CodeReviewWorkflow,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCommandExecutionSummary,
  OrchestrationCheckpointFile,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationGetStartupSnapshotResult,
  OrchestrationGetThreadTailDetailsInput,
  OrchestrationReadModel,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadDetails,
  OrchestrationThreadTailDetails,
  ProjectSkill,
  TaskItem,
  ThreadCompaction,
  ThreadReference,
  ThreadSessionNotes,
  PlanningWorkflow,
  ProjectMemory,
  ProjectScript,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationCommandExecutionCursor,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { compactThreadActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";
import { archivedWorkflowThreadIds } from "@t3tools/shared/workflowThreads";

import { ProjectionCheckpointRepositoryLive } from "../../persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadCommandExecutionSummaryDbRowSchema } from "../../persistence/Layers/ProjectionThreadCommandExecutions.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionCheckpointRepository } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProjectMemory } from "../../persistence/Services/ProjectionProjectMemories.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectSkill } from "../../persistence/Services/ProjectionProjectSkills.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
} from "../readModelRetention.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeThreadDetails = Schema.decodeUnknownEffect(OrchestrationThreadDetails);
const decodeThreadTailDetails = Schema.decodeUnknownEffect(OrchestrationThreadTailDetails);
const decodeThreadHistoryPage = Schema.decodeUnknownEffect(OrchestrationThreadHistoryPage);
const shouldLogProjectionTimings =
  process.env.T3CODE_LOG_PROJECTION_TIMINGS === "1" ||
  process.env.T3CODE_LOG_PROJECTION_TIMINGS === "true";
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionProjectMemoryDbRowSchema = ProjectionProjectMemory;
const ProjectionProjectSkillDbRowSchema = ProjectionProjectSkill.mapFields(
  Struct.assign({
    allowedTools: Schema.fromJsonString(Schema.Array(Schema.String)),
    paths: Schema.fromJsonString(Schema.Array(Schema.String)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    reasoningText: Schema.NullOr(Schema.String),
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    tasks: Schema.fromJsonString(Schema.Array(TaskItem)),
    compaction: Schema.NullOr(Schema.fromJsonString(ThreadCompaction)),
    sessionNotes: Schema.NullOr(Schema.fromJsonString(ThreadSessionNotes)),
    threadReferences: Schema.fromJsonString(Schema.Array(ThreadReference)),
  }),
);
const ProjectionThreadSummaryDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  projectId: ProjectionThread.fields.projectId,
  title: ProjectionThread.fields.title,
  model: ProjectionThread.fields.model,
  runtimeMode: ProjectionThread.fields.runtimeMode,
  interactionMode: ProjectionThread.fields.interactionMode,
  branch: ProjectionThread.fields.branch,
  worktreePath: ProjectionThread.fields.worktreePath,
  archivedAt: ProjectionThread.fields.archivedAt,
  createdAt: ProjectionThread.fields.createdAt,
  lastInteractionAt: ProjectionThread.fields.lastInteractionAt,
  updatedAt: ProjectionThread.fields.updatedAt,
  deletedAt: ProjectionThread.fields.deletedAt,
  estimatedContextTokens: ProjectionThread.fields.estimatedContextTokens,
  modelContextWindowTokens: ProjectionThread.fields.modelContextWindowTokens,
});
type ProjectionThreadDetailDbRow = Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>;
type ProjectionThreadSummaryDbRow = Schema.Schema.Type<typeof ProjectionThreadSummaryDbRowSchema>;
type ProjectionThreadSnapshotDbRow = ProjectionThreadDetailDbRow | ProjectionThreadSummaryDbRow;
type SnapshotScope = "getBootstrapSnapshot" | "getSnapshot" | "getStartupSnapshot";
type SnapshotHistoryLoadMode = "full" | "retained";
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
});
const DEFAULT_THREAD_TAIL_MESSAGE_LIMIT = 120;
const DEFAULT_THREAD_TAIL_CHECKPOINT_LIMIT = 40;
const DEFAULT_THREAD_TAIL_COMMAND_EXECUTION_LIMIT = 120;
const MAX_THREAD_HISTORY_MESSAGE_LIMIT = DEFAULT_THREAD_TAIL_MESSAGE_LIMIT;
const MAX_THREAD_HISTORY_CHECKPOINT_LIMIT = DEFAULT_THREAD_TAIL_CHECKPOINT_LIMIT;
const MAX_THREAD_HISTORY_COMMAND_EXECUTION_LIMIT = DEFAULT_THREAD_TAIL_COMMAND_EXECUTION_LIMIT;
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionPlanningWorkflowDbRowSchema = Schema.Struct({
  workflowId: PlanningWorkflow.fields.id,
  projectId: PlanningWorkflow.fields.projectId,
  workflow: Schema.fromJsonString(PlanningWorkflow),
});
const ProjectionCodeReviewWorkflowDbRowSchema = Schema.Struct({
  workflowId: CodeReviewWorkflow.fields.id,
  projectId: CodeReviewWorkflow.fields.projectId,
  workflow: Schema.fromJsonString(CodeReviewWorkflow),
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.projectMemories,
  ORCHESTRATION_PROJECTOR_NAMES.projectSkills,
  ORCHESTRATION_PROJECTOR_NAMES.planningWorkflows,
  ORCHESTRATION_PROJECTOR_NAMES.codeReviewWorkflows,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function compareIsoDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

function compareThreadsByActivity(
  left: Pick<OrchestrationThread, "lastInteractionAt" | "createdAt" | "id">,
  right: Pick<OrchestrationThread, "lastInteractionAt" | "createdAt" | "id">,
): number {
  return (
    compareIsoDescending(left.lastInteractionAt, right.lastInteractionAt) ||
    compareIsoDescending(left.createdAt, right.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

function sortProjectsByVisibleThreadActivity(
  projects: ReadonlyArray<OrchestrationProject>,
  threads: ReadonlyArray<OrchestrationThread>,
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
): OrchestrationProject[] {
  const hiddenWorkflowThreadIds = archivedWorkflowThreadIds(planningWorkflows, codeReviewWorkflows);
  const mostRecentThreadByProjectId = new Map<OrchestrationProject["id"], OrchestrationThread>();

  for (const thread of threads) {
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      hiddenWorkflowThreadIds.has(thread.id)
    ) {
      continue;
    }

    const current = mostRecentThreadByProjectId.get(thread.projectId);
    if (!current || compareThreadsByActivity(thread, current) < 0) {
      mostRecentThreadByProjectId.set(thread.projectId, thread);
    }
  }

  return projects.toSorted((left, right) => {
    const leftLastInteractionAt =
      mostRecentThreadByProjectId.get(left.id)?.lastInteractionAt ?? left.createdAt;
    const rightLastInteractionAt =
      mostRecentThreadByProjectId.get(right.id)?.lastInteractionAt ?? right.createdAt;

    return (
      compareIsoDescending(leftLastInteractionAt, rightLastInteractionAt) ||
      compareIsoDescending(left.createdAt, right.createdAt) ||
      right.id.localeCompare(left.id)
    );
  });
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let snapshotSequence: number | null = null;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    snapshotSequence = snapshotSequence === null ? sequence : Math.min(snapshotSequence, sequence);
  }

  return snapshotSequence ?? 0;
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function withTimedLog<A, E, R>(params: {
  readonly kind: "query" | "request";
  readonly scope:
    | SnapshotScope
    | "getThreadDetails"
    | "getThreadHistoryPage"
    | "getThreadTailDetails";
  readonly name: string;
  readonly effect: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> {
  if (!shouldLogProjectionTimings) {
    return params.effect;
  }

  const startedAtMs = Date.now();
  return params.effect.pipe(
    Effect.tap(() =>
      Effect.logInfo("projection timing", {
        kind: params.kind,
        scope: params.scope,
        name: params.name,
        durationMs: Date.now() - startedAtMs,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.logWarning("projection timing failed", {
        kind: params.kind,
        scope: params.scope,
        name: params.name,
        durationMs: Date.now() - startedAtMs,
        cause,
      }),
    ),
  );
}

function toReadModelMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): OrchestrationMessage {
  return {
    id: row.messageId,
    role: row.role,
    text: row.text,
    ...(row.reasoningText !== null ? { reasoningText: row.reasoningText } : {}),
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toReadModelActivity(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: compactThreadActivityPayload({
      kind: row.kind,
      payload: row.payload,
    }),
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

function toReadModelCheckpoint(
  row: Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>,
): OrchestrationCheckpointSummary {
  return {
    turnId: row.turnId,
    checkpointTurnCount: row.checkpointTurnCount,
    checkpointRef: row.checkpointRef,
    status: row.status,
    files: row.files,
    assistantMessageId: row.assistantMessageId,
    completedAt: row.completedAt,
  };
}

function buildThreadSnapshot(params: {
  readonly row: ProjectionThreadSnapshotDbRow;
  readonly latestTurnByThread: ReadonlyMap<string, OrchestrationLatestTurn>;
  readonly sessionsByThread: ReadonlyMap<string, OrchestrationSession>;
  readonly messagesByThread: ReadonlyMap<string, Array<OrchestrationMessage>>;
  readonly proposedPlansByThread: ReadonlyMap<string, Array<OrchestrationProposedPlan>>;
  readonly activitiesByThread: ReadonlyMap<string, Array<OrchestrationThreadActivity>>;
  readonly checkpointsByThread: ReadonlyMap<string, Array<OrchestrationCheckpointSummary>>;
  readonly includeDetailFields: boolean;
}): OrchestrationThread {
  const { row, includeDetailFields } = params;
  const detailRow = includeDetailFields && "tasks" in row && "compaction" in row ? row : null;
  return {
    id: row.threadId,
    projectId: row.projectId,
    title: row.title,
    model: row.model,
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    branch: row.branch,
    worktreePath: row.worktreePath,
    latestTurn: params.latestTurnByThread.get(row.threadId) ?? null,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    lastInteractionAt: row.lastInteractionAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    estimatedContextTokens: row.estimatedContextTokens,
    modelContextWindowTokens: row.modelContextWindowTokens,
    messages: params.messagesByThread.get(row.threadId) ?? [],
    proposedPlans: params.proposedPlansByThread.get(row.threadId) ?? [],
    tasks: detailRow?.tasks ?? [],
    tasksTurnId: detailRow?.tasksTurnId ?? null,
    tasksUpdatedAt: detailRow?.tasksUpdatedAt ?? null,
    activities: params.activitiesByThread.get(row.threadId) ?? [],
    checkpoints: params.checkpointsByThread.get(row.threadId) ?? [],
    compaction: detailRow?.compaction ?? null,
    sessionNotes: detailRow?.sessionNotes ?? null,
    threadReferences: detailRow?.threadReferences ?? [],
    session: params.sessionsByThread.get(row.threadId) ?? null,
  };
}

function buildThreadDetailsResult(params: {
  readonly scope: "getStartupSnapshot" | "getThreadDetails";
  readonly threadId: OrchestrationThreadDetails["threadId"];
  readonly thread: ProjectionThread | null;
  readonly messages: ReadonlyArray<ProjectionThreadMessage>;
  readonly checkpoints: ReadonlyArray<ProjectionCheckpoint>;
  readonly detailSequence: number;
}): Effect.Effect<OrchestrationThreadDetails, ProjectionRepositoryError> {
  return decodeThreadDetails({
    threadId: params.threadId,
    messages: mapThreadDetailMessages(params.messages),
    checkpoints: params.checkpoints,
    tasks: params.thread?.tasks ?? [],
    tasksTurnId: params.thread?.tasksTurnId ?? null,
    tasksUpdatedAt: params.thread?.tasksUpdatedAt ?? null,
    sessionNotes: params.thread?.sessionNotes ?? null,
    threadReferences: params.thread?.threadReferences ?? [],
    detailSequence: params.detailSequence,
  }).pipe(
    Effect.mapError(
      toPersistenceDecodeError(`ProjectionSnapshotQuery.${params.scope}:decodeThreadDetails`),
    ),
  );
}

function mapThreadDetailMessages(
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Array<OrchestrationThreadTailDetails["messages"][number]> {
  return messages.map((message) => ({
    id: message.messageId,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    streaming: message.isStreaming,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    ...(message.reasoningText !== undefined ? { reasoningText: message.reasoningText } : {}),
    ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
  }));
}

function resolveOldestLoadedMessageCursor(
  messages: ReadonlyArray<ProjectionThreadMessage>,
): OrchestrationThreadTailDetails["oldestLoadedMessageCursor"] {
  const oldestMessage = messages[0];
  if (!oldestMessage) {
    return null;
  }
  return {
    createdAt: oldestMessage.createdAt,
    messageId: oldestMessage.messageId,
  };
}

function resolveOldestLoadedCheckpointTurnCount(
  checkpoints: ReadonlyArray<ProjectionCheckpoint>,
): number | null {
  return checkpoints[0]?.checkpointTurnCount ?? null;
}

function resolveOldestLoadedCommandExecutionCursor(
  commandExecutions: ReadonlyArray<OrchestrationCommandExecutionSummary>,
): OrchestrationCommandExecutionCursor | null {
  const oldestCommandExecution = commandExecutions[0];
  if (!oldestCommandExecution) {
    return null;
  }
  return {
    startedAt: oldestCommandExecution.startedAt,
    startedSequence: oldestCommandExecution.startedSequence,
    commandExecutionId: oldestCommandExecution.id,
  };
}

function toProjectionThreadMessageRecord(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    ...(row.reasoningText !== null ? { reasoningText: row.reasoningText } : {}),
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
  };
}

function toProjectionCheckpointRecord(
  row: Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>,
): ProjectionCheckpoint {
  return {
    threadId: row.threadId,
    turnId: row.turnId,
    checkpointTurnCount: row.checkpointTurnCount,
    checkpointRef: row.checkpointRef,
    status: row.status,
    files: row.files,
    assistantMessageId: row.assistantMessageId,
    completedAt: row.completedAt,
  };
}

function toProjectionThreadCommandExecutionSummaryRecord(
  row: Schema.Schema.Type<typeof ProjectionThreadCommandExecutionSummaryDbRowSchema>,
): OrchestrationCommandExecutionSummary {
  return {
    id: row.id,
    threadId: row.threadId,
    turnId: row.turnId,
    providerItemId: row.providerItemId,
    command: row.command,
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    title: row.title,
    status: row.status,
    detail: row.detail,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
    startedSequence: row.startedSequence,
    lastUpdatedSequence: row.lastUpdatedSequence,
  };
}

function resolveThreadHistoryMessageLimit(messageLimit?: number): number {
  return Math.min(
    messageLimit ?? DEFAULT_THREAD_TAIL_MESSAGE_LIMIT,
    MAX_THREAD_HISTORY_MESSAGE_LIMIT,
  );
}

function resolveThreadHistoryCheckpointLimit(checkpointLimit?: number): number {
  return Math.min(
    checkpointLimit ?? DEFAULT_THREAD_TAIL_CHECKPOINT_LIMIT,
    MAX_THREAD_HISTORY_CHECKPOINT_LIMIT,
  );
}

function resolveThreadHistoryCommandExecutionLimit(commandExecutionLimit?: number): number {
  return Math.min(
    commandExecutionLimit ?? DEFAULT_THREAD_TAIL_COMMAND_EXECUTION_LIMIT,
    MAX_THREAD_HISTORY_COMMAND_EXECUTION_LIMIT,
  );
}

function buildThreadTailDetailsResult(params: {
  readonly scope: "getStartupSnapshot" | "getThreadTailDetails";
  readonly threadId: OrchestrationThreadTailDetails["threadId"];
  readonly thread: ProjectionThread | null;
  readonly messages: ReadonlyArray<ProjectionThreadMessage>;
  readonly checkpoints: ReadonlyArray<ProjectionCheckpoint>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly commandExecutions: ReadonlyArray<OrchestrationCommandExecutionSummary>;
  readonly hasOlderMessages: boolean;
  readonly hasOlderCheckpoints: boolean;
  readonly hasOlderCommandExecutions: boolean;
  readonly detailSequence: number;
}): Effect.Effect<OrchestrationThreadTailDetails, ProjectionRepositoryError> {
  return decodeThreadTailDetails({
    threadId: params.threadId,
    messages: mapThreadDetailMessages(params.messages),
    checkpoints: params.checkpoints,
    activities: params.activities,
    commandExecutions: params.commandExecutions,
    tasks: params.thread?.tasks ?? [],
    tasksTurnId: params.thread?.tasksTurnId ?? null,
    tasksUpdatedAt: params.thread?.tasksUpdatedAt ?? null,
    sessionNotes: params.thread?.sessionNotes ?? null,
    threadReferences: params.thread?.threadReferences ?? [],
    hasOlderMessages: params.hasOlderMessages,
    hasOlderCheckpoints: params.hasOlderCheckpoints,
    hasOlderCommandExecutions: params.hasOlderCommandExecutions,
    oldestLoadedMessageCursor: resolveOldestLoadedMessageCursor(params.messages),
    oldestLoadedCheckpointTurnCount: resolveOldestLoadedCheckpointTurnCount(params.checkpoints),
    oldestLoadedCommandExecutionCursor: resolveOldestLoadedCommandExecutionCursor(
      params.commandExecutions,
    ),
    detailSequence: params.detailSequence,
  }).pipe(
    Effect.mapError(
      toPersistenceDecodeError(`ProjectionSnapshotQuery.${params.scope}:decodeThreadTailDetails`),
    ),
  );
}

function buildThreadHistoryPageResult(params: {
  readonly threadId: OrchestrationThreadHistoryPage["threadId"];
  readonly messages: ReadonlyArray<ProjectionThreadMessage>;
  readonly checkpoints: ReadonlyArray<ProjectionCheckpoint>;
  readonly commandExecutions: ReadonlyArray<OrchestrationCommandExecutionSummary>;
  readonly hasOlderMessages: boolean;
  readonly hasOlderCheckpoints: boolean;
  readonly hasOlderCommandExecutions: boolean;
  readonly detailSequence: number;
}): Effect.Effect<OrchestrationThreadHistoryPage, ProjectionRepositoryError> {
  return decodeThreadHistoryPage({
    threadId: params.threadId,
    messages: mapThreadDetailMessages(params.messages),
    checkpoints: params.checkpoints,
    commandExecutions: params.commandExecutions,
    hasOlderMessages: params.hasOlderMessages,
    hasOlderCheckpoints: params.hasOlderCheckpoints,
    hasOlderCommandExecutions: params.hasOlderCommandExecutions,
    oldestLoadedMessageCursor: resolveOldestLoadedMessageCursor(params.messages),
    oldestLoadedCheckpointTurnCount: resolveOldestLoadedCheckpointTurnCount(params.checkpoints),
    oldestLoadedCommandExecutionCursor: resolveOldestLoadedCommandExecutionCursor(
      params.commandExecutions,
    ),
    detailSequence: params.detailSequence,
  }).pipe(
    Effect.mapError(
      toPersistenceDecodeError(
        "ProjectionSnapshotQuery.getThreadHistoryPage:decodeThreadHistoryPage",
      ),
    ),
  );
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionCheckpointRepository = yield* ProjectionCheckpointRepository;
  const projectionStateRepository = yield* ProjectionStateRepository;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model AS "defaultModel",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY projection_projects.created_at DESC, projection_projects.project_id DESC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          tasks_json AS "tasks",
          tasks_turn_id AS "tasksTurnId",
          tasks_updated_at AS "tasksUpdatedAt",
          compaction_json AS "compaction",
          session_notes_json AS "sessionNotes",
          thread_references_json AS "threadReferences",
          archived_at AS "archivedAt",
          created_at AS "createdAt",
          last_interaction_at AS "lastInteractionAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt",
          estimated_context_tokens AS "estimatedContextTokens",
          model_context_window_tokens AS "modelContextWindowTokens"
        FROM projection_threads
        ORDER BY last_interaction_at DESC, created_at DESC, thread_id DESC
      `,
  });
  const listThreadSummaryRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSummaryDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          archived_at AS "archivedAt",
          created_at AS "createdAt",
          last_interaction_at AS "lastInteractionAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt",
          estimated_context_tokens AS "estimatedContextTokens",
          model_context_window_tokens AS "modelContextWindowTokens"
        FROM projection_threads
        ORDER BY last_interaction_at DESC, created_at DESC, thread_id DESC
      `,
  });

  const listProjectMemoryRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectMemoryDbRowSchema,
    execute: () =>
      sql`
        SELECT
          memory_id AS "memoryId",
          project_id AS "projectId",
          scope,
          type,
          name,
          description,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_project_memories
        ORDER BY project_id ASC, updated_at DESC, memory_id ASC
      `,
  });

  const listProjectSkillRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectSkillDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          skill_id AS "id",
          scope,
          command_name AS "commandName",
          display_name AS "displayName",
          description,
          argument_hint AS "argumentHint",
          allowed_tools_json AS "allowedTools",
          paths_json AS "paths",
          updated_at AS "updatedAt"
        FROM projection_project_skills
        ORDER BY project_id ASC, scope ASC, command_name ASC, skill_id ASC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          reasoning_text AS "reasoningText",
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listRetainedThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        WITH ranked_messages AS (
          SELECT
            message_id AS "messageId",
            thread_id AS "threadId",
            turn_id AS "turnId",
            role,
            text,
            reasoning_text AS "reasoningText",
            attachments_json AS "attachments",
            is_streaming AS "isStreaming",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY created_at DESC, message_id DESC
            ) AS row_number
          FROM projection_thread_messages
        )
        SELECT
          "messageId",
          "threadId",
          "turnId",
          role,
          text,
          "reasoningText",
          "attachments",
          "isStreaming",
          "createdAt",
          "updatedAt"
        FROM ranked_messages
        WHERE row_number <= ${MAX_THREAD_MESSAGES}
        ORDER BY "threadId" ASC, "createdAt" ASC, "messageId" ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listRetainedThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        WITH ranked_proposed_plans AS (
          SELECT
            plan_id AS "planId",
            thread_id AS "threadId",
            turn_id AS "turnId",
            plan_markdown AS "planMarkdown",
            implemented_at AS "implementedAt",
            implementation_thread_id AS "implementationThreadId",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY created_at DESC, plan_id DESC
            ) AS row_number
          FROM projection_thread_proposed_plans
        )
        SELECT
          "planId",
          "threadId",
          "turnId",
          "planMarkdown",
          "implementedAt",
          "implementationThreadId",
          "createdAt",
          "updatedAt"
        FROM ranked_proposed_plans
        WHERE row_number <= ${MAX_THREAD_PROPOSED_PLANS}
        ORDER BY "threadId" ASC, "createdAt" ASC, "planId" ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listRetainedThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        WITH ranked_activities AS (
          SELECT
            activity_id AS "activityId",
            thread_id AS "threadId",
            turn_id AS "turnId",
            tone,
            kind,
            summary,
            payload_json AS "payload",
            sequence,
            created_at AS "createdAt",
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                activity_id DESC
            ) AS row_number
          FROM projection_thread_activities
        )
        SELECT
          "activityId",
          "threadId",
          "turnId",
          tone,
          kind,
          summary,
          "payload",
          sequence,
          "createdAt"
        FROM ranked_activities
        WHERE row_number <= ${MAX_THREAD_ACTIVITIES}
        ORDER BY
          "threadId" ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          "createdAt" ASC,
          "activityId" ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          estimated_context_tokens AS "estimatedContextTokens",
          model_context_window_tokens AS "modelContextWindowTokens",
          token_usage_source AS "tokenUsageSource",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listRetainedCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        WITH ranked_checkpoints AS (
          SELECT
            thread_id AS "threadId",
            turn_id AS "turnId",
            checkpoint_turn_count AS "checkpointTurnCount",
            checkpoint_ref AS "checkpointRef",
            checkpoint_status AS "status",
            checkpoint_files_json AS "files",
            assistant_message_id AS "assistantMessageId",
            completed_at AS "completedAt",
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY checkpoint_turn_count DESC, turn_id DESC
            ) AS row_number
          FROM projection_turns
          WHERE checkpoint_turn_count IS NOT NULL
        )
        SELECT
          "threadId",
          "turnId",
          "checkpointTurnCount",
          "checkpointRef",
          "status",
          "files",
          "assistantMessageId",
          "completedAt"
        FROM ranked_checkpoints
        WHERE row_number <= ${MAX_THREAD_CHECKPOINTS}
        ORDER BY "threadId" ASC, "checkpointTurnCount" ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const listThreadTailMessageRows = SqlSchema.findAll({
    Request: OrchestrationGetThreadTailDetailsInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, messageLimit }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          reasoning_text AS "reasoningText",
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC, message_id DESC
        LIMIT ${resolveThreadHistoryMessageLimit(messageLimit) + 1}
      `,
  });

  const listThreadHistoryMessageRows = SqlSchema.findAll({
    Request: OrchestrationGetThreadHistoryPageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, beforeMessageCursor, messageLimit }) => {
      const cursor = beforeMessageCursor;
      return cursor == null
        ? sql`
            SELECT
              message_id AS "messageId",
              thread_id AS "threadId",
              turn_id AS "turnId",
              role,
              text,
              reasoning_text AS "reasoningText",
              attachments_json AS "attachments",
              is_streaming AS "isStreaming",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM projection_thread_messages
            WHERE thread_id = ${threadId}
              AND 1 = 0
          `
        : sql`
            SELECT
              message_id AS "messageId",
              thread_id AS "threadId",
              turn_id AS "turnId",
              role,
              text,
              reasoning_text AS "reasoningText",
              attachments_json AS "attachments",
              is_streaming AS "isStreaming",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM projection_thread_messages
            WHERE thread_id = ${threadId}
              AND (
                created_at < ${cursor.createdAt}
                OR (
                  created_at = ${cursor.createdAt}
                  AND message_id < ${cursor.messageId}
                )
              )
            ORDER BY created_at DESC, message_id DESC
            LIMIT ${resolveThreadHistoryMessageLimit(messageLimit) + 1}
          `;
    },
  });

  const listThreadTailCheckpointRows = SqlSchema.findAll({
    Request: OrchestrationGetThreadTailDetailsInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, checkpointLimit }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count DESC
        LIMIT ${resolveThreadHistoryCheckpointLimit(checkpointLimit) + 1}
      `,
  });

  const listThreadTailCommandExecutionRows = SqlSchema.findAll({
    Request: OrchestrationGetThreadTailDetailsInput,
    Result: ProjectionThreadCommandExecutionSummaryDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          command_execution_id AS id,
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_item_id AS "providerItemId",
          command,
          cwd,
          title,
          status,
          detail,
          exit_code AS "exitCode",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          updated_at AS "updatedAt",
          started_sequence AS "startedSequence",
          last_updated_sequence AS "lastUpdatedSequence"
        FROM projection_thread_command_executions
        WHERE thread_id = ${threadId}
        ORDER BY started_at DESC, started_sequence DESC, command_execution_id DESC
        LIMIT ${DEFAULT_THREAD_TAIL_COMMAND_EXECUTION_LIMIT + 1}
      `,
  });

  const listThreadHistoryCheckpointRows = SqlSchema.findAll({
    Request: OrchestrationGetThreadHistoryPageInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, beforeCheckpointTurnCount, checkpointLimit }) =>
      beforeCheckpointTurnCount === null
        ? sql`
            SELECT
              thread_id AS "threadId",
              turn_id AS "turnId",
              checkpoint_turn_count AS "checkpointTurnCount",
              checkpoint_ref AS "checkpointRef",
              checkpoint_status AS "status",
              checkpoint_files_json AS "files",
              assistant_message_id AS "assistantMessageId",
              completed_at AS "completedAt"
            FROM projection_turns
            WHERE thread_id = ${threadId}
              AND 1 = 0
          `
        : sql`
            SELECT
              thread_id AS "threadId",
              turn_id AS "turnId",
              checkpoint_turn_count AS "checkpointTurnCount",
              checkpoint_ref AS "checkpointRef",
              checkpoint_status AS "status",
              checkpoint_files_json AS "files",
              assistant_message_id AS "assistantMessageId",
              completed_at AS "completedAt"
            FROM projection_turns
            WHERE thread_id = ${threadId}
              AND checkpoint_turn_count IS NOT NULL
              AND checkpoint_turn_count < ${beforeCheckpointTurnCount}
            ORDER BY checkpoint_turn_count DESC
            LIMIT ${resolveThreadHistoryCheckpointLimit(checkpointLimit) + 1}
          `,
  });

  const listThreadHistoryCommandExecutionRows = SqlSchema.findAll({
    Request: OrchestrationGetThreadHistoryPageInput,
    Result: ProjectionThreadCommandExecutionSummaryDbRowSchema,
    execute: ({ threadId, beforeCommandExecutionCursor, commandExecutionLimit }) => {
      const cursor = beforeCommandExecutionCursor!;
      return sql`
        SELECT
          command_execution_id AS id,
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_item_id AS "providerItemId",
          command,
          cwd,
          title,
          status,
          detail,
          exit_code AS "exitCode",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          updated_at AS "updatedAt",
          started_sequence AS "startedSequence",
          last_updated_sequence AS "lastUpdatedSequence"
        FROM projection_thread_command_executions
        WHERE thread_id = ${threadId}
          AND (
            started_at < ${cursor.startedAt}
            OR (
              started_at = ${cursor.startedAt}
              AND started_sequence < ${cursor.startedSequence}
            )
            OR (
              started_at = ${cursor.startedAt}
              AND started_sequence = ${cursor.startedSequence}
              AND command_execution_id < ${cursor.commandExecutionId}
            )
          )
        ORDER BY started_at DESC, started_sequence DESC, command_execution_id DESC
        LIMIT ${resolveThreadHistoryCommandExecutionLimit(commandExecutionLimit) + 1}
      `;
    },
  });

  const readThreadTailMessages = (input: OrchestrationGetThreadTailDetailsInput) =>
    listThreadTailMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadTailDetails:listTailMessages:query",
          "ProjectionSnapshotQuery.getThreadTailDetails:listTailMessages:decodeRows",
        ),
      ),
      Effect.map((rows) => {
        const limit = resolveThreadHistoryMessageLimit(input.messageLimit);
        const hasOlderMessages = rows.length > limit;
        const tailRows = rows.slice(0, limit).toReversed().map(toProjectionThreadMessageRecord);
        return { messages: tailRows, hasOlderMessages };
      }),
    );

  const readThreadHistoryMessages = (input: OrchestrationGetThreadHistoryPageInput) =>
    input.beforeMessageCursor === null
      ? Effect.succeed({
          messages: [] as ReadonlyArray<ProjectionThreadMessage>,
          hasOlderMessages: false,
        })
      : listThreadHistoryMessageRows(input).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadHistoryPage:listHistoryMessages:query",
              "ProjectionSnapshotQuery.getThreadHistoryPage:listHistoryMessages:decodeRows",
            ),
          ),
          Effect.map((rows) => {
            const limit = resolveThreadHistoryMessageLimit(input.messageLimit);
            const hasOlderMessages = rows.length > limit;
            const pageRows = rows.slice(0, limit).toReversed().map(toProjectionThreadMessageRecord);
            return { messages: pageRows, hasOlderMessages };
          }),
        );

  const readThreadTailCheckpoints = (input: OrchestrationGetThreadTailDetailsInput) =>
    listThreadTailCheckpointRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadTailDetails:listTailCheckpoints:query",
          "ProjectionSnapshotQuery.getThreadTailDetails:listTailCheckpoints:decodeRows",
        ),
      ),
      Effect.map((rows) => {
        const limit = resolveThreadHistoryCheckpointLimit(input.checkpointLimit);
        const hasOlderCheckpoints = rows.length > limit;
        const tailRows = rows.slice(0, limit).toReversed().map(toProjectionCheckpointRecord);
        return { checkpoints: tailRows, hasOlderCheckpoints };
      }),
    );

  const readThreadHistoryCheckpoints = (input: OrchestrationGetThreadHistoryPageInput) =>
    input.beforeCheckpointTurnCount === null
      ? Effect.succeed({
          checkpoints: [] as ReadonlyArray<ProjectionCheckpoint>,
          hasOlderCheckpoints: false,
        })
      : listThreadHistoryCheckpointRows(input).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadHistoryPage:listHistoryCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadHistoryPage:listHistoryCheckpoints:decodeRows",
            ),
          ),
          Effect.map((rows) => {
            const limit = resolveThreadHistoryCheckpointLimit(input.checkpointLimit);
            const hasOlderCheckpoints = rows.length > limit;
            const pageRows = rows.slice(0, limit).toReversed().map(toProjectionCheckpointRecord);
            return { checkpoints: pageRows, hasOlderCheckpoints };
          }),
        );

  const readThreadTailCommandExecutions = (input: OrchestrationGetThreadTailDetailsInput) =>
    listThreadTailCommandExecutionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadTailDetails:listTailCommandExecutions:query",
          "ProjectionSnapshotQuery.getThreadTailDetails:listTailCommandExecutions:decodeRows",
        ),
      ),
      Effect.map((rows) => {
        const limit = DEFAULT_THREAD_TAIL_COMMAND_EXECUTION_LIMIT;
        const hasOlderCommandExecutions = rows.length > limit;
        const tailRows = rows
          .slice(0, limit)
          .toReversed()
          .map(toProjectionThreadCommandExecutionSummaryRecord);
        return { commandExecutions: tailRows, hasOlderCommandExecutions };
      }),
    );

  const readThreadActivities = (input: { readonly threadId: OrchestrationThread["id"] }) =>
    projectionThreadActivityRepository.listByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionSnapshotQuery.getThreadTailDetails:listThreadActivities"),
      ),
      Effect.map((rows) =>
        rows.map((row) =>
          toReadModelActivity({
            ...row,
            sequence: row.sequence ?? null,
          }),
        ),
      ),
    );

  const readThreadHistoryCommandExecutions = (input: OrchestrationGetThreadHistoryPageInput) =>
    input.beforeCommandExecutionCursor === null
      ? Effect.succeed({
          commandExecutions: [] as ReadonlyArray<OrchestrationCommandExecutionSummary>,
          hasOlderCommandExecutions: false,
        })
      : listThreadHistoryCommandExecutionRows(input).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadHistoryPage:listHistoryCommandExecutions:query",
              "ProjectionSnapshotQuery.getThreadHistoryPage:listHistoryCommandExecutions:decodeRows",
            ),
          ),
          Effect.map((rows) => {
            const limit = resolveThreadHistoryCommandExecutionLimit(input.commandExecutionLimit);
            const hasOlderCommandExecutions = rows.length > limit;
            const pageRows = rows
              .slice(0, limit)
              .toReversed()
              .map(toProjectionThreadCommandExecutionSummaryRecord);
            return { commandExecutions: pageRows, hasOlderCommandExecutions };
          }),
        );

  const listPlanningWorkflowRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionPlanningWorkflowDbRowSchema,
    execute: () =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_planning_workflows
        ORDER BY updated_at DESC, workflow_id DESC
      `,
  });

  const listCodeReviewWorkflowRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCodeReviewWorkflowDbRowSchema,
    execute: () =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_code_review_workflows
        ORDER BY updated_at DESC, workflow_id DESC
      `,
  });

  // Read-model queries intentionally avoid long-lived SQL transactions and
  // eager fan-out because the desktop sqlite client serves requests through a
  // single-permit semaphore. Holding that permit for an entire snapshot, or
  // queueing every statement up front, can starve tiny thread-open reads
  // behind heavyweight full-snapshot fetches.
  const readSnapshotQueries = (params: {
    readonly scope: SnapshotScope;
    readonly historyLoadMode: SnapshotHistoryLoadMode;
    readonly includeMessages: boolean;
    readonly includeCheckpoints: boolean;
    readonly includeActivities: boolean;
    readonly includeDetailFields: boolean;
  }) =>
    Effect.gen(function* () {
      const stateRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listProjectionState",
        effect: listProjectionStateRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listProjectionState:query`,
              `ProjectionSnapshotQuery.${params.scope}:listProjectionState:decodeRows`,
            ),
          ),
        ),
      });
      const projectRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listProjects",
        effect: listProjectRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listProjects:query`,
              `ProjectionSnapshotQuery.${params.scope}:listProjects:decodeRows`,
            ),
          ),
        ),
      });
      const projectMemoryRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listProjectMemories",
        effect: listProjectMemoryRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listProjectMemories:query`,
              `ProjectionSnapshotQuery.${params.scope}:listProjectMemories:decodeRows`,
            ),
          ),
        ),
      });
      const projectSkillRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listProjectSkills",
        effect: listProjectSkillRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listProjectSkills:query`,
              `ProjectionSnapshotQuery.${params.scope}:listProjectSkills:decodeRows`,
            ),
          ),
        ),
      });
      const planningWorkflowRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listPlanningWorkflows",
        effect: listPlanningWorkflowRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listPlanningWorkflows:query`,
              `ProjectionSnapshotQuery.${params.scope}:listPlanningWorkflows:decodeRows`,
            ),
          ),
        ),
      });
      const codeReviewWorkflowRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listCodeReviewWorkflows",
        effect: listCodeReviewWorkflowRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listCodeReviewWorkflows:query`,
              `ProjectionSnapshotQuery.${params.scope}:listCodeReviewWorkflows:decodeRows`,
            ),
          ),
        ),
      });
      const threadRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listThreads",
        effect: (params.includeDetailFields
          ? listThreadRows(undefined)
          : listThreadSummaryRows(undefined)
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listThreads:query`,
              `ProjectionSnapshotQuery.${params.scope}:listThreads:decodeRows`,
            ),
          ),
        ),
      });
      const messageRows = params.includeMessages
        ? yield* withTimedLog({
            kind: "query",
            scope: params.scope,
            name: "listThreadMessages",
            effect: (params.historyLoadMode === "retained"
              ? listRetainedThreadMessageRows(undefined)
              : listThreadMessageRows(undefined)
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  `ProjectionSnapshotQuery.${params.scope}:listThreadMessages:query`,
                  `ProjectionSnapshotQuery.${params.scope}:listThreadMessages:decodeRows`,
                ),
              ),
            ),
          })
        : ([] as ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>>);
      const proposedPlanRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listThreadProposedPlans",
        effect: (params.historyLoadMode === "retained"
          ? listRetainedThreadProposedPlanRows(undefined)
          : listThreadProposedPlanRows(undefined)
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listThreadProposedPlans:query`,
              `ProjectionSnapshotQuery.${params.scope}:listThreadProposedPlans:decodeRows`,
            ),
          ),
        ),
      });
      const activityRows = params.includeActivities
        ? yield* withTimedLog({
            kind: "query",
            scope: params.scope,
            name: "listThreadActivities",
            effect: (params.historyLoadMode === "retained"
              ? listRetainedThreadActivityRows(undefined)
              : listThreadActivityRows(undefined)
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  `ProjectionSnapshotQuery.${params.scope}:listThreadActivities:query`,
                  `ProjectionSnapshotQuery.${params.scope}:listThreadActivities:decodeRows`,
                ),
              ),
            ),
          })
        : ([] as ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>>);
      const sessionRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listThreadSessions",
        effect: listThreadSessionRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listThreadSessions:query`,
              `ProjectionSnapshotQuery.${params.scope}:listThreadSessions:decodeRows`,
            ),
          ),
        ),
      });
      const checkpointRows = params.includeCheckpoints
        ? yield* withTimedLog({
            kind: "query",
            scope: params.scope,
            name: "listCheckpoints",
            effect: (params.historyLoadMode === "retained"
              ? listRetainedCheckpointRows(undefined)
              : listCheckpointRows(undefined)
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  `ProjectionSnapshotQuery.${params.scope}:listCheckpoints:query`,
                  `ProjectionSnapshotQuery.${params.scope}:listCheckpoints:decodeRows`,
                ),
              ),
            ),
          })
        : ([] as ReadonlyArray<Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>>);
      const latestTurnRows = yield* withTimedLog({
        kind: "query",
        scope: params.scope,
        name: "listLatestTurns",
        effect: listLatestTurnRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `ProjectionSnapshotQuery.${params.scope}:listLatestTurns:query`,
              `ProjectionSnapshotQuery.${params.scope}:listLatestTurns:decodeRows`,
            ),
          ),
        ),
      });

      const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
      const memoriesByProject = new Map<string, Array<ProjectMemory>>();
      const skillsByProject = new Map<string, Array<ProjectSkill>>();
      const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
      const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
      const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
      const sessionsByThread = new Map<string, OrchestrationSession>();
      const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

      let updatedAt: string | null = null;

      for (const row of projectRows) {
        updatedAt = maxIso(updatedAt, row.updatedAt);
      }
      for (const row of projectMemoryRows) {
        updatedAt = maxIso(updatedAt, row.updatedAt);
        const projectMemories = memoriesByProject.get(row.projectId) ?? [];
        projectMemories.push({
          id: row.memoryId,
          projectId: row.projectId,
          scope: row.scope,
          type: row.type,
          name: row.name,
          description: row.description,
          body: row.body,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt,
        });
        memoriesByProject.set(row.projectId, projectMemories);
      }
      for (const row of projectSkillRows) {
        updatedAt = maxIso(updatedAt, row.updatedAt);
        const projectSkills = skillsByProject.get(row.projectId) ?? [];
        projectSkills.push({
          id: row.id,
          projectId: row.projectId,
          scope: row.scope,
          commandName: row.commandName,
          displayName: row.displayName,
          description: row.description,
          argumentHint: row.argumentHint,
          allowedTools: row.allowedTools,
          paths: row.paths,
          updatedAt: row.updatedAt,
        });
        skillsByProject.set(row.projectId, projectSkills);
      }
      for (const row of planningWorkflowRows) {
        updatedAt = maxIso(updatedAt, row.workflow.updatedAt);
      }
      for (const row of codeReviewWorkflowRows) {
        updatedAt = maxIso(updatedAt, row.workflow.updatedAt);
      }
      for (const row of threadRows) {
        updatedAt = maxIso(updatedAt, row.updatedAt);
      }
      for (const row of stateRows) {
        updatedAt = maxIso(updatedAt, row.updatedAt);
      }
      for (const row of messageRows) {
        updatedAt = maxIso(updatedAt, row.updatedAt);
        const threadMessages = messagesByThread.get(row.threadId) ?? [];
        threadMessages.push(toReadModelMessage(row));
        messagesByThread.set(row.threadId, threadMessages);
      }
      for (const row of proposedPlanRows) {
        updatedAt = maxIso(updatedAt, row.updatedAt);
        const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
        threadProposedPlans.push({
          id: row.planId,
          turnId: row.turnId,
          planMarkdown: row.planMarkdown,
          implementedAt: row.implementedAt,
          implementationThreadId: row.implementationThreadId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
        proposedPlansByThread.set(row.threadId, threadProposedPlans);
      }
      for (const row of activityRows) {
        updatedAt = maxIso(updatedAt, row.createdAt);
        const threadActivities = activitiesByThread.get(row.threadId) ?? [];
        threadActivities.push(toReadModelActivity(row));
        activitiesByThread.set(row.threadId, threadActivities);
      }
      for (const row of checkpointRows) {
        updatedAt = maxIso(updatedAt, row.completedAt);
        const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
        threadCheckpoints.push(toReadModelCheckpoint(row));
        checkpointsByThread.set(row.threadId, threadCheckpoints);
      }
      for (const row of latestTurnRows) {
        updatedAt = maxIso(updatedAt, row.requestedAt);
        if (row.startedAt !== null) {
          updatedAt = maxIso(updatedAt, row.startedAt);
        }
        if (row.completedAt !== null) {
          updatedAt = maxIso(updatedAt, row.completedAt);
        }
        if (latestTurnByThread.has(row.threadId)) {
          continue;
        }
        latestTurnByThread.set(row.threadId, {
          turnId: row.turnId,
          state:
            row.state === "error"
              ? "error"
              : row.state === "interrupted"
                ? "interrupted"
                : row.state === "completed"
                  ? "completed"
                  : "running",
          requestedAt: row.requestedAt,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          assistantMessageId: row.assistantMessageId,
        });
      }
      for (const row of sessionRows) {
        updatedAt = maxIso(updatedAt, row.updatedAt);
        sessionsByThread.set(row.threadId, {
          threadId: row.threadId,
          status: row.status,
          providerName: row.providerName,
          runtimeMode: row.runtimeMode,
          activeTurnId: row.activeTurnId,
          lastError: row.lastError,
          ...(row.estimatedContextTokens !== null
            ? { estimatedContextTokens: row.estimatedContextTokens }
            : {}),
          ...(row.tokenUsageSource !== null ? { tokenUsageSource: row.tokenUsageSource } : {}),
          updatedAt: row.updatedAt,
        });
      }

      const planningWorkflows = planningWorkflowRows.map((row) => row.workflow);
      const codeReviewWorkflows = codeReviewWorkflowRows.map((row) => row.workflow);
      const threads = threadRows.map((row) =>
        buildThreadSnapshot({
          row,
          latestTurnByThread,
          sessionsByThread,
          messagesByThread,
          proposedPlansByThread,
          activitiesByThread,
          checkpointsByThread,
          includeDetailFields: params.includeDetailFields,
        }),
      );
      const unsortedProjects: Array<OrchestrationProject> = projectRows.map((row) => ({
        id: row.projectId,
        title: row.title,
        workspaceRoot: row.workspaceRoot,
        defaultModel: row.defaultModel,
        scripts: row.scripts,
        memories: memoriesByProject.get(row.projectId) ?? [],
        skills: skillsByProject.get(row.projectId) ?? [],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
      }));
      const projects = sortProjectsByVisibleThreadActivity(
        unsortedProjects,
        threads,
        planningWorkflows,
        codeReviewWorkflows,
      );

      return yield* decodeReadModel({
        snapshotSequence: computeSnapshotSequence(stateRows),
        projects,
        planningWorkflows,
        codeReviewWorkflows,
        threads,
        updatedAt: updatedAt ?? new Date(0).toISOString(),
      }).pipe(
        Effect.mapError(
          toPersistenceDecodeError(`ProjectionSnapshotQuery.${params.scope}:decodeReadModel`),
        ),
      );
    });

  const readSnapshot = (params: {
    readonly scope: SnapshotScope;
    readonly historyLoadMode: SnapshotHistoryLoadMode;
    readonly includeMessages: boolean;
    readonly includeCheckpoints: boolean;
    readonly includeActivities: boolean;
    readonly includeDetailFields: boolean;
  }) =>
    readSnapshotQueries(params).pipe(
      Effect.mapError((error) => {
        if (isPersistenceError(error)) {
          return error;
        }
        return toPersistenceSqlError(`ProjectionSnapshotQuery.${params.scope}:query`)(error);
      }),
    );

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    withTimedLog({
      kind: "request",
      scope: "getSnapshot",
      name: "total",
      effect: readSnapshot({
        scope: "getSnapshot",
        historyLoadMode: "full",
        includeMessages: true,
        includeCheckpoints: true,
        includeActivities: true,
        includeDetailFields: true,
      }),
    });

  const getBootstrapSnapshot: ProjectionSnapshotQueryShape["getBootstrapSnapshot"] = () =>
    withTimedLog({
      kind: "request",
      scope: "getBootstrapSnapshot",
      name: "total",
      effect: readSnapshot({
        scope: "getBootstrapSnapshot",
        historyLoadMode: "retained",
        includeMessages: true,
        includeCheckpoints: true,
        includeActivities: true,
        includeDetailFields: true,
      }),
    });

  const getStartupSnapshot: ProjectionSnapshotQueryShape["getStartupSnapshot"] = (input) =>
    withTimedLog({
      kind: "request",
      scope: "getStartupSnapshot",
      name: "total",
      effect: Effect.gen(function* () {
        const snapshot = yield* readSnapshotQueries({
          scope: "getStartupSnapshot",
          historyLoadMode: "full",
          includeMessages: false,
          includeCheckpoints: false,
          includeActivities: false,
          includeDetailFields: false,
        });

        const detailThreadId = input?.detailThreadId;
        if (!detailThreadId) {
          return {
            snapshot,
            threadTailDetails: null,
          } satisfies OrchestrationGetStartupSnapshotResult;
        }

        const threadOption = yield* withTimedLog({
          kind: "query",
          scope: "getStartupSnapshot",
          name: "getThreadById",
          effect: projectionThreadRepository.getById({ threadId: detailThreadId }),
        });
        const messageResult = yield* withTimedLog({
          kind: "query",
          scope: "getStartupSnapshot",
          name: "listThreadTailMessagesById",
          effect: readThreadTailMessages({
            threadId: detailThreadId,
          }),
        });
        const checkpointResult = yield* withTimedLog({
          kind: "query",
          scope: "getStartupSnapshot",
          name: "listTailCheckpointsById",
          effect: readThreadTailCheckpoints({
            threadId: detailThreadId,
          }),
        });
        const commandExecutionResult = yield* withTimedLog({
          kind: "query",
          scope: "getStartupSnapshot",
          name: "listTailCommandExecutionsById",
          effect: readThreadTailCommandExecutions({
            threadId: detailThreadId,
          }),
        });
        const activities = yield* withTimedLog({
          kind: "query",
          scope: "getStartupSnapshot",
          name: "listThreadActivitiesById",
          effect: readThreadActivities({
            threadId: detailThreadId,
          }),
        });

        const thread = Option.match(threadOption, {
          onNone: () => null,
          onSome: (value) => value,
        });

        if (thread === null) {
          return {
            snapshot,
            threadTailDetails: null,
          } satisfies OrchestrationGetStartupSnapshotResult;
        }

        const threadTailDetails = yield* buildThreadTailDetailsResult({
          scope: "getStartupSnapshot",
          threadId: detailThreadId,
          thread,
          messages: messageResult.messages,
          checkpoints: checkpointResult.checkpoints,
          activities,
          commandExecutions: commandExecutionResult.commandExecutions,
          hasOlderMessages: messageResult.hasOlderMessages,
          hasOlderCheckpoints: checkpointResult.hasOlderCheckpoints,
          hasOlderCommandExecutions: commandExecutionResult.hasOlderCommandExecutions,
          detailSequence: snapshot.snapshotSequence,
        });

        return {
          snapshot,
          threadTailDetails,
        } satisfies OrchestrationGetStartupSnapshotResult;
      }).pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getStartupSnapshot:query")(error);
        }),
      ),
    });

  const getThreadTailDetails: ProjectionSnapshotQueryShape["getThreadTailDetails"] = (input) =>
    withTimedLog({
      kind: "request",
      scope: "getThreadTailDetails",
      name: "total",
      effect: Effect.gen(function* () {
        const detailSequence = yield* withTimedLog({
          kind: "query",
          scope: "getThreadTailDetails",
          name: "minProjectionSequence",
          effect: projectionStateRepository.minLastAppliedSequence(),
        });
        const threadOption = yield* withTimedLog({
          kind: "query",
          scope: "getThreadTailDetails",
          name: "getThreadById",
          effect: projectionThreadRepository.getById({ threadId: input.threadId }),
        });
        const messageResult = yield* withTimedLog({
          kind: "query",
          scope: "getThreadTailDetails",
          name: "listTailMessages",
          effect: readThreadTailMessages(input),
        });
        const checkpointResult = yield* withTimedLog({
          kind: "query",
          scope: "getThreadTailDetails",
          name: "listTailCheckpoints",
          effect: readThreadTailCheckpoints(input),
        });
        const commandExecutionResult = yield* withTimedLog({
          kind: "query",
          scope: "getThreadTailDetails",
          name: "listTailCommandExecutions",
          effect: readThreadTailCommandExecutions(input),
        });
        const activities = yield* withTimedLog({
          kind: "query",
          scope: "getThreadTailDetails",
          name: "listThreadActivities",
          effect: readThreadActivities({
            threadId: input.threadId,
          }),
        });

        const thread = Option.match(threadOption, {
          onNone: () => null,
          onSome: (value) => value,
        });

        return yield* buildThreadTailDetailsResult({
          scope: "getThreadTailDetails",
          threadId: input.threadId,
          thread,
          messages: thread === null ? [] : messageResult.messages,
          checkpoints: thread === null ? [] : checkpointResult.checkpoints,
          activities: thread === null ? [] : activities,
          commandExecutions: thread === null ? [] : commandExecutionResult.commandExecutions,
          hasOlderMessages: thread !== null && messageResult.hasOlderMessages,
          hasOlderCheckpoints: thread !== null && checkpointResult.hasOlderCheckpoints,
          hasOlderCommandExecutions:
            thread !== null && commandExecutionResult.hasOlderCommandExecutions,
          detailSequence: detailSequence ?? 0,
        });
      }).pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadTailDetails:query")(error);
        }),
      ),
    });

  const getThreadHistoryPage: ProjectionSnapshotQueryShape["getThreadHistoryPage"] = (input) =>
    withTimedLog({
      kind: "request",
      scope: "getThreadHistoryPage",
      name: "total",
      effect: Effect.gen(function* () {
        const detailSequence = yield* withTimedLog({
          kind: "query",
          scope: "getThreadHistoryPage",
          name: "minProjectionSequence",
          effect: projectionStateRepository.minLastAppliedSequence(),
        });
        const threadOption = yield* withTimedLog({
          kind: "query",
          scope: "getThreadHistoryPage",
          name: "getThreadById",
          effect: projectionThreadRepository.getById({ threadId: input.threadId }),
        });
        const messageResult = yield* withTimedLog({
          kind: "query",
          scope: "getThreadHistoryPage",
          name: "listHistoryMessages",
          effect: readThreadHistoryMessages(input),
        });
        const checkpointResult = yield* withTimedLog({
          kind: "query",
          scope: "getThreadHistoryPage",
          name: "listHistoryCheckpoints",
          effect: readThreadHistoryCheckpoints(input),
        });
        const commandExecutionResult = yield* withTimedLog({
          kind: "query",
          scope: "getThreadHistoryPage",
          name: "listHistoryCommandExecutions",
          effect: readThreadHistoryCommandExecutions(input),
        });

        const threadExists = Option.isSome(threadOption);
        return yield* buildThreadHistoryPageResult({
          threadId: input.threadId,
          messages: threadExists ? messageResult.messages : [],
          checkpoints: threadExists ? checkpointResult.checkpoints : [],
          commandExecutions: threadExists ? commandExecutionResult.commandExecutions : [],
          hasOlderMessages: threadExists && messageResult.hasOlderMessages,
          hasOlderCheckpoints: threadExists && checkpointResult.hasOlderCheckpoints,
          hasOlderCommandExecutions:
            threadExists && commandExecutionResult.hasOlderCommandExecutions,
          detailSequence: detailSequence ?? 0,
        });
      }).pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadHistoryPage:query")(error);
        }),
      ),
    });

  const getThreadDetails: ProjectionSnapshotQueryShape["getThreadDetails"] = (input) =>
    withTimedLog({
      kind: "request",
      scope: "getThreadDetails",
      name: "total",
      effect: Effect.gen(function* () {
        const detailSequence = yield* withTimedLog({
          kind: "query",
          scope: "getThreadDetails",
          name: "minProjectionSequence",
          effect: projectionStateRepository.minLastAppliedSequence(),
        });
        const threadOption = yield* withTimedLog({
          kind: "query",
          scope: "getThreadDetails",
          name: "getThreadById",
          effect: projectionThreadRepository.getById(input),
        });
        const messages = yield* withTimedLog({
          kind: "query",
          scope: "getThreadDetails",
          name: "listThreadMessages",
          effect: projectionThreadMessageRepository.listByThreadId(input),
        });
        const checkpoints = yield* withTimedLog({
          kind: "query",
          scope: "getThreadDetails",
          name: "listCheckpoints",
          effect: projectionCheckpointRepository.listByThreadId(input),
        });

        const thread = Option.match(threadOption, {
          onNone: () => null,
          onSome: (value) => value,
        });

        return yield* buildThreadDetailsResult({
          scope: "getThreadDetails",
          threadId: input.threadId,
          thread,
          messages,
          checkpoints,
          detailSequence: detailSequence ?? 0,
        });
      }).pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetails:query")(error);
        }),
      ),
    });

  return {
    getSnapshot,
    getBootstrapSnapshot,
    getStartupSnapshot,
    getThreadTailDetails,
    getThreadHistoryPage,
    getThreadDetails,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
).pipe(
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionCheckpointRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
