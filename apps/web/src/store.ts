import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadHistoryPage,
  type OrchestrationReadModel,
  type OrchestrationThreadTailDetails,
  type ProjectSkill,
  type ThreadReference,
  type ThreadSessionNotes,
} from "@t3tools/contracts";
import { resolveModelSlug } from "@t3tools/shared/model";
import { create } from "zustand";
import {
  type ChatMessage,
  type CodeReviewWorkflow,
  type PlanningWorkflow,
  type Project,
  type Thread,
  type ThreadHistoryState,
  type TurnDiffSummary,
} from "./types";
import { Debouncer } from "@tanstack/react-pacer";
import { applyDomainEvent } from "./applyDomainEvent";
import {
  areUnknownEqual,
  arraysShallowEqual,
  mapMessageAttachmentsFromReadModel,
  mapSessionFromReadModel,
  resolveThreadModel,
} from "./orchestrationState";
import { sanitizeThreadErrorMessage } from "./transportError";
import { createEmptyThreadHistoryState, ensureThreadHistoryState } from "./lib/threadHistory";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  planningWorkflows: PlanningWorkflow[];
  codeReviewWorkflows: CodeReviewWorkflow[];
  threadsHydrated: boolean;
  lastAppliedSequence: number;
  detailEventBufferByThreadId: Map<ThreadId, ThreadDetailEventBuffer>;
  /**
   * Per-thread flag for whether the "Changed files" directory tree is expanded
   * in the messages timeline. Defaults to `true` (expanded) when an entry is
   * missing, so the persisted payload only needs to record explicit `false`s.
   */
  changedFilesExpandedByThreadId: Record<ThreadId, boolean>;
}

const PERSISTED_STATE_KEY = "t3code:renderer-state:v8";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

function createInitialState(): AppState {
  return {
    projects: [],
    threads: [],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threadsHydrated: false,
    lastAppliedSequence: 0,
    detailEventBufferByThreadId: new Map(),
    changedFilesExpandedByThreadId: { ...persistedChangedFilesExpandedByThreadId },
  };
}

const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const persistedChangedFilesExpandedByThreadId: Record<string, boolean> = {};

interface ThreadDetailEventBuffer {
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly retainers: number;
}

// ── Persist helpers ──────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return createInitialState();
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw) as {
      expandedProjectCwds?: string[];
      projectOrderCwds?: string[];
      changedFilesExpandedByThreadId?: Record<string, boolean>;
    };
    persistedExpandedProjectCwds.clear();
    persistedProjectOrderCwds.length = 0;
    for (const key of Object.keys(persistedChangedFilesExpandedByThreadId)) {
      delete persistedChangedFilesExpandedByThreadId[key];
    }
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(cwd);
      }
    }
    for (const cwd of parsed.projectOrderCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
        persistedProjectOrderCwds.push(cwd);
      }
    }
    const persistedChangedFiles = parsed.changedFilesExpandedByThreadId;
    if (persistedChangedFiles && typeof persistedChangedFiles === "object") {
      for (const [threadId, expanded] of Object.entries(persistedChangedFiles)) {
        if (typeof threadId === "string" && threadId.length > 0 && expanded === false) {
          persistedChangedFilesExpandedByThreadId[threadId] = false;
        }
      }
    }
    return createInitialState();
  } catch {
    return createInitialState();
  }
}

let legacyKeysCleanedUp = false;

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    const changedFilesExpandedByThreadId: Record<string, boolean> = {};
    for (const [threadId, expanded] of Object.entries(state.changedFilesExpandedByThreadId)) {
      // Default is expanded; only record explicit collapse to keep the payload small.
      if (expanded === false) {
        changedFilesExpandedByThreadId[threadId] = false;
      }
    }
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: state.projects
          .filter((project) => project.expanded)
          .map((project) => project.cwd),
        projectOrderCwds: state.projects.map((project) => project.cwd),
        changedFilesExpandedByThreadId,
      }),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

function mapProjectsFromReadModel(
  incoming: OrchestrationReadModel["projects"],
  previous: Project[],
): Project[] {
  const previousById = new Map(previous.map((project) => [project.id, project] as const));
  const previousByCwd = new Map(previous.map((project) => [project.cwd, project] as const));
  const previousOrderById = new Map(previous.map((project, index) => [project.id, index] as const));
  const previousOrderByCwd = new Map(
    previous.map((project, index) => [project.cwd, index] as const),
  );
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const usePersistedOrder = previous.length === 0;

  const mappedProjects = incoming.map((project) => {
    const existing = previousById.get(project.id) ?? previousByCwd.get(project.workspaceRoot);
    const skills = mapProjectSkillsFromReadModel(project.skills ?? [], existing?.skills);
    return {
      id: project.id,
      name: project.title,
      cwd: project.workspaceRoot,
      model:
        existing?.model ??
        resolveModelSlug(project.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.codex),
      createdAt: project.createdAt,
      expanded:
        existing?.expanded ??
        (persistedExpandedProjectCwds.size > 0
          ? persistedExpandedProjectCwds.has(project.workspaceRoot)
          : true),
      scripts: project.scripts.map((script) => ({ ...script })),
      memories: (project.memories ?? []).filter((memory) => memory.deletedAt === null),
      skills,
    } satisfies Project;
  });

  return mappedProjects
    .map((project, incomingIndex) => {
      const previousIndex =
        previousOrderById.get(project.id) ?? previousOrderByCwd.get(project.cwd);
      const persistedIndex = usePersistedOrder ? persistedOrderByCwd.get(project.cwd) : undefined;
      const orderIndex =
        previousIndex ??
        persistedIndex ??
        (usePersistedOrder ? persistedProjectOrderCwds.length : previous.length) + incomingIndex;
      return { project, incomingIndex, orderIndex };
    })
    .toSorted((a, b) => {
      const byOrder = a.orderIndex - b.orderIndex;
      if (byOrder !== 0) return byOrder;
      return a.incomingIndex - b.incomingIndex;
    })
    .map((entry) => entry.project);
}

function mapMessagesFromReadModel(
  incoming: OrchestrationReadModel["threads"][number]["messages"],
  previous: Thread["messages"],
): Thread["messages"] {
  const previousById = new Map(previous.map((message) => [message.id, message] as const));
  let reusedAll = incoming.length === previous.length;

  const next = incoming.map((message) => {
    const existing = previousById.get(message.id);
    const attachments = mapMessageAttachmentsFromReadModel(
      message.attachments,
      existing?.attachments,
    );
    const completedAt = message.streaming ? undefined : message.updatedAt;
    if (
      existing &&
      existing.role === message.role &&
      existing.text === message.text &&
      existing.reasoningText === message.reasoningText &&
      (existing.turnId ?? null) === message.turnId &&
      existing.createdAt === message.createdAt &&
      existing.streaming === message.streaming &&
      existing.completedAt === completedAt &&
      existing.attachments === attachments
    ) {
      return existing;
    }
    reusedAll = false;
    return {
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.reasoningText !== undefined ? { reasoningText: message.reasoningText } : {}),
      ...(message.turnId !== null ? { turnId: message.turnId } : {}),
      createdAt: message.createdAt,
      streaming: message.streaming,
      ...(completedAt ? { completedAt } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    } satisfies ChatMessage;
  });

  return reusedAll && arraysShallowEqual(next, previous) ? previous : next;
}

