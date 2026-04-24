import {
  DEFAULT_MODEL_BY_PROVIDER,
  type OrchestrationEvent,
  type PlanningWorkflow,
  type ProjectMemory,
} from "@t3tools/contracts";
import {
  estimateModelContextWindowTokens,
  estimateContextTokensAfterMessageUpdate,
  estimateMessageContextCharacters,
  resolveModelSlug,
  roughTokenEstimateFromCharacters,
} from "@t3tools/shared/model";

import {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
  areUnknownEqual,
  arraysShallowEqual,
  checkpointStatusToLatestTurnState,
  compareThreadActivities,
  mapMessageAttachmentsFromReadModel,
  mapSessionFromReadModel,
  resolveThreadModel,
  retainThreadActivitiesAfterRevert,
  retainThreadMessagesAfterRevert,
  retainThreadProposedPlansAfterRevert,
} from "./orchestrationState";
import { sanitizeThreadErrorMessage } from "./transportError";
import { compareCommandExecutions } from "./lib/commandExecutions";
import type { AppState } from "./store";
import type { ChatMessage, CodeReviewWorkflow, Project, Thread, TurnDiffSummary } from "./types";

function updateThread(
  threads: Thread[],
  threadId: Thread["id"],
  updater: (thread: Thread) => Thread,
): Thread[] {
  let changed = false;
  const nextThreads = threads.map((thread) => {
    if (thread.id !== threadId) {
      return thread;
    }
    const nextThread = updater(thread);
    if (nextThread !== thread) {
      changed = true;
    }
    return nextThread;
  });
  return changed ? nextThreads : threads;
}

function updateProject(
  projects: Project[],
  projectId: Project["id"],
  updater: (project: Project) => Project,
): Project[] {
  let changed = false;
  const nextProjects = projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const nextProject = updater(project);
    if (nextProject !== project) {
      changed = true;
    }
    return nextProject;
  });
  return changed ? nextProjects : projects;
}

function mapScripts(
  scripts: ReadonlyArray<Project["scripts"][number]>,
  previous: Project["scripts"],
): Project["scripts"] {
  if (
    scripts.length === previous.length &&
    scripts.every(
      (script, index) =>
        previous[index] !== undefined &&
        previous[index]!.id === script.id &&
        previous[index]!.name === script.name &&
        previous[index]!.command === script.command &&
        previous[index]!.icon === script.icon &&
        previous[index]!.runOnWorktreeCreate === script.runOnWorktreeCreate,
    )
  ) {
    return previous;
  }
  return scripts.map((script) => ({ ...script }));
}

function mapProjectSkills(
  skills: ReadonlyArray<NonNullable<Project["skills"]>[number]>,
  previous: Project["skills"] | undefined,
): NonNullable<Project["skills"]> {
  if (
    previous &&
    skills.length === previous.length &&
    skills.every((skill, index) => areUnknownEqual(skill, previous[index]))
  ) {
    return previous;
  }
  return skills.map((skill) => ({
    ...skill,
    allowedTools: [...skill.allowedTools],
    paths: [...skill.paths],
  }));
}

function mapThreadSessionNotes(
  sessionNotes: Thread["sessionNotes"],
  previous: Thread["sessionNotes"],
): Thread["sessionNotes"] {
  if (sessionNotes === null || sessionNotes === undefined) {
    return null;
  }
  if (previous && areUnknownEqual(previous, sessionNotes)) {
    return previous;
  }
  return { ...sessionNotes };
}

function upsertProjectMemory(memories: ProjectMemory[], memory: ProjectMemory): ProjectMemory[] {
  if (memory.deletedAt !== null) {
    return memories.filter((entry) => entry.id !== memory.id);
  }
  const existingIndex = memories.findIndex((entry) => entry.id === memory.id);
  if (existingIndex < 0) {
    return [...memories, memory];
  }
  const existing = memories[existingIndex];
  if (existing && areUnknownEqual(existing, memory)) {
    return memories;
  }
  const nextMemories = [...memories];
  nextMemories[existingIndex] = memory;
  return nextMemories;
}

function upsertPlanningWorkflow(
  workflows: PlanningWorkflow[],
  workflow: PlanningWorkflow,
): PlanningWorkflow[] {
  const existingIndex = workflows.findIndex((entry) => entry.id === workflow.id);
  if (existingIndex < 0) {
    return [...workflows, workflow];
  }
  const existing = workflows[existingIndex];
  if (existing && areUnknownEqual(existing, workflow)) {
    return workflows;
  }
  const nextWorkflows = [...workflows];
  nextWorkflows[existingIndex] = workflow;
  return nextWorkflows;
}

function upsertCodeReviewWorkflow(
  workflows: CodeReviewWorkflow[],
  workflow: CodeReviewWorkflow,
): CodeReviewWorkflow[] {
  const existingIndex = workflows.findIndex((entry) => entry.id === workflow.id);
  if (existingIndex < 0) {
    return [...workflows, workflow];
  }
  const existing = workflows[existingIndex];
  if (existing && areUnknownEqual(existing, workflow)) {
    return workflows;
  }
  const nextWorkflows = [...workflows];
  nextWorkflows[existingIndex] = workflow;
  return nextWorkflows;
}