function mapProposedPlansFromReadModel(
  incoming: OrchestrationReadModel["threads"][number]["proposedPlans"],
  previous: Thread["proposedPlans"],
): Thread["proposedPlans"] {
  const previousById = new Map(previous.map((plan) => [plan.id, plan] as const));
  let reusedAll = incoming.length === previous.length;

  const next = incoming.map((proposedPlan) => {
    const existing = previousById.get(proposedPlan.id);
    if (
      existing &&
      existing.turnId === proposedPlan.turnId &&
      existing.planMarkdown === proposedPlan.planMarkdown &&
      existing.implementedAt === proposedPlan.implementedAt &&
      existing.implementationThreadId === proposedPlan.implementationThreadId &&
      existing.createdAt === proposedPlan.createdAt &&
      existing.updatedAt === proposedPlan.updatedAt
    ) {
      return existing;
    }
    reusedAll = false;
    return {
      id: proposedPlan.id,
      turnId: proposedPlan.turnId,
      planMarkdown: proposedPlan.planMarkdown,
      implementedAt: proposedPlan.implementedAt,
      implementationThreadId: proposedPlan.implementationThreadId,
      createdAt: proposedPlan.createdAt,
      updatedAt: proposedPlan.updatedAt,
    };
  });

  return reusedAll && arraysShallowEqual(next, previous) ? previous : next;
}

function mapCheckpointFilesFromReadModel(
  incoming: OrchestrationReadModel["threads"][number]["checkpoints"][number]["files"],
  previous: TurnDiffSummary["files"],
): TurnDiffSummary["files"] {
  if (
    incoming.length === previous.length &&
    incoming.every((file, index) => {
      const existing = previous[index];
      return (
        existing !== undefined &&
        existing.path === file.path &&
        existing.kind === file.kind &&
        existing.additions === file.additions &&
        existing.deletions === file.deletions
      );
    })
  ) {
    return previous;
  }

  return incoming.map((file) => ({ ...file }));
}

function mapTurnDiffSummariesFromReadModel(
  incoming: OrchestrationReadModel["threads"][number]["checkpoints"],
  previous: Thread["turnDiffSummaries"],
): Thread["turnDiffSummaries"] {
  const previousByTurnId = new Map(previous.map((summary) => [summary.turnId, summary] as const));
  let reusedAll = incoming.length === previous.length;

  const next = incoming.map((checkpoint) => {
    const existing = previousByTurnId.get(checkpoint.turnId);
    const files = mapCheckpointFilesFromReadModel(checkpoint.files, existing?.files ?? []);
    if (
      existing &&
      existing.completedAt === checkpoint.completedAt &&
      existing.status === checkpoint.status &&
      existing.assistantMessageId === (checkpoint.assistantMessageId ?? undefined) &&
      existing.checkpointTurnCount === checkpoint.checkpointTurnCount &&
      existing.checkpointRef === checkpoint.checkpointRef &&
      existing.files === files
    ) {
      return existing;
    }
    reusedAll = false;
    return {
      turnId: checkpoint.turnId,
      completedAt: checkpoint.completedAt,
      status: checkpoint.status,
      assistantMessageId: checkpoint.assistantMessageId ?? undefined,
      checkpointTurnCount: checkpoint.checkpointTurnCount,
      checkpointRef: checkpoint.checkpointRef,
      files,
    };
  });

  return reusedAll && arraysShallowEqual(next, previous) ? previous : next;
}

function mapActivitiesFromReadModel(
  incoming: OrchestrationReadModel["threads"][number]["activities"],
  previous: Thread["activities"],
): Thread["activities"] {
  const previousById = new Map(previous.map((activity) => [activity.id, activity] as const));
  let reusedAll = incoming.length === previous.length;

  const next = incoming.map((activity) => {
    const existing = previousById.get(activity.id);
    if (
      existing &&
      existing.tone === activity.tone &&
      existing.kind === activity.kind &&
      existing.summary === activity.summary &&
      existing.turnId === activity.turnId &&
      existing.sequence === activity.sequence &&
      existing.createdAt === activity.createdAt &&
      areUnknownEqual(existing.payload, activity.payload)
    ) {
      return existing;
    }
    reusedAll = false;
    return { ...activity };
  });

  return reusedAll && arraysShallowEqual(next, previous) ? previous : next;
}

function mapCommandExecutionsFromReadModel(
  incoming: OrchestrationThreadTailDetails["commandExecutions"],
  previous: Thread["commandExecutions"],
): Thread["commandExecutions"] {
  const previousById = new Map(previous.map((execution) => [execution.id, execution] as const));
  let reusedAll = incoming.length === previous.length;

  const next = incoming.map((execution) => {
    const existing = previousById.get(execution.id);
    if (
      existing &&
      existing.turnId === execution.turnId &&
      existing.providerItemId === execution.providerItemId &&
      existing.command === execution.command &&
      (existing.cwd ?? undefined) === execution.cwd &&
      existing.title === execution.title &&
      existing.status === execution.status &&
      existing.detail === execution.detail &&
      existing.exitCode === execution.exitCode &&
      existing.startedAt === execution.startedAt &&
      existing.completedAt === execution.completedAt &&
      existing.updatedAt === execution.updatedAt &&
      existing.startedSequence === execution.startedSequence &&
      existing.lastUpdatedSequence === execution.lastUpdatedSequence
    ) {
      return existing;
    }
    reusedAll = false;
    return execution.cwd !== undefined ? { ...execution } : { ...execution, cwd: undefined };
  });

  return reusedAll && arraysShallowEqual(next, previous) ? previous : next;
}

function mapTasksFromReadModel(
  incoming: OrchestrationReadModel["threads"][number]["tasks"],
  previous: Thread["tasks"],
): Thread["tasks"] {
  const previousById = new Map(previous.map((task) => [task.id, task] as const));
  let reusedAll = incoming.length === previous.length;

  const next = incoming.map((task) => {
    const existing = previousById.get(task.id);
    if (
      existing &&
      existing.content === task.content &&
      existing.activeForm === task.activeForm &&
      existing.status === task.status
    ) {
      return existing;
    }
    reusedAll = false;
    return { ...task };
  });

  return reusedAll && arraysShallowEqual(next, previous) ? previous : next;
}

function mapProjectSkillsFromReadModel(
  incoming: ReadonlyArray<ProjectSkill>,
  previous: Project["skills"] | undefined,
): ProjectSkill[] {
  if (
    previous &&
    incoming.length === previous.length &&
    incoming.every((skill, index) => areUnknownEqual(skill, previous[index]))
  ) {
    return previous;
  }
  return incoming.map((skill) => ({
    ...skill,
    allowedTools: [...skill.allowedTools],
    paths: [...skill.paths],
  }));
}

function mapThreadSessionNotesFromReadModel(
  incoming: ThreadSessionNotes | null | undefined,
  previous: Thread["sessionNotes"],
): Thread["sessionNotes"] {
  if (incoming === null || incoming === undefined) {
    return null;
  }
  if (previous && areUnknownEqual(previous, incoming)) {
    return previous;
  }
  return { ...incoming };
}

function mapThreadReferencesFromReadModel(
  incoming: ReadonlyArray<ThreadReference> | undefined,
  previous: Thread["threadReferences"],
): ThreadReference[] {
  const nextIncoming = incoming ?? [];
  if (
    previous &&
    nextIncoming.length === previous.length &&
    nextIncoming.every((reference, index) => areUnknownEqual(reference, previous[index]))
  ) {
    return previous;
  }
  return nextIncoming.map((reference) => ({
    threadId: reference.threadId,
    relation: reference.relation,
    createdAt: reference.createdAt,
  }));
}

function mapLatestTurnFromReadModel(
  incoming: OrchestrationReadModel["threads"][number]["latestTurn"],
  previous: Thread["latestTurn"] | null | undefined,
): Thread["latestTurn"] | null {
  if (!incoming) {
    return null;
  }

  if (
    previous &&
    previous.turnId === incoming.turnId &&
    previous.state === incoming.state &&
    previous.requestedAt === incoming.requestedAt &&
    previous.startedAt === incoming.startedAt &&
    previous.completedAt === incoming.completedAt &&
    previous.assistantMessageId === incoming.assistantMessageId
  ) {
    return previous;
  }

  return incoming;
}

type ReadModelThread = OrchestrationReadModel["threads"][number];
type ThreadTailSource = {
  readonly messages: OrchestrationThreadTailDetails["messages"];
  readonly checkpoints: OrchestrationThreadTailDetails["checkpoints"];
  readonly commandExecutions: OrchestrationThreadTailDetails["commandExecutions"];
  readonly tasks: OrchestrationThreadTailDetails["tasks"];
  readonly tasksTurnId: OrchestrationThreadTailDetails["tasksTurnId"];
  readonly tasksUpdatedAt: OrchestrationThreadTailDetails["tasksUpdatedAt"];
  readonly sessionNotes?: OrchestrationThreadTailDetails["sessionNotes"];
  readonly threadReferences?: OrchestrationThreadTailDetails["threadReferences"];
  readonly hasOlderMessages: OrchestrationThreadTailDetails["hasOlderMessages"];
  readonly hasOlderCheckpoints: OrchestrationThreadTailDetails["hasOlderCheckpoints"];
  readonly hasOlderCommandExecutions: OrchestrationThreadTailDetails["hasOlderCommandExecutions"];
  readonly oldestLoadedMessageCursor: OrchestrationThreadTailDetails["oldestLoadedMessageCursor"];
  readonly oldestLoadedCheckpointTurnCount: OrchestrationThreadTailDetails["oldestLoadedCheckpointTurnCount"];
  readonly oldestLoadedCommandExecutionCursor: OrchestrationThreadTailDetails["oldestLoadedCommandExecutionCursor"];
};

function mapThreadHistoryStateFromTail(
  incoming: Pick<
    ThreadTailSource,
    | "hasOlderMessages"
    | "hasOlderCheckpoints"
    | "hasOlderCommandExecutions"
    | "oldestLoadedMessageCursor"
    | "oldestLoadedCheckpointTurnCount"
    | "oldestLoadedCommandExecutionCursor"
  >,
  existing: Thread | undefined,
): ThreadHistoryState {
  const existingHistory = ensureThreadHistoryState(existing?.history);
  const generation = existingHistory.generation + 1;
  const hasOlderMessages = incoming.hasOlderMessages;
  const hasOlderCheckpoints = incoming.hasOlderCheckpoints;
  const hasOlderCommandExecutions = incoming.hasOlderCommandExecutions;
  return {
    stage:
      hasOlderMessages || hasOlderCheckpoints || hasOlderCommandExecutions ? "tail" : "complete",
    hasOlderMessages,
    hasOlderCheckpoints,
    hasOlderCommandExecutions,
    oldestLoadedMessageCursor: incoming.oldestLoadedMessageCursor,
    oldestLoadedCheckpointTurnCount: incoming.oldestLoadedCheckpointTurnCount,
    oldestLoadedCommandExecutionCursor: incoming.oldestLoadedCommandExecutionCursor,
    generation,
  };
}

function preserveThreadDetailFields(
  existing: Thread | undefined,
): Pick<
  Thread,
  | "messages"
  | "commandExecutions"
  | "turnDiffSummaries"
  | "detailsLoaded"
  | "tasks"
  | "tasksTurnId"
  | "tasksUpdatedAt"
  | "sessionNotes"
  | "threadReferences"
  | "history"
> {
  if (existing?.detailsLoaded) {
    return {
      messages: existing.messages,
      commandExecutions: existing.commandExecutions,
      turnDiffSummaries: existing.turnDiffSummaries,
      detailsLoaded: true,
      tasks: existing.tasks,
      tasksTurnId: existing.tasksTurnId,
      tasksUpdatedAt: existing.tasksUpdatedAt,
      sessionNotes: existing.sessionNotes ?? null,
      threadReferences: existing.threadReferences ?? [],
      history: ensureThreadHistoryState(existing.history),
    };
  }

  return {
    messages: [],
    commandExecutions: [],
    turnDiffSummaries: [],
    detailsLoaded: false,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    history: createEmptyThreadHistoryState(ensureThreadHistoryState(existing?.history).generation),
  };
}

function clearThreadDetailFields(
  existing?: Thread,
): Pick<
  Thread,
  | "messages"
  | "commandExecutions"
  | "turnDiffSummaries"
  | "detailsLoaded"
  | "tasks"
  | "tasksTurnId"
  | "tasksUpdatedAt"
  | "sessionNotes"
  | "threadReferences"
  | "history"
> {
  return {
    messages: [],
    commandExecutions: [],
    turnDiffSummaries: [],
    detailsLoaded: false,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    history: createEmptyThreadHistoryState(
      ensureThreadHistoryState(existing?.history).generation + 1,
    ),
  };
}

function compareMessageToCursor(
  message: Pick<Thread["messages"][number], "createdAt" | "id">,
  cursor: NonNullable<ThreadHistoryState["oldestLoadedMessageCursor"]>,
): number {
  return (
    message.createdAt.localeCompare(cursor.createdAt) || message.id.localeCompare(cursor.messageId)
  );
}

function mergeMessagesFromTail(
  incomingMessages: ThreadTailSource["messages"],
  existing: Thread | undefined,
  oldestLoadedMessageCursor: ThreadTailSource["oldestLoadedMessageCursor"],
): { messages: Thread["messages"]; preservedOlderMessages: boolean } {
  const mappedTailMessages = mapMessagesFromReadModel(incomingMessages, existing?.messages ?? []);
  if (!existing?.detailsLoaded || oldestLoadedMessageCursor === null) {
    return { messages: mappedTailMessages, preservedOlderMessages: false };
  }

  const preservedOlderMessages = existing.messages.filter(
    (message) => compareMessageToCursor(message, oldestLoadedMessageCursor) < 0,
  );
  if (preservedOlderMessages.length === 0) {
    return { messages: mappedTailMessages, preservedOlderMessages: false };
  }

  const mergedMessages = [...preservedOlderMessages, ...mappedTailMessages];
  return {
    messages: arraysShallowEqual(mergedMessages, existing.messages)
      ? existing.messages
      : mergedMessages,
    preservedOlderMessages: true,
  };
}