function upsertMessage(
  messages: Thread["messages"],
  payload: Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"],
): Thread["messages"] {
  const existingIndex = messages.findIndex((entry) => entry.id === payload.messageId);
  const existing = existingIndex >= 0 ? messages[existingIndex] : undefined;
  const attachments = mapMessageAttachmentsFromReadModel(
    payload.attachments,
    existing?.attachments,
  );
  const nextText =
    existing && payload.streaming
      ? `${existing.text}${payload.text}`
      : existing && payload.text.length === 0
        ? existing.text
        : payload.text;
  const nextReasoningText =
    payload.reasoningText !== undefined
      ? existing && payload.streaming
        ? `${existing.reasoningText ?? ""}${payload.reasoningText}`
        : existing && payload.reasoningText.length === 0
          ? existing.reasoningText
          : payload.reasoningText
      : existing?.reasoningText;
  const completedAt = payload.streaming ? undefined : payload.updatedAt;

  if (
    existing &&
    existing.role === payload.role &&
    existing.text === nextText &&
    existing.reasoningText === nextReasoningText &&
    (existing.turnId ?? null) === payload.turnId &&
    existing.createdAt === payload.createdAt &&
    existing.streaming === payload.streaming &&
    existing.completedAt === completedAt &&
    existing.attachments === attachments
  ) {
    return messages;
  }

  const nextMessage: ChatMessage = {
    id: payload.messageId,
    role: payload.role,
    text: nextText,
    ...(nextReasoningText !== undefined ? { reasoningText: nextReasoningText } : {}),
    ...(payload.turnId !== null ? { turnId: payload.turnId } : {}),
    createdAt: existing?.createdAt ?? payload.createdAt,
    streaming: payload.streaming,
    ...(completedAt ? { completedAt } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };

  if (existingIndex < 0) {
    return [...messages, nextMessage].slice(-MAX_THREAD_MESSAGES);
  }

  const nextMessages = [...messages];
  nextMessages[existingIndex] = nextMessage;
  return arraysShallowEqual(nextMessages, messages) ? messages : nextMessages;
}

function messageCharacters(message: Pick<ChatMessage, "text" | "reasoningText" | "attachments">) {
  return estimateMessageContextCharacters({
    text: message.text,
    reasoningText: message.reasoningText,
    attachmentNames: message.attachments?.map((attachment) => attachment.name),
  });
}

function totalMessageCharacters(messages: ReadonlyArray<ChatMessage>): number {
  return messages.reduce((sum, message) => sum + messageCharacters(message), 0);
}

function updateLatestTurnFromMessage(
  thread: Thread,
  payload: Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"],
): Thread["latestTurn"] {
  if (payload.turnId === null || payload.role !== "assistant") {
    return thread.latestTurn;
  }

  const shouldTrackTurn =
    thread.latestTurn?.turnId === payload.turnId ||
    thread.session?.activeTurnId === payload.turnId ||
    thread.latestTurn === null;
  if (!shouldTrackTurn) {
    return thread.latestTurn;
  }

  const previous = thread.latestTurn?.turnId === payload.turnId ? thread.latestTurn : null;
  const nextState = payload.streaming
    ? previous?.state === "interrupted"
      ? "interrupted"
      : previous?.state === "error"
        ? "error"
        : "running"
    : previous?.state === "interrupted"
      ? "interrupted"
      : previous?.state === "error"
        ? "error"
        : "completed";
  const nextLatestTurn = {
    turnId: payload.turnId,
    state: nextState,
    requestedAt: previous?.requestedAt ?? payload.createdAt,
    startedAt: previous?.startedAt ?? payload.createdAt,
    completedAt: payload.streaming ? (previous?.completedAt ?? null) : payload.updatedAt,
    assistantMessageId: payload.messageId,
  } satisfies NonNullable<Thread["latestTurn"]>;

  if (
    previous &&
    previous.state === nextLatestTurn.state &&
    previous.requestedAt === nextLatestTurn.requestedAt &&
    previous.startedAt === nextLatestTurn.startedAt &&
    previous.completedAt === nextLatestTurn.completedAt &&
    previous.assistantMessageId === nextLatestTurn.assistantMessageId
  ) {
    return previous;
  }

  return nextLatestTurn;
}

function upsertProposedPlan(
  proposedPlans: Thread["proposedPlans"],
  proposedPlan: Extract<
    OrchestrationEvent,
    { type: "thread.proposed-plan-upserted" }
  >["payload"]["proposedPlan"],
): Thread["proposedPlans"] {
  const existingIndex = proposedPlans.findIndex((entry) => entry.id === proposedPlan.id);
  const existing = existingIndex >= 0 ? proposedPlans[existingIndex] : undefined;
  if (
    existing &&
    existing.turnId === proposedPlan.turnId &&
    existing.planMarkdown === proposedPlan.planMarkdown &&
    existing.implementedAt === proposedPlan.implementedAt &&
    existing.implementationThreadId === proposedPlan.implementationThreadId &&
    existing.createdAt === proposedPlan.createdAt &&
    existing.updatedAt === proposedPlan.updatedAt
  ) {
    return proposedPlans;
  }

  const nextPlan = {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  } satisfies Thread["proposedPlans"][number];

  const nextProposedPlans =
    existingIndex < 0
      ? [...proposedPlans, nextPlan]
      : proposedPlans.map((entry, index) => (index === existingIndex ? nextPlan : entry));

  const orderedProposedPlans = nextProposedPlans
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .slice(-MAX_THREAD_PROPOSED_PLANS);
  return arraysShallowEqual(orderedProposedPlans, proposedPlans)
    ? proposedPlans
    : orderedProposedPlans;
}

function upsertTurnDiffSummary(
  turnDiffSummaries: Thread["turnDiffSummaries"],
  payload: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>["payload"],
): Thread["turnDiffSummaries"] | null {
  const existingIndex = turnDiffSummaries.findIndex((entry) => entry.turnId === payload.turnId);
  const existing = existingIndex >= 0 ? turnDiffSummaries[existingIndex] : undefined;
  if (existing && existing.status !== "missing" && payload.status === "missing") {
    return null;
  }

  const sameFiles =
    existing?.files.length === payload.files.length &&
    payload.files.every(
      (file, index) =>
        existing?.files[index] !== undefined &&
        existing.files[index]!.path === file.path &&
        existing.files[index]!.kind === file.kind &&
        existing.files[index]!.additions === file.additions &&
        existing.files[index]!.deletions === file.deletions,
    );
  const nextSummary: TurnDiffSummary =
    existing &&
    existing.completedAt === payload.completedAt &&
    existing.status === payload.status &&
    existing.assistantMessageId === (payload.assistantMessageId ?? undefined) &&
    existing.checkpointTurnCount === payload.checkpointTurnCount &&
    existing.checkpointRef === payload.checkpointRef &&
    sameFiles
      ? existing
      : {
          turnId: payload.turnId,
          completedAt: payload.completedAt,
          status: payload.status,
          assistantMessageId: payload.assistantMessageId ?? undefined,
          checkpointTurnCount: payload.checkpointTurnCount,
          checkpointRef: payload.checkpointRef,
          files: sameFiles ? (existing?.files ?? []) : payload.files.map((file) => ({ ...file })),
        };

  const nextTurnDiffSummaries =
    existingIndex < 0
      ? [...turnDiffSummaries, nextSummary]
      : turnDiffSummaries.map((entry, index) => (index === existingIndex ? nextSummary : entry));

  const orderedTurnDiffSummaries = nextTurnDiffSummaries
    .toSorted((left, right) => (left.checkpointTurnCount ?? 0) - (right.checkpointTurnCount ?? 0))
    .slice(-MAX_THREAD_CHECKPOINTS);
  return arraysShallowEqual(orderedTurnDiffSummaries, turnDiffSummaries)
    ? turnDiffSummaries
    : orderedTurnDiffSummaries;
}

function mergeTasks(
  previous: Thread["tasks"],
  nextTasks: Extract<OrchestrationEvent, { type: "thread.tasks.updated" }>["payload"]["tasks"],
): Thread["tasks"] {
  const previousById = new Map(previous.map((task) => [task.id, task] as const));
  let reusedAll = previous.length === nextTasks.length;

  const merged = nextTasks.map((task) => {
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

  return reusedAll && arraysShallowEqual(merged, previous) ? previous : merged;
}

function upsertActivity(
  activities: Thread["activities"],
  activity: Extract<
    OrchestrationEvent,
    { type: "thread.activity-appended" }
  >["payload"]["activity"],
): Thread["activities"] {
  const existingIndex = activities.findIndex((entry) => entry.id === activity.id);
  const existing = existingIndex >= 0 ? activities[existingIndex] : undefined;
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
    return activities;
  }

  const nextActivity = existing ? { ...existing, ...activity } : { ...activity };
  const nextActivities =
    existingIndex < 0
      ? [...activities, nextActivity]
      : activities.map((entry, index) => (index === existingIndex ? nextActivity : entry));

  const orderedActivities = nextActivities
    .toSorted(compareThreadActivities)
    .slice(-MAX_THREAD_ACTIVITIES);
  return arraysShallowEqual(orderedActivities, activities) ? activities : orderedActivities;
}

function upsertCommandExecution(
  commandExecutions: Thread["commandExecutions"],
  event: Extract<OrchestrationEvent, { type: "thread.command-execution-recorded" }>,
): Thread["commandExecutions"] {
  const existingIndex = commandExecutions.findIndex(
    (entry) => entry.id === event.payload.commandExecution.id,
  );
  const existing = existingIndex >= 0 ? commandExecutions[existingIndex] : undefined;
  if (existing && event.sequence <= existing.lastUpdatedSequence) {
    return commandExecutions;
  }
  const nextCwd = event.payload.commandExecution.cwd ?? existing?.cwd;
  const nextCommandExecution = {
    id: event.payload.commandExecution.id,
    threadId: event.payload.threadId,
    turnId: event.payload.commandExecution.turnId,
    providerItemId: event.payload.commandExecution.providerItemId,
    command: event.payload.commandExecution.command,
    ...(nextCwd !== undefined ? { cwd: nextCwd } : {}),
    title: event.payload.commandExecution.title,
    status: event.payload.commandExecution.status,
    detail: event.payload.commandExecution.detail,
    exitCode: event.payload.commandExecution.exitCode,
    startedAt: event.payload.commandExecution.startedAt,
    completedAt: event.payload.commandExecution.completedAt,
    updatedAt: event.payload.commandExecution.updatedAt,
    startedSequence: existing?.startedSequence ?? event.sequence,
    lastUpdatedSequence: event.sequence,
  } satisfies Thread["commandExecutions"][number];

  if (
    existing &&
    existing.threadId === nextCommandExecution.threadId &&
    existing.turnId === nextCommandExecution.turnId &&
    existing.providerItemId === nextCommandExecution.providerItemId &&
    existing.command === nextCommandExecution.command &&
    (existing.cwd ?? undefined) === nextCommandExecution.cwd &&
    existing.title === nextCommandExecution.title &&
    existing.status === nextCommandExecution.status &&
    existing.detail === nextCommandExecution.detail &&
    existing.exitCode === nextCommandExecution.exitCode &&
    existing.startedAt === nextCommandExecution.startedAt &&
    existing.completedAt === nextCommandExecution.completedAt &&
    existing.updatedAt === nextCommandExecution.updatedAt &&
    existing.startedSequence === nextCommandExecution.startedSequence &&
    existing.lastUpdatedSequence === nextCommandExecution.lastUpdatedSequence
  ) {
    return commandExecutions;
  }

  const nextCommandExecutions =
    existingIndex < 0
      ? [...commandExecutions, nextCommandExecution]
      : commandExecutions.map((entry, index) =>
          index === existingIndex ? nextCommandExecution : entry,
        );
  const orderedCommandExecutions = nextCommandExecutions.toSorted(compareCommandExecutions);
  return arraysShallowEqual(orderedCommandExecutions, commandExecutions)
    ? commandExecutions
    : orderedCommandExecutions;
}

function retainThreadCommandExecutionsAfterRevert(
  commandExecutions: Thread["commandExecutions"],
  retainedTurnIds: ReadonlySet<string>,
): Thread["commandExecutions"] {
  const retained = commandExecutions.filter((commandExecution) =>
    retainedTurnIds.has(commandExecution.turnId),
  );
  return retained.length === commandExecutions.length ? commandExecutions : retained;
}

function removeById<T extends { id: string }>(entries: T[], id: string): T[] {
  const nextEntries = entries.filter((entry) => entry.id !== id);
  return nextEntries.length === entries.length ? entries : nextEntries;
}

function enqueueThreadDetailEvent(
  state: AppState,
  threadId: Thread["id"],
  event: OrchestrationEvent,
): AppState {
  const existingBuffer = state.detailEventBufferByThreadId.get(threadId);
  const existing = existingBuffer?.events;
  if (!existing || !existingBuffer) {
    return state;
  }

  const detailEventBufferByThreadId = new Map(state.detailEventBufferByThreadId);
  detailEventBufferByThreadId.set(threadId, {
    ...existingBuffer,
    events: [...existing, event],
  });
  return { ...state, detailEventBufferByThreadId };
}

function gateThreadDetailMutations(
  state: AppState,
  threadId: Thread["id"],
  event: OrchestrationEvent,
): { state: AppState; applyDetailMutations: boolean } {
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (!thread || thread.detailsLoaded) {
    return { state, applyDetailMutations: true };
  }
  if (!state.detailEventBufferByThreadId.has(threadId)) {
    return { state, applyDetailMutations: false };
  }
  return {
    state: enqueueThreadDetailEvent(state, threadId, event),
    applyDetailMutations: false,
  };
}

export function applyDomainEvent(state: AppState, event: OrchestrationEvent): AppState {
  switch (event.type) {
    case "project.created": {
      const existingIndex = state.projects.findIndex(
        (project) => project.id === event.payload.projectId,
      );
      if (existingIndex >= 0) {
        return state;
      }
      const nextProject: Project = {
        id: event.payload.projectId,
        name: event.payload.title,
        cwd: event.payload.workspaceRoot,
        model: resolveModelSlug(event.payload.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.codex),
        createdAt: event.payload.createdAt,
        expanded: true,
        scripts: mapScripts(event.payload.scripts, []),
        memories: [],
        skills: [],
      };
      const projects = [...state.projects, nextProject];
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.meta-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => {
        const model =
          event.payload.defaultModel !== undefined
            ? resolveModelSlug(event.payload.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.codex)
            : project.model;
        const scripts =
          event.payload.scripts !== undefined
            ? mapScripts(event.payload.scripts, project.scripts)
            : project.scripts;
        if (
          (event.payload.title ?? project.name) === project.name &&
          (event.payload.workspaceRoot ?? project.cwd) === project.cwd &&
          model === project.model &&
          scripts === project.scripts
        ) {
          return project;
        }
        return {
          ...project,
          ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
          ...(event.payload.workspaceRoot !== undefined
            ? { cwd: event.payload.workspaceRoot }
            : {}),
          ...(model !== project.model ? { model } : {}),
          ...(scripts !== project.scripts ? { scripts } : {}),
        };
      });
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.deleted": {
      const projects = removeById(state.projects, event.payload.projectId);
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.skills-replaced": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => {
        const skills = mapProjectSkills(event.payload.skills, project.skills);
        return skills === project.skills ? project : { ...project, skills };
      });
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.memory-saved":
    case "project.memory-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => {
        const memories = upsertProjectMemory(project.memories, event.payload.memory);
        return memories === project.memories ? project : { ...project, memories };
      });
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.memory-deleted": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => {
        const memories = project.memories.filter((memory) => memory.id !== event.payload.memoryId);
        return memories.length === project.memories.length ? project : { ...project, memories };
      });
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.workflow-created":
    case "project.workflow-upserted": {
      const planningWorkflows = upsertPlanningWorkflow(
        state.planningWorkflows,
        event.payload.workflow,
      );
      return planningWorkflows === state.planningWorkflows
        ? state
        : { ...state, planningWorkflows };
    }

    case "project.workflow-deleted": {
      const planningWorkflows = removeById(state.planningWorkflows, event.payload.workflowId);
      return planningWorkflows === state.planningWorkflows
        ? state
        : { ...state, planningWorkflows };
    }

    case "project.code-review-workflow-created":
    case "project.code-review-workflow-upserted": {
      const codeReviewWorkflows = upsertCodeReviewWorkflow(
        state.codeReviewWorkflows,
        event.payload.workflow,
      );
      return codeReviewWorkflows === state.codeReviewWorkflows
        ? state
        : { ...state, codeReviewWorkflows };
    }

    case "project.code-review-workflow-deleted": {
      const codeReviewWorkflows = removeById(state.codeReviewWorkflows, event.payload.workflowId);
      return codeReviewWorkflows === state.codeReviewWorkflows
        ? state
        : { ...state, codeReviewWorkflows };
    }

    case "thread.created": {
      const existingIndex = state.threads.findIndex(
        (thread) => thread.id === event.payload.threadId,
      );
      if (existingIndex >= 0) {
        return state;
      }
      const nextThread: Thread = {
        id: event.payload.threadId,
        codexThreadId: null,
        projectId: event.payload.projectId,
        title: event.payload.title,
        model: resolveThreadModel({
          model: event.payload.model,
          sessionProviderName: null,
        }),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        session: null,
        messages: [],
        commandExecutions: [],
        proposedPlans: [],
        error: null,
        createdAt: event.payload.createdAt,
        archivedAt: null,
        lastInteractionAt: event.payload.createdAt,
        estimatedContextTokens: null,
        modelContextWindowTokens: estimateModelContextWindowTokens(event.payload.model),
        latestTurn: null,
        lastVisitedAt: event.payload.createdAt,
        branch: event.payload.branch,
        worktreePath: event.payload.worktreePath,
        compaction: null,
        turnDiffSummaries: [],
        activities: [],
        detailsLoaded: true,
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        sessionNotes: null,
        threadReferences: [...(event.payload.threadReferences ?? [])],
        history: {
          stage: "complete",
          hasOlderMessages: false,
          hasOlderCheckpoints: false,
          hasOlderCommandExecutions: false,
          oldestLoadedMessageCursor: null,
          oldestLoadedCheckpointTurnCount: null,
          oldestLoadedCommandExecutionCursor: null,
          generation: 0,
        },
      };
      const threads = [...state.threads, nextThread];
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.deleted": {
      const threads = removeById(state.threads, event.payload.threadId);
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.archived": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) =>
        thread.archivedAt === event.payload.archivedAt
          ? thread
          : { ...thread, archivedAt: event.payload.archivedAt },
      );
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.unarchived": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) =>
        thread.archivedAt === null ? thread : { ...thread, archivedAt: null },
      );
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.meta-updated": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => {
        const model =
          event.payload.model !== undefined
            ? resolveThreadModel({
                model: event.payload.model,
                sessionProviderName: thread.session?.provider ?? null,
              })
            : thread.model;
        const modelContextWindowTokens =
          event.payload.model !== undefined
            ? estimateModelContextWindowTokens(event.payload.model, thread.session?.provider)
            : thread.modelContextWindowTokens;
        if (
          (event.payload.title ?? thread.title) === thread.title &&
          model === thread.model &&
          modelContextWindowTokens === thread.modelContextWindowTokens &&
          (event.payload.branch ?? thread.branch) === thread.branch &&
          (event.payload.worktreePath ?? thread.worktreePath) === thread.worktreePath
        ) {
          return thread;
        }
        return {
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(model !== thread.model ? { model } : {}),
          ...(modelContextWindowTokens !== thread.modelContextWindowTokens
            ? { modelContextWindowTokens }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.runtime-mode-set": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) =>
        thread.runtimeMode === event.payload.runtimeMode
          ? thread
          : { ...thread, runtimeMode: event.payload.runtimeMode },
      );
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.interaction-mode-set": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) =>
        thread.interactionMode === event.payload.interactionMode
          ? thread
          : { ...thread, interactionMode: event.payload.interactionMode },
      );
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.message-sent": {
      const detailGate = gateThreadDetailMutations(state, event.payload.threadId, event);
      const threads = updateThread(detailGate.state.threads, event.payload.threadId, (thread) => {
        const existingMessage = thread.messages.find(
          (message) => message.id === event.payload.messageId,
        );
        const attachmentsForEstimate = mapMessageAttachmentsFromReadModel(
          event.payload.attachments,
          existingMessage?.attachments,
        );
        const nextMessageForEstimate: ChatMessage = {
          id: event.payload.messageId,
          role: event.payload.role,
          text:
            existingMessage && event.payload.streaming
              ? `${existingMessage.text}${event.payload.text}`
              : existingMessage && event.payload.text.length === 0
                ? existingMessage.text
                : event.payload.text,
          ...(event.payload.reasoningText !== undefined
            ? {
                reasoningText:
                  existingMessage && event.payload.streaming
                    ? `${existingMessage.reasoningText ?? ""}${event.payload.reasoningText}`
                    : existingMessage && event.payload.reasoningText.length === 0
                      ? existingMessage.reasoningText
                      : event.payload.reasoningText,
              }
            : existingMessage?.reasoningText !== undefined
              ? { reasoningText: existingMessage.reasoningText }
              : {}),
          ...(event.payload.turnId !== null ? { turnId: event.payload.turnId } : {}),
          createdAt: existingMessage?.createdAt ?? event.payload.createdAt,
          streaming: event.payload.streaming,
          ...(event.payload.streaming ? {} : { completedAt: event.payload.updatedAt }),
          ...(attachmentsForEstimate?.length ? { attachments: attachmentsForEstimate } : {}),
        };
        const messages = detailGate.applyDetailMutations
          ? upsertMessage(thread.messages, event.payload)
          : thread.messages;
        const latestTurn = updateLatestTurnFromMessage(thread, event.payload);
        const nextMessage =
          messages.find((message) => message.id === event.payload.messageId) ??
          nextMessageForEstimate;
        const shouldRecomputeFromMessages = thread.estimatedContextTokens === null;
        const nextEstimatedContextTokens =
          nextMessage === undefined
            ? thread.estimatedContextTokens
            : shouldRecomputeFromMessages && detailGate.applyDetailMutations
              ? roughTokenEstimateFromCharacters(totalMessageCharacters(messages))
              : estimateContextTokensAfterMessageUpdate({
                  previousEstimatedContextTokens: thread.estimatedContextTokens,
                  previousMessageCharacters: existingMessage
                    ? messageCharacters(existingMessage)
                    : 0,
                  nextMessageCharacters: messageCharacters(nextMessage),
                  fallbackTotalCharacters: detailGate.applyDetailMutations
                    ? totalMessageCharacters(messages)
                    : undefined,
                });
        const nextSession =
          thread.session &&
          nextEstimatedContextTokens !== null &&
          (thread.session.tokenUsageSource !== "estimated" ||
            nextEstimatedContextTokens !== thread.estimatedContextTokens)
            ? { ...thread.session, tokenUsageSource: "estimated" as const }
            : thread.session;
        if (
          messages === thread.messages &&
          latestTurn === thread.latestTurn &&
          nextEstimatedContextTokens === thread.estimatedContextTokens &&
          nextSession === thread.session &&
          thread.lastInteractionAt === event.occurredAt
        ) {
          return thread;
        }
        return {
          ...thread,
          ...(messages !== thread.messages ? { messages } : {}),
          ...(latestTurn !== thread.latestTurn ? { latestTurn } : {}),
          ...(nextSession !== thread.session ? { session: nextSession } : {}),
          ...(nextEstimatedContextTokens !== thread.estimatedContextTokens
            ? { estimatedContextTokens: nextEstimatedContextTokens }
            : {}),
          lastInteractionAt: event.occurredAt,
        };
      });
      return threads === detailGate.state.threads
        ? detailGate.state
        : { ...detailGate.state, threads };
    }

    case "thread.turn-start-requested":
      return state;

    case "thread.turn-interrupt-requested": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => {
        const latestTurn =
          event.payload.turnId !== undefined &&
          (thread.latestTurn?.turnId === event.payload.turnId ||
            thread.session?.activeTurnId === event.payload.turnId)
            ? {
                turnId: event.payload.turnId,
                state: "interrupted" as const,
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.createdAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.createdAt,
                completedAt: thread.latestTurn?.completedAt ?? event.payload.createdAt,
                assistantMessageId: thread.latestTurn?.assistantMessageId ?? null,
              }
            : thread.latestTurn;
        if (latestTurn === thread.latestTurn && thread.lastInteractionAt === event.occurredAt) {
          return thread;
        }
        return {
          ...thread,
          ...(latestTurn !== thread.latestTurn ? { latestTurn } : {}),
          lastInteractionAt: event.occurredAt,
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.session-stop-requested":
    case "thread.compact-requested": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) =>
        thread.lastInteractionAt === event.occurredAt
          ? thread
          : { ...thread, lastInteractionAt: event.occurredAt },
      );
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.reverted": {
      const detailGate = gateThreadDetailMutations(state, event.payload.threadId, event);
      const threads = updateThread(detailGate.state.threads, event.payload.threadId, (thread) => {
        if (!detailGate.applyDetailMutations) {
          const nextSession =
            thread.session?.tokenUsageSource === undefined
              ? thread.session
              : (() => {
                  const { tokenUsageSource: _tokenUsageSource, ...session } = thread.session;
                  return session;
                })();
          if (
            thread.estimatedContextTokens === null &&
            nextSession === thread.session &&
            thread.lastInteractionAt === event.occurredAt
          ) {
            return thread;
          }
          return {
            ...thread,
            ...(nextSession !== thread.session ? { session: nextSession } : {}),
            estimatedContextTokens: null,
            lastInteractionAt: event.occurredAt,
          };
        }
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter(
            (summary) =>
              summary.checkpointTurnCount !== undefined &&
              summary.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) => (left.checkpointTurnCount ?? 0) - (right.checkpointTurnCount ?? 0),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((summary) => summary.turnId));
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const proposedPlans = retainThreadProposedPlansAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_THREAD_PROPOSED_PLANS);
        const commandExecutions = retainThreadCommandExecutionsAfterRevert(
          thread.commandExecutions,
          retainedTurnIds,
        );
        const activities = retainThreadActivitiesAfterRevert(
          thread.activities,
          retainedTurnIds,
        ).slice(-MAX_THREAD_ACTIVITIES);
        const latestTurnSummary = turnDiffSummaries.at(-1) ?? null;
        const latestTurnStatus =
          latestTurnSummary?.status === "missing" || latestTurnSummary?.status === "error"
            ? latestTurnSummary.status
            : "ready";
        const latestTurn =
          latestTurnSummary === null
            ? null
            : {
                turnId: latestTurnSummary.turnId,
                state: checkpointStatusToLatestTurnState(latestTurnStatus),
                requestedAt: latestTurnSummary.completedAt,
                startedAt: latestTurnSummary.completedAt,
                completedAt: latestTurnSummary.completedAt,
                assistantMessageId: latestTurnSummary.assistantMessageId ?? null,
              };
        if (
          turnDiffSummaries === thread.turnDiffSummaries &&
          messages === thread.messages &&
          proposedPlans === thread.proposedPlans &&
          commandExecutions === thread.commandExecutions &&
          activities === thread.activities &&
          latestTurn === thread.latestTurn &&
          thread.estimatedContextTokens === null &&
          thread.tasks.length === 0 &&
          thread.tasksTurnId === null &&
          thread.tasksUpdatedAt === null &&
          thread.lastInteractionAt === event.occurredAt
        ) {
          return thread;
        }
        return {
          ...thread,
          turnDiffSummaries,
          messages,
          commandExecutions,
          proposedPlans,
          tasks: [],
          tasksTurnId: null,
          tasksUpdatedAt: null,
          compaction: null,
          ...(thread.session?.tokenUsageSource !== undefined
            ? {
                session: (() => {
                  const { tokenUsageSource: _tokenUsageSource, ...session } = thread.session;
                  return session;
                })(),
              }
            : {}),
          estimatedContextTokens: null,
          activities,
          latestTurn,
          lastInteractionAt: event.occurredAt,
        };
      });
      return threads === detailGate.state.threads
        ? detailGate.state
        : { ...detailGate.state, threads };
    }

    case "thread.session-set": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => {
        const session = mapSessionFromReadModel(event.payload.session, thread.session);
        const nextEstimatedContextTokens =
          event.payload.session.estimatedContextTokens ?? thread.estimatedContextTokens;
        const nextModelContextWindowTokens =
          event.payload.session.modelContextWindowTokens ?? thread.modelContextWindowTokens;
        const latestTurn =
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? {
                turnId: event.payload.session.activeTurnId,
                state: "running" as const,
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.assistantMessageId
                    : null,
              }
            : thread.latestTurn;
        const error = sanitizeThreadErrorMessage(event.payload.session.lastError);
        if (
          session === thread.session &&
          latestTurn === thread.latestTurn &&
          error === thread.error &&
          nextEstimatedContextTokens === thread.estimatedContextTokens &&
          nextModelContextWindowTokens === thread.modelContextWindowTokens
        ) {
          return thread;
        }
        return {
          ...thread,
          ...(session !== thread.session ? { session } : {}),
          ...(latestTurn !== thread.latestTurn ? { latestTurn } : {}),
          ...(error !== thread.error ? { error } : {}),
          ...(nextEstimatedContextTokens !== thread.estimatedContextTokens
            ? { estimatedContextTokens: nextEstimatedContextTokens }
            : {}),
          ...(nextModelContextWindowTokens !== thread.modelContextWindowTokens
            ? { modelContextWindowTokens: nextModelContextWindowTokens }
            : {}),
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.proposed-plan-upserted": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => {
        const proposedPlans = upsertProposedPlan(thread.proposedPlans, event.payload.proposedPlan);
        if (
          proposedPlans === thread.proposedPlans &&
          thread.lastInteractionAt === event.occurredAt
        ) {
          return thread;
        }
        return {
          ...thread,
          ...(proposedPlans !== thread.proposedPlans ? { proposedPlans } : {}),
          lastInteractionAt: event.occurredAt,
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.turn-diff-completed": {
      const detailGate = gateThreadDetailMutations(state, event.payload.threadId, event);
      const threads = updateThread(detailGate.state.threads, event.payload.threadId, (thread) => {
        const turnDiffSummaries = detailGate.applyDetailMutations
          ? upsertTurnDiffSummary(thread.turnDiffSummaries, event.payload)
          : thread.turnDiffSummaries;
        if (turnDiffSummaries === null) {
          return thread;
        }
        const latestTurn = {
          turnId: event.payload.turnId,
          state: checkpointStatusToLatestTurnState(event.payload.status),
          requestedAt:
            thread.latestTurn?.turnId === event.payload.turnId
              ? thread.latestTurn.requestedAt
              : event.payload.completedAt,
          startedAt:
            thread.latestTurn?.turnId === event.payload.turnId
              ? (thread.latestTurn.startedAt ?? event.payload.completedAt)
              : event.payload.completedAt,
          completedAt: event.payload.completedAt,
          assistantMessageId: event.payload.assistantMessageId,
        } satisfies NonNullable<Thread["latestTurn"]>;
        if (
          turnDiffSummaries === thread.turnDiffSummaries &&
          thread.latestTurn?.turnId === latestTurn.turnId &&
          thread.latestTurn?.state === latestTurn.state &&
          thread.latestTurn?.requestedAt === latestTurn.requestedAt &&
          thread.latestTurn?.startedAt === latestTurn.startedAt &&
          thread.latestTurn?.completedAt === latestTurn.completedAt &&
          thread.latestTurn?.assistantMessageId === latestTurn.assistantMessageId &&
          thread.lastInteractionAt === event.occurredAt
        ) {
          return thread;
        }
        return {
          ...thread,
          ...(turnDiffSummaries !== thread.turnDiffSummaries ? { turnDiffSummaries } : {}),
          latestTurn,
          lastInteractionAt: event.occurredAt,
        };
      });
      return threads === detailGate.state.threads
        ? detailGate.state
        : { ...detailGate.state, threads };
    }

    case "thread.activity-appended": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => {
        const activities = upsertActivity(thread.activities, event.payload.activity);
        if (activities === thread.activities && thread.lastInteractionAt === event.occurredAt) {
          return thread;
        }
        return {
          ...thread,
          ...(activities !== thread.activities ? { activities } : {}),
          lastInteractionAt: event.occurredAt,
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.tasks.updated": {
      const detailGate = gateThreadDetailMutations(state, event.payload.threadId, event);
      const threads = updateThread(detailGate.state.threads, event.payload.threadId, (thread) => {
        const tasks = detailGate.applyDetailMutations
          ? mergeTasks(thread.tasks, event.payload.tasks)
          : thread.tasks;
        if (
          tasks === thread.tasks &&
          (!detailGate.applyDetailMutations || thread.tasksTurnId === event.payload.turnId) &&
          (!detailGate.applyDetailMutations || thread.tasksUpdatedAt === event.payload.updatedAt) &&
          thread.lastInteractionAt === event.payload.updatedAt
        ) {
          return thread;
        }
        return {
          ...thread,
          ...(tasks !== thread.tasks ? { tasks } : {}),
          ...(detailGate.applyDetailMutations && thread.tasksTurnId !== event.payload.turnId
            ? { tasksTurnId: event.payload.turnId }
            : {}),
          ...(detailGate.applyDetailMutations && thread.tasksUpdatedAt !== event.payload.updatedAt
            ? { tasksUpdatedAt: event.payload.updatedAt }
            : {}),
          lastInteractionAt: event.payload.updatedAt,
        };
      });
      return threads === detailGate.state.threads
        ? detailGate.state
        : { ...detailGate.state, threads };
    }

    case "thread.compacted": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => {
        const nextEstimatedContextTokens =
          event.payload.compaction?.estimatedTokens ?? thread.estimatedContextTokens;
        const nextSession =
          thread.session && thread.session.tokenUsageSource !== "estimated"
            ? { ...thread.session, tokenUsageSource: "estimated" as const }
            : thread.session;
        if (
          thread.lastInteractionAt === event.occurredAt &&
          nextEstimatedContextTokens === thread.estimatedContextTokens &&
          nextSession === thread.session
        ) {
          return thread;
        }
        return {
          ...thread,
          compaction: event.payload.compaction,
          ...(nextEstimatedContextTokens !== thread.estimatedContextTokens
            ? { estimatedContextTokens: nextEstimatedContextTokens }
            : {}),
          ...(nextSession !== thread.session ? { session: nextSession } : {}),
          lastInteractionAt: event.occurredAt,
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.session-notes-recorded": {
      const detailGate = gateThreadDetailMutations(state, event.payload.threadId, event);
      if (!detailGate.applyDetailMutations) {
        return detailGate.state;
      }
      const threads = updateThread(detailGate.state.threads, event.payload.threadId, (thread) => {
        const sessionNotes = mapThreadSessionNotes(event.payload.sessionNotes, thread.sessionNotes);
        return sessionNotes === thread.sessionNotes ? thread : { ...thread, sessionNotes };
      });
      return threads === detailGate.state.threads
        ? detailGate.state
        : { ...detailGate.state, threads };
    }

    case "thread.command-execution-recorded": {
      const detailGate = gateThreadDetailMutations(state, event.payload.threadId, event);
      if (!detailGate.applyDetailMutations) {
        return detailGate.state;
      }
      const threads = updateThread(detailGate.state.threads, event.payload.threadId, (thread) => {
        const commandExecutions = upsertCommandExecution(thread.commandExecutions, event);
        return commandExecutions === thread.commandExecutions
          ? thread
          : { ...thread, commandExecutions };
      });
      return threads === detailGate.state.threads
        ? detailGate.state
        : { ...detailGate.state, threads };
    }

    case "thread.command-execution-output-appended":
    case "thread.file-change-recorded":
      return state;
  }

  const exhaustiveEvent: never = event;
  void exhaustiveEvent;
  return state;
}