function mergeTurnDiffSummariesFromTail(
  incomingCheckpoints: ThreadTailSource["checkpoints"],
  existing: Thread | undefined,
  oldestLoadedCheckpointTurnCount: ThreadTailSource["oldestLoadedCheckpointTurnCount"],
): { turnDiffSummaries: Thread["turnDiffSummaries"]; preservedOlderCheckpoints: boolean } {
  const mappedTailCheckpoints = mapTurnDiffSummariesFromReadModel(
    incomingCheckpoints,
    existing?.turnDiffSummaries ?? [],
  );
  if (!existing?.detailsLoaded || oldestLoadedCheckpointTurnCount === null) {
    return { turnDiffSummaries: mappedTailCheckpoints, preservedOlderCheckpoints: false };
  }

  const preservedOlderCheckpoints = existing.turnDiffSummaries.filter(
    (summary) =>
      summary.checkpointTurnCount !== undefined &&
      summary.checkpointTurnCount < oldestLoadedCheckpointTurnCount,
  );
  if (preservedOlderCheckpoints.length === 0) {
    return { turnDiffSummaries: mappedTailCheckpoints, preservedOlderCheckpoints: false };
  }

  const mergedTurnDiffSummaries = [...preservedOlderCheckpoints, ...mappedTailCheckpoints];
  return {
    turnDiffSummaries: arraysShallowEqual(mergedTurnDiffSummaries, existing.turnDiffSummaries)
      ? existing.turnDiffSummaries
      : mergedTurnDiffSummaries,
    preservedOlderCheckpoints: true,
  };
}

function compareCommandExecutionToCursor(
  commandExecution: Thread["commandExecutions"][number],
  cursor: NonNullable<ThreadHistoryState["oldestLoadedCommandExecutionCursor"]>,
): number {
  return (
    commandExecution.startedAt.localeCompare(cursor.startedAt) ||
    commandExecution.startedSequence - cursor.startedSequence ||
    commandExecution.id.localeCompare(cursor.commandExecutionId)
  );
}

function mergeCommandExecutionsFromTail(
  incomingCommandExecutions: ThreadTailSource["commandExecutions"],
  existing: Thread | undefined,
  oldestLoadedCommandExecutionCursor: ThreadTailSource["oldestLoadedCommandExecutionCursor"],
): {
  commandExecutions: Thread["commandExecutions"];
  preservedOlderCommandExecutions: boolean;
} {
  const mappedTailCommandExecutions = mapCommandExecutionsFromReadModel(
    incomingCommandExecutions,
    existing?.commandExecutions ?? [],
  );
  if (!existing?.detailsLoaded || oldestLoadedCommandExecutionCursor === null) {
    return {
      commandExecutions: mappedTailCommandExecutions,
      preservedOlderCommandExecutions: false,
    };
  }

  const preservedOlderCommandExecutions = existing.commandExecutions.filter(
    (commandExecution) =>
      compareCommandExecutionToCursor(commandExecution, oldestLoadedCommandExecutionCursor) < 0,
  );
  if (preservedOlderCommandExecutions.length === 0) {
    return {
      commandExecutions: mappedTailCommandExecutions,
      preservedOlderCommandExecutions: false,
    };
  }

  const mergedCommandExecutions = [
    ...preservedOlderCommandExecutions,
    ...mappedTailCommandExecutions,
  ];
  return {
    commandExecutions: arraysShallowEqual(mergedCommandExecutions, existing.commandExecutions)
      ? existing.commandExecutions
      : mergedCommandExecutions,
    preservedOlderCommandExecutions: true,
  };
}

function mapThreadTailFieldsFromReadModel(
  incoming: ThreadTailSource,
  existing: Thread | undefined,
): Pick<
  Thread,
  | "messages"
  | "commandExecutions"
  | "turnDiffSummaries"
  | "detailsLoaded"
  | "tasks"
  | "tasksTurnId"
  | "tasksUpdatedAt"
  | "sessionNotes"
  | "threadReferences"
  | "history"
> {
  const { messages, preservedOlderMessages } = mergeMessagesFromTail(
    incoming.messages,
    existing,
    incoming.oldestLoadedMessageCursor,
  );
  const { turnDiffSummaries, preservedOlderCheckpoints } = mergeTurnDiffSummariesFromTail(
    incoming.checkpoints,
    existing,
    incoming.oldestLoadedCheckpointTurnCount,
  );
  const { commandExecutions, preservedOlderCommandExecutions } = mergeCommandExecutionsFromTail(
    incoming.commandExecutions,
    existing,
    incoming.oldestLoadedCommandExecutionCursor,
  );
  const tasks = mapTasksFromReadModel(incoming.tasks, existing?.tasks ?? []);
  const sessionNotes = mapThreadSessionNotesFromReadModel(
    incoming.sessionNotes,
    existing?.sessionNotes,
  );
  const threadReferences = mapThreadReferencesFromReadModel(
    incoming.threadReferences,
    existing?.threadReferences,
  );
  const existingHistory = ensureThreadHistoryState(existing?.history);
  const hasOlderMessages =
    preservedOlderMessages && existingHistory.oldestLoadedMessageCursor !== null
      ? existingHistory.hasOlderMessages
      : incoming.hasOlderMessages;
  const hasOlderCheckpoints =
    preservedOlderCheckpoints && existingHistory.oldestLoadedCheckpointTurnCount !== null
      ? existingHistory.hasOlderCheckpoints
      : incoming.hasOlderCheckpoints;
  const hasOlderCommandExecutions =
    preservedOlderCommandExecutions && existingHistory.oldestLoadedCommandExecutionCursor !== null
      ? existingHistory.hasOlderCommandExecutions
      : incoming.hasOlderCommandExecutions;
  const oldestLoadedMessageCursor =
    preservedOlderMessages && existingHistory.oldestLoadedMessageCursor !== null
      ? existingHistory.oldestLoadedMessageCursor
      : incoming.oldestLoadedMessageCursor;
  const oldestLoadedCheckpointTurnCount =
    preservedOlderCheckpoints && existingHistory.oldestLoadedCheckpointTurnCount !== null
      ? existingHistory.oldestLoadedCheckpointTurnCount
      : incoming.oldestLoadedCheckpointTurnCount;
  const oldestLoadedCommandExecutionCursor =
    preservedOlderCommandExecutions && existingHistory.oldestLoadedCommandExecutionCursor !== null
      ? existingHistory.oldestLoadedCommandExecutionCursor
      : incoming.oldestLoadedCommandExecutionCursor;
  const historyUnchanged =
    existing?.detailsLoaded === true &&
    existing.messages === messages &&
    existing.commandExecutions === commandExecutions &&
    existing.turnDiffSummaries === turnDiffSummaries &&
    existing.tasks === tasks &&
    existing.tasksTurnId === incoming.tasksTurnId &&
    existing.tasksUpdatedAt === incoming.tasksUpdatedAt &&
    existing.sessionNotes === sessionNotes &&
    existing.threadReferences === threadReferences &&
    existingHistory.hasOlderMessages === hasOlderMessages &&
    existingHistory.hasOlderCheckpoints === hasOlderCheckpoints &&
    existingHistory.hasOlderCommandExecutions === hasOlderCommandExecutions &&
    areUnknownEqual(existingHistory.oldestLoadedMessageCursor, oldestLoadedMessageCursor) &&
    existingHistory.oldestLoadedCheckpointTurnCount === oldestLoadedCheckpointTurnCount &&
    areUnknownEqual(
      existingHistory.oldestLoadedCommandExecutionCursor,
      oldestLoadedCommandExecutionCursor,
    );

  return {
    messages,
    commandExecutions,
    turnDiffSummaries,
    detailsLoaded: true,
    tasks,
    tasksTurnId: incoming.tasksTurnId,
    tasksUpdatedAt: incoming.tasksUpdatedAt,
    sessionNotes,
    threadReferences,
    history: historyUnchanged
      ? existingHistory
      : mapThreadHistoryStateFromTail(
          {
            hasOlderMessages,
            hasOlderCheckpoints,
            hasOlderCommandExecutions,
            oldestLoadedMessageCursor,
            oldestLoadedCheckpointTurnCount,
            oldestLoadedCommandExecutionCursor,
          },
          existing,
        ),
  };
}

function buildThreadFromReadModel(
  thread: ReadModelThread,
  existing: Thread | undefined,
  detailFields:
    | Pick<
        Thread,
        | "messages"
        | "commandExecutions"
        | "turnDiffSummaries"
        | "detailsLoaded"
        | "tasks"
        | "tasksTurnId"
        | "tasksUpdatedAt"
        | "sessionNotes"
        | "threadReferences"
        | "history"
      >
    | undefined,
  options?: {
    preserveExistingActivitiesWhenIncomingEmpty?: boolean;
  },
): Thread {
  const model = resolveThreadModel({
    model: thread.model,
    sessionProviderName: thread.session?.providerName ?? null,
  });
  const session = mapSessionFromReadModel(thread.session, existing?.session);
  const proposedPlans = mapProposedPlansFromReadModel(
    thread.proposedPlans,
    existing?.proposedPlans ?? [],
  );
  const latestTurn = mapLatestTurnFromReadModel(thread.latestTurn, existing?.latestTurn);
  const activities =
    options?.preserveExistingActivitiesWhenIncomingEmpty &&
    thread.activities.length === 0 &&
    existing
      ? existing.activities
      : mapActivitiesFromReadModel(thread.activities, existing?.activities ?? []);
  const error = sanitizeThreadErrorMessage(thread.session?.lastError);
  const lastVisitedAt = existing?.lastVisitedAt ?? thread.lastInteractionAt;
  const estimatedContextTokens = thread.estimatedContextTokens ?? null;
  const modelContextWindowTokens = thread.modelContextWindowTokens ?? null;
  const compaction = thread.compaction ?? null;
  const existingCompaction = existing?.compaction ?? null;
  const nextDetailFields = detailFields ?? preserveThreadDetailFields(existing);

  if (
    existing &&
    existing.codexThreadId === null &&
    existing.projectId === thread.projectId &&
    existing.title === thread.title &&
    existing.model === model &&
    existing.runtimeMode === thread.runtimeMode &&
    existing.interactionMode === thread.interactionMode &&
    existing.session === session &&
    existing.messages === nextDetailFields.messages &&
    existing.commandExecutions === nextDetailFields.commandExecutions &&
    existing.proposedPlans === proposedPlans &&
    existing.error === error &&
    existing.createdAt === thread.createdAt &&
    existing.archivedAt === thread.archivedAt &&
    existing.lastInteractionAt === thread.lastInteractionAt &&
    existing.estimatedContextTokens === estimatedContextTokens &&
    existing.modelContextWindowTokens === modelContextWindowTokens &&
    existing.latestTurn === latestTurn &&
    existing.lastVisitedAt === lastVisitedAt &&
    existing.branch === thread.branch &&
    existing.worktreePath === thread.worktreePath &&
    existingCompaction === compaction &&
    existing.turnDiffSummaries === nextDetailFields.turnDiffSummaries &&
    existing.activities === activities &&
    existing.detailsLoaded === nextDetailFields.detailsLoaded &&
    existing.tasks === nextDetailFields.tasks &&
    existing.tasksTurnId === nextDetailFields.tasksTurnId &&
    existing.tasksUpdatedAt === nextDetailFields.tasksUpdatedAt &&
    existing.sessionNotes === nextDetailFields.sessionNotes &&
    existing.threadReferences === nextDetailFields.threadReferences &&
    existing.history === nextDetailFields.history
  ) {
    return existing;
  }

  return {
    id: thread.id,
    codexThreadId: null,
    projectId: thread.projectId,
    title: thread.title,
    model,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    session,
    messages: nextDetailFields.messages,
    commandExecutions: nextDetailFields.commandExecutions,
    proposedPlans,
    error,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    lastInteractionAt: thread.lastInteractionAt,
    estimatedContextTokens,
    modelContextWindowTokens,
    latestTurn,
    lastVisitedAt,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    compaction,
    turnDiffSummaries: nextDetailFields.turnDiffSummaries,
    activities,
    detailsLoaded: nextDetailFields.detailsLoaded,
    tasks: nextDetailFields.tasks,
    tasksTurnId: nextDetailFields.tasksTurnId,
    tasksUpdatedAt: nextDetailFields.tasksUpdatedAt,
    sessionNotes: nextDetailFields.sessionNotes,
    threadReferences: nextDetailFields.threadReferences,
    history: nextDetailFields.history,
  };
}

// ── Pure state transition functions ────────────────────────────────────

export function beginThreadDetailLoad(state: AppState, threadId: ThreadId): AppState {
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (!thread || thread.detailsLoaded) {
    return state;
  }

  const existing = state.detailEventBufferByThreadId.get(threadId);
  const detailEventBufferByThreadId = new Map(state.detailEventBufferByThreadId);
  detailEventBufferByThreadId.set(threadId, {
    events: existing?.events ?? [],
    retainers: (existing?.retainers ?? 0) + 1,
  });
  return { ...state, detailEventBufferByThreadId };
}

export function clearThreadDetailBuffer(state: AppState, threadId: ThreadId): AppState {
  const existing = state.detailEventBufferByThreadId.get(threadId);
  if (!existing) {
    return state;
  }

  const detailEventBufferByThreadId = new Map(state.detailEventBufferByThreadId);
  if (existing.retainers <= 1) {
    detailEventBufferByThreadId.delete(threadId);
  } else {
    detailEventBufferByThreadId.set(threadId, {
      ...existing,
      retainers: existing.retainers - 1,
    });
  }
  return { ...state, detailEventBufferByThreadId };
}

function dropThreadDetailBuffer(state: AppState, threadId: ThreadId): AppState {
  if (!state.detailEventBufferByThreadId.has(threadId)) {
    return state;
  }

  const detailEventBufferByThreadId = new Map(state.detailEventBufferByThreadId);
  detailEventBufferByThreadId.delete(threadId);
  return { ...state, detailEventBufferByThreadId };
}

export function invalidateThreadDetails(
  state: AppState,
  options?: { preserveThreadIds?: Iterable<ThreadId> },
): AppState {
  const preserveThreadIds = new Set(options?.preserveThreadIds ?? []);
  let threadsChanged = false;
  const threads = state.threads.map((thread) => {
    if (!thread.detailsLoaded || preserveThreadIds.has(thread.id)) {
      return thread;
    }

    threadsChanged = true;
    return {
      ...thread,
      ...clearThreadDetailFields(thread),
    };
  });

  if (!threadsChanged && state.detailEventBufferByThreadId.size === 0) {
    return state;
  }

  return {
    ...state,
    threads: threadsChanged ? threads : state.threads,
    detailEventBufferByThreadId: new Map(),
  };
}

export function syncStartupSnapshot(state: AppState, readModel: OrchestrationReadModel): AppState {
  if (readModel.snapshotSequence < state.lastAppliedSequence) {
    return state;
  }

  const projects = mapProjectsFromReadModel(
    readModel.projects.filter((project) => project.deletedAt === null),
    state.projects,
  );
  const existingThreadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const nextThreads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) =>
      buildThreadFromReadModel(thread, existingThreadById.get(thread.id), undefined, {
        preserveExistingActivitiesWhenIncomingEmpty: true,
      }),
    );
  const threads = arraysShallowEqual(nextThreads, state.threads) ? state.threads : nextThreads;
  return {
    ...state,
    projects,
    planningWorkflows: readModel.planningWorkflows.filter(
      (workflow) => workflow.deletedAt === null,
    ),
    codeReviewWorkflows: readModel.codeReviewWorkflows.filter(
      (workflow) => workflow.deletedAt === null,
    ),
    threads,
    threadsHydrated: true,
    lastAppliedSequence: Math.max(state.lastAppliedSequence, readModel.snapshotSequence),
  };
}

export function syncThreadTailDetails(
  state: AppState,
  threadId: ThreadId,
  details: OrchestrationThreadTailDetails,
  options?: { advanceLastAppliedSequence?: boolean },
): AppState {
  const existingThread = state.threads.find((thread) => thread.id === threadId);
  if (!existingThread) {
    return state;
  }
  const detailBuffer = state.detailEventBufferByThreadId.get(threadId);
  const bufferedEvents = detailBuffer?.events ?? [];
  const detailSequenceIsStale = details.detailSequence < state.lastAppliedSequence;
  if (detailBuffer === undefined && detailSequenceIsStale) {
    return state;
  }

  const detailFields = mapThreadTailFieldsFromReadModel(details, existingThread);
  const activities = mapActivitiesFromReadModel(details.activities, existingThread.activities);
  // Thread-tail RPCs can hydrate one thread without proving that the router
  // has actually observed every intervening global event. Background live
  // warms therefore opt out of advancing the app-wide sequence cursor.
  const advanceLastAppliedSequence = options?.advanceLastAppliedSequence ?? true;
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (thread !== existingThread) {
      return thread;
    }
    if (
      thread.messages === detailFields.messages &&
      thread.commandExecutions === detailFields.commandExecutions &&
      thread.turnDiffSummaries === detailFields.turnDiffSummaries &&
      thread.activities === activities &&
      thread.detailsLoaded === detailFields.detailsLoaded &&
      thread.tasks === detailFields.tasks &&
      thread.tasksTurnId === detailFields.tasksTurnId &&
      thread.tasksUpdatedAt === detailFields.tasksUpdatedAt &&
      thread.sessionNotes === detailFields.sessionNotes &&
      thread.threadReferences === detailFields.threadReferences &&
      thread.history === detailFields.history
    ) {
      return thread;
    }
    return {
      ...thread,
      messages: detailFields.messages,
      commandExecutions: detailFields.commandExecutions,
      turnDiffSummaries: detailFields.turnDiffSummaries,
      activities,
      detailsLoaded: detailFields.detailsLoaded,
      tasks: detailFields.tasks,
      tasksTurnId: detailFields.tasksTurnId,
      tasksUpdatedAt: detailFields.tasksUpdatedAt,
      sessionNotes: detailFields.sessionNotes,
      threadReferences: detailFields.threadReferences,
      history: detailFields.history,
    };
  });

  let nextState =
    threads === state.threads
      ? !advanceLastAppliedSequence || state.lastAppliedSequence >= details.detailSequence
        ? state
        : { ...state, lastAppliedSequence: details.detailSequence }
      : {
          ...state,
          threads,
          ...(advanceLastAppliedSequence
            ? { lastAppliedSequence: Math.max(state.lastAppliedSequence, details.detailSequence) }
            : {}),
        };
  nextState = dropThreadDetailBuffer(nextState, threadId);

  if (bufferedEvents.length === 0) {
    return nextState;
  }

  const dedupedBufferedEvents = Array.from(
    new Map(
      bufferedEvents
        .filter((event) => event.sequence > details.detailSequence)
        .map((event) => [event.sequence, event] as const),
    ).values(),
  ).toSorted((left, right) => left.sequence - right.sequence);

  for (const event of dedupedBufferedEvents) {
    nextState = applyDomainEvent(nextState, event);
  }
  return nextState;
}

function prependOlderMessages(
  existing: Thread["messages"],
  incoming: OrchestrationThreadHistoryPage["messages"],
): Thread["messages"] {
  if (incoming.length === 0) {
    return existing;
  }
  const existingIds = new Set(existing.map((message) => message.id));
  const nextIncoming = incoming.filter((message) => !existingIds.has(message.id));
  if (nextIncoming.length === 0) {
    return existing;
  }
  return [...mapMessagesFromReadModel(nextIncoming, []), ...existing];
}

function prependOlderTurnDiffSummaries(
  existing: Thread["turnDiffSummaries"],
  incoming: OrchestrationThreadHistoryPage["checkpoints"],
): Thread["turnDiffSummaries"] {
  if (incoming.length === 0) {
    return existing;
  }
  const existingTurnIds = new Set(existing.map((summary) => summary.turnId));
  const nextIncoming = incoming.filter((checkpoint) => !existingTurnIds.has(checkpoint.turnId));
  if (nextIncoming.length === 0) {
    return existing;
  }
  return [...mapTurnDiffSummariesFromReadModel(nextIncoming, []), ...existing];
}

function prependOlderCommandExecutions(
  existing: Thread["commandExecutions"],
  incoming: OrchestrationThreadHistoryPage["commandExecutions"],
): Thread["commandExecutions"] {
  if (incoming.length === 0) {
    return existing;
  }
  const existingIds = new Set(existing.map((execution) => execution.id));
  const nextIncoming = incoming.filter((execution) => !existingIds.has(execution.id));
  if (nextIncoming.length === 0) {
    return existing;
  }
  return [...mapCommandExecutionsFromReadModel(nextIncoming, []), ...existing];
}

export function prependOlderThreadHistoryPage(
  state: AppState,
  threadId: ThreadId,
  page: OrchestrationThreadHistoryPage,
  expectedGeneration: number,
): AppState {
  const existingThread = state.threads.find((thread) => thread.id === threadId);
  if (!existingThread || !existingThread.detailsLoaded) {
    return state;
  }
  const existingHistory = ensureThreadHistoryState(existingThread.history);
  if (existingHistory.generation !== expectedGeneration) {
    return state;
  }

  const messages = prependOlderMessages(existingThread.messages, page.messages);
  const turnDiffSummaries = prependOlderTurnDiffSummaries(
    existingThread.turnDiffSummaries,
    page.checkpoints,
  );
  const commandExecutions = prependOlderCommandExecutions(
    existingThread.commandExecutions,
    page.commandExecutions,
  );
  const nextHistory: ThreadHistoryState = {
    ...existingHistory,
    hasOlderMessages: page.hasOlderMessages,
    hasOlderCheckpoints: page.hasOlderCheckpoints,
    hasOlderCommandExecutions: page.hasOlderCommandExecutions,
    oldestLoadedMessageCursor: page.oldestLoadedMessageCursor,
    oldestLoadedCheckpointTurnCount: page.oldestLoadedCheckpointTurnCount,
    oldestLoadedCommandExecutionCursor: page.oldestLoadedCommandExecutionCursor,
  };
  if (
    messages === existingThread.messages &&
    commandExecutions === existingThread.commandExecutions &&
    turnDiffSummaries === existingThread.turnDiffSummaries &&
    existingHistory.hasOlderMessages === nextHistory.hasOlderMessages &&
    existingHistory.hasOlderCheckpoints === nextHistory.hasOlderCheckpoints &&
    existingHistory.hasOlderCommandExecutions === nextHistory.hasOlderCommandExecutions &&
    existingHistory.oldestLoadedMessageCursor === nextHistory.oldestLoadedMessageCursor &&
    existingHistory.oldestLoadedCheckpointTurnCount ===
      nextHistory.oldestLoadedCheckpointTurnCount &&
    existingHistory.oldestLoadedCommandExecutionCursor ===
      nextHistory.oldestLoadedCommandExecutionCursor
  ) {
    return state.lastAppliedSequence >= page.detailSequence
      ? state
      : { ...state, lastAppliedSequence: page.detailSequence };
  }

  const threads = updateThread(state.threads, threadId, (thread) =>
    thread !== existingThread
      ? thread
      : {
          ...thread,
          messages,
          commandExecutions,
          turnDiffSummaries,
          history: nextHistory,
        },
  );
  return {
    ...state,
    threads,
    lastAppliedSequence: Math.max(state.lastAppliedSequence, page.detailSequence),
  };
}

export function markThreadHistoryBackfilling(state: AppState, threadId: ThreadId): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    const history = ensureThreadHistoryState(thread.history);
    if (!thread.detailsLoaded || history.stage === "backfilling") {
      return thread;
    }
    return {
      ...thread,
      history: {
        ...history,
        stage: "backfilling",
      },
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadHistoryComplete(
  state: AppState,
  threadId: ThreadId,
  expectedGeneration: number,
): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    const history = ensureThreadHistoryState(thread.history);
    if (!thread.detailsLoaded || history.generation !== expectedGeneration) {
      return thread;
    }
    if (history.stage === "complete") {
      return thread;
    }
    return {
      ...thread,
      history: {
        ...history,
        stage: "complete",
      },
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadHistoryError(
  state: AppState,
  threadId: ThreadId,
  expectedGeneration: number,
): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    const history = ensureThreadHistoryState(thread.history);
    if (!thread.detailsLoaded || history.generation !== expectedGeneration) {
      return thread;
    }
    return {
      ...thread,
      history: {
        ...history,
        stage: "error",
      },
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

/**
 * @deprecated Use `syncThreadTailDetails`.
 */
export function syncThreadDetails(
  state: AppState,
  threadId: ThreadId,
  details: OrchestrationThreadTailDetails,
): AppState {
  return syncThreadTailDetails(state, threadId, details);
}

export function drainBufferedThreadDetailEvents(
  state: AppState,
  threadId: ThreadId,
  detailSequence: number,
): AppState {
  const bufferedEvents = state.detailEventBufferByThreadId.get(threadId)?.events;
  const stateWithoutBuffer = dropThreadDetailBuffer(state, threadId);
  if (!bufferedEvents || bufferedEvents.length === 0) {
    return stateWithoutBuffer;
  }

  const dedupedBufferedEvents = Array.from(
    new Map(
      bufferedEvents
        .filter((event) => event.sequence > detailSequence)
        .map((event) => [event.sequence, event] as const),
    ).values(),
  ).toSorted((left, right) => left.sequence - right.sequence);

  let nextState = stateWithoutBuffer;
  for (const event of dedupedBufferedEvents) {
    nextState = applyDomainEvent(nextState, event);
  }
  return nextState;
}

/**
 * @deprecated Production hydration now uses `syncStartupSnapshot`.
 * Keep this full-sync path for tests and debug-only callers.
 */
export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = mapProjectsFromReadModel(
    readModel.projects.filter((project) => project.deletedAt === null),
    state.projects,
  );
  const existingThreadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const nextThreads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const existingThread = existingThreadById.get(thread.id);
      const detailFields = mapThreadTailFieldsFromReadModel(
        {
          messages: thread.messages,
          checkpoints: thread.checkpoints,
          commandExecutions: existingThread?.commandExecutions ?? [],
          tasks: thread.tasks,
          tasksTurnId: thread.tasksTurnId,
          tasksUpdatedAt: thread.tasksUpdatedAt,
          hasOlderMessages: false,
          hasOlderCheckpoints: false,
          hasOlderCommandExecutions: ensureThreadHistoryState(existingThread?.history)
            .hasOlderCommandExecutions,
          oldestLoadedMessageCursor:
            thread.messages.length > 0
              ? {
                  createdAt: thread.messages[0]!.createdAt,
                  messageId: thread.messages[0]!.id,
                }
              : null,
          oldestLoadedCheckpointTurnCount: thread.checkpoints[0]?.checkpointTurnCount ?? null,
          oldestLoadedCommandExecutionCursor: ensureThreadHistoryState(existingThread?.history)
            .oldestLoadedCommandExecutionCursor,
          ...(thread.sessionNotes !== undefined ? { sessionNotes: thread.sessionNotes } : {}),
          ...(thread.threadReferences !== undefined
            ? { threadReferences: thread.threadReferences }
            : {}),
        },
        existingThread,
      );
      return buildThreadFromReadModel(
        thread,
        existingThread,
        existingThread?.detailsLoaded
          ? {
              ...detailFields,
              history: ensureThreadHistoryState(existingThread.history),
            }
          : detailFields,
      );
    });
  const threads = arraysShallowEqual(nextThreads, state.threads) ? state.threads : nextThreads;
  return {
    ...state,
    projects,
    planningWorkflows: readModel.planningWorkflows.filter(
      (workflow) => workflow.deletedAt === null,
    ),
    codeReviewWorkflows: readModel.codeReviewWorkflows.filter(
      (workflow) => workflow.deletedAt === null,
    ),
    threads,
    threadsHydrated: true,
    lastAppliedSequence: Math.max(state.lastAppliedSequence, readModel.snapshotSequence),
    // A full snapshot supersedes any in-flight detail fetch and its buffered deltas.
    detailEventBufferByThreadId: new Map(),
  };
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const threads = updateThread(state.threads, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    return { ...thread, lastVisitedAt: at };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    return { ...thread, lastVisitedAt: unreadVisitedAt };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function toggleProject(state: AppState, projectId: Project["id"]): AppState {
  return {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, expanded: !p.expanded } : p)),
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
): AppState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId || p.expanded === expanded) return p;
    changed = true;
    return { ...p, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function reorderProjects(
  state: AppState,
  draggedProjectId: Project["id"],
  targetProjectId: Project["id"],
): AppState {
  if (draggedProjectId === targetProjectId) return state;
  const draggedIndex = state.projects.findIndex((project) => project.id === draggedProjectId);
  const targetIndex = state.projects.findIndex((project) => project.id === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) return state;
  const projects = [...state.projects];
  const [draggedProject] = projects.splice(draggedIndex, 1);
  if (!draggedProject) return state;
  projects.splice(targetIndex, 0, draggedProject);
  return { ...state, projects };
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setChangedFilesExpandedForThread(
  state: AppState,
  threadId: ThreadId,
  expanded: boolean,
): AppState {
  const currentEntry = state.changedFilesExpandedByThreadId[threadId];
  const currentExpanded = currentEntry ?? true;
  if (currentExpanded === expanded) {
    return state;
  }
  const next = { ...state.changedFilesExpandedByThreadId };
  if (expanded) {
    delete next[threadId];
  } else {
    next[threadId] = false;
  }
  return { ...state, changedFilesExpandedByThreadId: next };
}

export function pruneChangedFilesExpandedForThreads(
  state: AppState,
  activeThreadIds: Iterable<ThreadId>,
): AppState {
  const activeSet = new Set(activeThreadIds);
  const currentEntries = Object.entries(state.changedFilesExpandedByThreadId);
  if (currentEntries.length === 0) return state;
  let changed = false;
  const next: Record<ThreadId, boolean> = {};
  for (const [threadId, expanded] of currentEntries) {
    if (activeSet.has(threadId as ThreadId)) {
      next[threadId as ThreadId] = expanded;
    } else {
      changed = true;
    }
  }
  return changed ? { ...state, changedFilesExpandedByThreadId: next } : state;
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  invalidateThreadDetails: (options?: { preserveThreadIds?: Iterable<ThreadId> }) => void;
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  syncStartupSnapshot: (readModel: OrchestrationReadModel) => void;
  syncThreadTailDetails: (
    threadId: ThreadId,
    details: OrchestrationThreadTailDetails,
    options?: { advanceLastAppliedSequence?: boolean },
  ) => void;
  prependOlderThreadHistoryPage: (
    threadId: ThreadId,
    page: OrchestrationThreadHistoryPage,
    expectedGeneration: number,
  ) => void;
  markThreadHistoryBackfilling: (threadId: ThreadId) => void;
  markThreadHistoryComplete: (threadId: ThreadId, expectedGeneration: number) => void;
  markThreadHistoryError: (threadId: ThreadId, expectedGeneration: number) => void;
  syncThreadDetails: (threadId: ThreadId, details: OrchestrationThreadTailDetails) => void;
  beginThreadDetailLoad: (threadId: ThreadId) => void;
  clearThreadDetailBuffer: (threadId: ThreadId) => void;
  drainBufferedThreadDetailEvents: (threadId: ThreadId, detailSequence: number) => void;
  applyDomainEvent: (event: OrchestrationEvent) => void;
  applyDomainEventBatch: (events: ReadonlyArray<OrchestrationEvent>) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  reorderProjects: (draggedProjectId: Project["id"], targetProjectId: Project["id"]) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
  setChangedFilesExpandedForThread: (threadId: ThreadId, expanded: boolean) => void;
  pruneChangedFilesExpandedForThreads: (activeThreadIds: Iterable<ThreadId>) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(),
  invalidateThreadDetails: (options) => set((state) => invalidateThreadDetails(state, options)),
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  syncStartupSnapshot: (readModel) => set((state) => syncStartupSnapshot(state, readModel)),
  syncThreadTailDetails: (threadId, details, options) =>
    set((state) => syncThreadTailDetails(state, threadId, details, options)),
  prependOlderThreadHistoryPage: (threadId, page, expectedGeneration) =>
    set((state) => prependOlderThreadHistoryPage(state, threadId, page, expectedGeneration)),
  markThreadHistoryBackfilling: (threadId) =>
    set((state) => markThreadHistoryBackfilling(state, threadId)),
  markThreadHistoryComplete: (threadId, expectedGeneration) =>
    set((state) => markThreadHistoryComplete(state, threadId, expectedGeneration)),
  markThreadHistoryError: (threadId, expectedGeneration) =>
    set((state) => markThreadHistoryError(state, threadId, expectedGeneration)),
  syncThreadDetails: (threadId, details) =>
    set((state) => syncThreadDetails(state, threadId, details)),
  beginThreadDetailLoad: (threadId) => set((state) => beginThreadDetailLoad(state, threadId)),
  clearThreadDetailBuffer: (threadId) => set((state) => clearThreadDetailBuffer(state, threadId)),
  drainBufferedThreadDetailEvents: (threadId, detailSequence) =>
    set((state) => drainBufferedThreadDetailEvents(state, threadId, detailSequence)),
  applyDomainEvent: (event) =>
    set((state) => {
      const nextState = applyDomainEvent(state, event);
      const nextLastAppliedSequence = Math.max(nextState.lastAppliedSequence, event.sequence);
      return nextLastAppliedSequence === nextState.lastAppliedSequence
        ? nextState
        : { ...nextState, lastAppliedSequence: nextLastAppliedSequence };
    }),
  applyDomainEventBatch: (events) =>
    set((state) => {
      if (events.length === 0) {
        return state;
      }
      // Dedup against the already-committed cursor. The caller (EventRouter)
      // tracks an enqueued-sequence cursor that advances at enqueue time; if
      // an external thread-detail sync commits an overlapping range while
      // events are queued, those events would otherwise re-apply here and
      // double-append streaming message deltas. This guard matches the
      // single-event subscriber's "sequence <= latestSequence" early-return.
      const committedBefore = state.lastAppliedSequence;
      let nextState: AppState = state;
      let maxSequence = committedBefore;
      for (const event of events) {
        if (event.sequence <= committedBefore) {
          continue;
        }
        nextState = applyDomainEvent(nextState, event);
        if (event.sequence > maxSequence) {
          maxSequence = event.sequence;
        }
      }
      const nextLastAppliedSequence = Math.max(nextState.lastAppliedSequence, maxSequence);
      if (nextState === state && nextLastAppliedSequence === state.lastAppliedSequence) {
        return state;
      }
      return nextLastAppliedSequence === nextState.lastAppliedSequence
        ? nextState
        : { ...nextState, lastAppliedSequence: nextLastAppliedSequence };
    }),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) => set((state) => markThreadUnread(state, threadId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
  setChangedFilesExpandedForThread: (threadId, expanded) =>
    set((state) => setChangedFilesExpandedForThread(state, threadId, expanded)),
  pruneChangedFilesExpandedForThreads: (activeThreadIds) =>
    set((state) => pruneChangedFilesExpandedForThreads(state, activeThreadIds)),
}));

// Persist state changes with debouncing to avoid localStorage thrashing
useStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

// Flush pending writes synchronously before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistState(useStore.getState());
  }, []);
  return createElement(Fragment, null, children);
}
