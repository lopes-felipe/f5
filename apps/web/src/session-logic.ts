import {
  ApprovalRequestId,
  type CodexCollaborationTool,
  type CompactSubagentState,
  ProviderItemId,
  type RuntimeItemStatus,
  type OrchestrationCommandExecutionSummary,
  type OrchestrationFileChangeId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type ProviderRequestKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { isIgnorableCodexProcessStderrMessage } from "@t3tools/shared/codexStderr";
import {
  normalizeCodexCollaborationTool,
  readToolActivityPayload,
} from "@t3tools/shared/orchestrationActivityPayload";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";
import {
  classifyCompactCommand,
  deriveNarratedActivityDisplayHints,
  isGenericCommandTitle,
} from "@t3tools/shared/commandSummary";
import { compareCommandExecutions } from "./lib/commandExecutions";
import type { RuntimeWarningVisibility, WorkLogFilter, WorkLogMode } from "./appSettings";

export type ProviderPickerKind = ProviderKind;

export interface WorkLogDiagnostic {
  type: "hook" | "approval-review";
  id: string;
  status: string;
  outcome?: "success" | "error" | "cancelled";
  incomplete?: boolean;
  hookEvent?: string;
  handlerType?: string;
  executionMode?: string;
  scope?: string;
  source?: string;
  sourcePath?: string;
  displayOrder?: number;
  statusMessage?: string;
  durationMs?: number;
  output?: string;
  entries?: ReadonlyArray<unknown>;
  actionType?: string;
  riskLevel?: string;
  rationale?: string;
}

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeAgent", label: "Claude", available: true },
  { value: "cursor", label: "Cursor", available: true },
  { value: "opencode", label: "OpenCode", available: true },
  { value: "grok", label: "Grok", available: true },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  turnId?: TurnId;
  providerItemId?: ProviderItemId;
  status?: RuntimeItemStatus;
  fileChangeId?: OrchestrationFileChangeId;
  cwd?: string;
  detail?: string;
  command?: string;
  readPaths?: ReadonlyArray<string>;
  lineSummary?: string;
  searchSummary?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  subagentType?: string;
  subagentDescription?: string;
  subagentPrompt?: string;
  subagentResult?: string;
  subagentModel?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  mcpInput?: string;
  mcpResult?: string;
  activityKind?: string;
  category?: "tool" | "hook" | "review" | "issue" | "other";
  isIssue?: boolean;
  warningCategory?: string;
  warningProtocolMethod?: string;
  warningProtocolValue?: string;
  warningCount?: number;
  parentProviderItemId?: ProviderItemId;
  diagnostic?: WorkLogDiagnostic;
  nestedDiagnostics?: ReadonlyArray<WorkLogEntry>;
  subagentThreadId?: string;
  subagentPath?: string;
  subagentSenderThreadId?: string;
  subagentReceiverThreadIds?: ReadonlyArray<string>;
  codexCollaborationTool?: CodexCollaborationTool;
  subagentStates?: ReadonlyArray<CompactSubagentState>;
  subagentStatesTruncated?: boolean;
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: ProviderRequestKind;
  requestType?: string;
  createdAt: string;
  detail?: string;
  requestedPermissions?: Record<string, unknown>;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    }
  | {
      id: string;
      kind: "command";
      createdAt: string;
      commandExecution: OrchestrationCommandExecutionSummary;
      nestedDiagnostics?: ReadonlyArray<WorkLogEntry>;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (
    input.phase === "running" ||
    input.hasPendingApproval ||
    input.hasPendingUserInput ||
    Boolean(input.threadError)
  ) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;

  return (
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null) ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "permissions_approval":
      return "permission";
    default:
      return typeof requestType === "string" && requestType.trim().length > 0 ? "unknown" : null;
  }
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change" ||
        payload.requestKind === "permission" ||
        payload.requestKind === "unknown")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    const requestType =
      payload && typeof payload.requestType === "string" ? payload.requestType : undefined;
    const requestedPermissions = asUnknownRecord(payload?.requestedPermissions);

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(requestKind === "unknown" && requestType ? { requestType } : {}),
        ...(detail ? { detail } : {}),
        ...(requestKind === "permission" && requestedPermissions ? { requestedPermissions } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      detail?.includes("Unknown pending permission request")
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      const parsedQuestion: {
        id: string;
        header: string;
        question: string;
        options: UserInputQuestion["options"];
        multiSelect?: boolean;
      } = {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
      if (typeof question.multiSelect === "boolean") {
        parsedQuestion.multiSelect = question.multiSelect;
      }
      return parsedQuestion as UserInputQuestion;
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  taskSnapshot?: {
    tasks: ReadonlyArray<Thread["tasks"][number]>;
    turnId: TurnId | null;
    updatedAt: string | null;
  },
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.plan.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
  const payload =
    latest?.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const planSteps = Array.isArray(payload?.plan)
    ? payload.plan
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const record = entry as Record<string, unknown>;
          if (typeof record.step !== "string") {
            return null;
          }
          const status =
            record.status === "completed" || record.status === "inProgress"
              ? record.status
              : "pending";
          return {
            step: record.step,
            status,
          };
        })
        .filter(
          (
            step,
          ): step is {
            step: string;
            status: "pending" | "inProgress" | "completed";
          } => step !== null,
        )
    : [];

  const shouldUseTaskSnapshot =
    latestTurnId !== undefined &&
    taskSnapshot?.turnId === latestTurnId &&
    taskSnapshot.updatedAt !== null &&
    taskSnapshot.tasks.length > 0 &&
    (latest === undefined || taskSnapshot.updatedAt >= latest.createdAt);
  if (shouldUseTaskSnapshot) {
    const tasksUpdatedAt = taskSnapshot.updatedAt!;
    return {
      createdAt: tasksUpdatedAt,
      turnId: latestTurnId,
      ...(payload && "explanation" in payload
        ? { explanation: payload.explanation as string | null }
        : {}),
      steps: taskSnapshot.tasks.map((task) => ({
        step: task.activeForm,
        status:
          task.status === "completed"
            ? "completed"
            : task.status === "in_progress"
              ? "inProgress"
              : "pending",
      })),
    };
  }

  if (!latest || planSteps.length === 0) {
    return null;
  }

  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps: planSteps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return {
        id: matchingTurnPlan.id,
        createdAt: matchingTurnPlan.createdAt,
        updatedAt: matchingTurnPlan.updatedAt,
        turnId: matchingTurnPlan.turnId,
        planMarkdown: matchingTurnPlan.planMarkdown,
        implementedAt: matchingTurnPlan.implementedAt,
        implementationThreadId: matchingTurnPlan.implementationThreadId,
      };
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return {
    id: latestPlan.id,
    createdAt: latestPlan.createdAt,
    updatedAt: latestPlan.updatedAt,
    turnId: latestPlan.turnId,
    planMarkdown: latestPlan.planMarkdown,
    implementedAt: latestPlan.implementedAt,
    implementationThreadId: latestPlan.implementationThreadId,
  };
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

const ALWAYS_VISIBLE_KINDS = new Set([
  "runtime.warning",
  "runtime.error",
  "config.warning",
  "deprecation.notice",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "hook.started",
  "hook.completed",
]);

function inferWorkLogStatus(
  activity: OrchestrationThreadActivity,
  explicitStatus: RuntimeItemStatus | undefined,
): RuntimeItemStatus | undefined {
  if (explicitStatus) {
    return explicitStatus;
  }
  if (activity.kind === "tool.completed") {
    return "completed";
  }
  if (activity.kind === "tool.updated") {
    return "inProgress";
  }
  return undefined;
}

function shouldKeepHistoricalWorkEntry(
  activity: OrchestrationThreadActivity,
  latestTurnId: TurnId | undefined,
  terminalCodexProviderItemIds: ReadonlySet<ProviderItemId>,
): boolean {
  if (!latestTurnId) {
    return true;
  }
  if (
    activity.turnId === latestTurnId ||
    (ALWAYS_VISIBLE_KINDS.has(activity.kind) && !activity.turnId)
  ) {
    return true;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const toolPayload = readToolActivityPayload(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const inferredStatus = inferWorkLogStatus(activity, toolPayload?.status);
  const isHistoricalFileChange =
    toolPayload?.itemType === "file_change" || requestKind === "file-change";

  const isTerminalCodexCollaboration =
    Boolean(toolPayload?.codexCollaborationTool) &&
    (inferredStatus === "completed" ||
      inferredStatus === "failed" ||
      inferredStatus === "declined");
  const isLifecycleOfTerminalCodexCollaboration = Boolean(
    toolPayload?.providerItemId && terminalCodexProviderItemIds.has(toolPayload.providerItemId),
  );

  return (
    (isHistoricalFileChange && inferredStatus === "completed") ||
    isTerminalCodexCollaboration ||
    isLifecycleOfTerminalCodexCollaboration
  );
}

function workEntryVisibleSignature(entry: WorkLogEntry): string {
  return JSON.stringify({
    label: entry.label,
    toolTitle: entry.toolTitle,
    itemType: entry.itemType,
    requestKind: entry.requestKind,
    detail: entry.detail,
    command: entry.command,
    cwd: entry.cwd,
    readPaths: entry.readPaths ?? [],
    lineSummary: entry.lineSummary,
    searchSummary: entry.searchSummary,
    changedFiles: entry.changedFiles ?? [],
    fileChangeId: entry.fileChangeId,
    subagentType: entry.subagentType,
    subagentDescription: entry.subagentDescription,
    subagentPrompt: entry.subagentPrompt,
    subagentResult: entry.subagentResult,
    subagentModel: entry.subagentModel,
    subagentThreadId: entry.subagentThreadId,
    subagentPath: entry.subagentPath,
    subagentSenderThreadId: entry.subagentSenderThreadId,
    subagentReceiverThreadIds: entry.subagentReceiverThreadIds ?? [],
    codexCollaborationTool: entry.codexCollaborationTool,
    subagentStatesTruncated: entry.subagentStatesTruncated,
    mcpServerName: entry.mcpServerName,
    mcpToolName: entry.mcpToolName,
    mcpInput: entry.mcpInput,
    mcpResult: entry.mcpResult,
  });
}

function dedupeProviderItemWorkLogEntries(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const deduped: Array<WorkLogEntry | null> = [];
  const latestByProviderItemId = new Map<ProviderItemId, { index: number; signature: string }>();

  for (const entry of entries) {
    if (!entry.providerItemId) {
      deduped.push(entry);
      continue;
    }

    const signature = workEntryVisibleSignature(entry);
    const previous = latestByProviderItemId.get(entry.providerItemId);
    if (previous && previous.signature === signature) {
      deduped[previous.index] = null;
    }

    deduped.push(entry);
    latestByProviderItemId.set(entry.providerItemId, {
      index: deduped.length - 1,
      signature,
    });
  }

  return deduped.filter((entry): entry is WorkLogEntry => entry !== null);
}

function collaborationLifecyclePrecedence(entry: WorkLogEntry): number {
  if (entry.status === "completed" || entry.status === "failed" || entry.status === "declined") {
    return 2;
  }
  if (entry.activityKind === "tool.updated") return 1;
  return 0;
}

function coalesceCodexCollaborationEntries(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const result: WorkLogEntry[] = [];
  const indexByProviderItemId = new Map<ProviderItemId, number>();
  for (const entry of entries) {
    if (!entry.providerItemId || !entry.codexCollaborationTool) {
      result.push(entry);
      continue;
    }
    const existingIndex = indexByProviderItemId.get(entry.providerItemId);
    if (existingIndex === undefined) {
      indexByProviderItemId.set(entry.providerItemId, result.length);
      result.push(entry);
      continue;
    }
    const existing = result[existingIndex]!;
    const laterDefined = Object.fromEntries(
      Object.entries(entry).filter(([, value]) => value !== undefined),
    ) as Partial<WorkLogEntry>;
    const lifecycleWinner =
      collaborationLifecyclePrecedence(entry) >= collaborationLifecyclePrecedence(existing)
        ? entry
        : existing;
    result[existingIndex] = {
      ...existing,
      ...laterDefined,
      id: existing.id,
      createdAt: existing.createdAt,
      tone: lifecycleWinner.tone,
      label: lifecycleWinner.label,
      ...(lifecycleWinner.activityKind ? { activityKind: lifecycleWinner.activityKind } : {}),
      ...(lifecycleWinner.status ? { status: lifecycleWinner.status } : {}),
    };
  }
  return result;
}

function workLogPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asHookOutcome(value: unknown): WorkLogDiagnostic["outcome"] {
  switch (value) {
    case "success":
    case "error":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

function isPostToolUseHookEvent(value: string | undefined): boolean {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase() === "posttooluse";
}

function providerItemIdFromPayload(
  payload: Record<string, unknown> | null,
): ProviderItemId | undefined {
  const value = asTrimmedString(payload?.providerItemId);
  return value ? ProviderItemId.makeUnsafe(value) : undefined;
}

function diagnosticFromActivity(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): WorkLogDiagnostic | undefined {
  if (activity.kind === "hook.started" || activity.kind === "hook.completed") {
    const id = asTrimmedString(payload?.hookId);
    if (!id) {
      return undefined;
    }
    const status =
      asTrimmedString(payload?.rawStatus) ??
      asTrimmedString(payload?.outcome) ??
      (activity.kind === "hook.started" ? "running" : "unknown");
    const hookEvent = asTrimmedString(payload?.hookEvent);
    const output = asTrimmedString(payload?.output);
    const rawOutcome = asHookOutcome(payload?.outcome);
    const outcome =
      status === "stopped" &&
      isPostToolUseHookEvent(hookEvent) &&
      (rawOutcome === undefined || rawOutcome === "cancelled")
        ? "success"
        : rawOutcome;
    const handlerType = asTrimmedString(payload?.handlerType);
    const executionMode = asTrimmedString(payload?.executionMode);
    const scope = asTrimmedString(payload?.scope);
    const source = asTrimmedString(payload?.source);
    const sourcePath = asTrimmedString(payload?.sourcePath);
    const displayOrder = asFiniteNumber(payload?.displayOrder);
    const statusMessage = asTrimmedString(payload?.statusMessage);
    const durationMs = asFiniteNumber(payload?.durationMs);
    return {
      type: "hook",
      id,
      status,
      ...(outcome ? { outcome } : {}),
      ...(hookEvent ? { hookEvent } : {}),
      ...(handlerType ? { handlerType } : {}),
      ...(executionMode ? { executionMode } : {}),
      ...(scope ? { scope } : {}),
      ...(source ? { source } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(displayOrder !== undefined ? { displayOrder } : {}),
      ...(statusMessage ? { statusMessage } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(output ? { output } : {}),
      ...(Array.isArray(payload?.entries) ? { entries: payload.entries } : {}),
    };
  }

  if (
    activity.kind === "approval-review.started" ||
    activity.kind === "approval-review.completed"
  ) {
    const id = asTrimmedString(payload?.reviewId);
    if (!id) {
      return undefined;
    }
    const actionType = asTrimmedString(payload?.actionType);
    const riskLevel = asTrimmedString(payload?.riskLevel);
    const rationale = asTrimmedString(payload?.rationale);
    const durationMs = asFiniteNumber(payload?.durationMs);
    return {
      type: "approval-review",
      id,
      status:
        asTrimmedString(payload?.status) ??
        (activity.kind === "approval-review.started" ? "inProgress" : "unknown"),
      ...(actionType ? { actionType } : {}),
      ...(riskLevel ? { riskLevel } : {}),
      ...(rationale ? { rationale } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  return undefined;
}

function isWorkLogIssue(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }
  if (entry.activityKind === "runtime.warning") {
    return true;
  }
  if (entry.status === "failed" || entry.status === "declined") {
    return true;
  }
  if (entry.diagnostic?.type === "hook") {
    if (entry.diagnostic.incomplete) {
      return true;
    }
    if (entry.diagnostic.outcome) {
      return entry.diagnostic.outcome !== "success";
    }
    return ["failed", "blocked", "stopped", "error", "cancelled", "incomplete"].includes(
      entry.diagnostic.status,
    );
  }
  if (entry.diagnostic?.type === "approval-review") {
    return ["denied", "timedOut", "aborted", "incomplete"].includes(entry.diagnostic.status);
  }
  return false;
}

function pairDiagnosticLifecycles(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const completedKeys = new Set(
    entries.flatMap((entry) => {
      if (
        !entry.diagnostic ||
        (entry.activityKind !== "hook.completed" &&
          entry.activityKind !== "approval-review.completed")
      ) {
        return [];
      }
      return [`${entry.diagnostic.type}:${entry.diagnostic.id}`];
    }),
  );

  return entries.flatMap((entry) => {
    if (
      !entry.diagnostic ||
      (entry.activityKind !== "hook.started" && entry.activityKind !== "approval-review.started")
    ) {
      return [entry];
    }
    const key = `${entry.diagnostic.type}:${entry.diagnostic.id}`;
    if (completedKeys.has(key)) {
      return [];
    }
    const label =
      entry.diagnostic.type === "hook"
        ? `${entry.diagnostic.hookEvent ?? "Hook"} (incomplete)`
        : `${entry.diagnostic.actionType ?? "Approval"} review (incomplete)`;
    return [
      {
        ...entry,
        label,
        isIssue: true,
        diagnostic: {
          ...entry.diagnostic,
          status: "incomplete",
          incomplete: true,
        },
      },
    ];
  });
}

function coalesceProtocolWarnings(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const result: WorkLogEntry[] = [];
  const indexBySignature = new Map<string, number>();
  for (const entry of entries) {
    if (entry.activityKind !== "runtime.warning" || entry.warningCategory !== "protocol") {
      result.push(entry);
      continue;
    }
    const payloadSignature = [
      entry.turnId ?? "",
      entry.label,
      entry.warningProtocolMethod ?? "",
      entry.warningProtocolValue ?? "",
      entry.detail ?? "",
    ].join(":");
    const existingIndex = indexBySignature.get(payloadSignature);
    if (existingIndex === undefined) {
      indexBySignature.set(payloadSignature, result.length);
      result.push(entry);
      continue;
    }
    const existing = result[existingIndex];
    if (!existing) {
      continue;
    }
    result[existingIndex] = {
      ...existing,
      warningCount: (existing.warningCount ?? 1) + 1,
    };
  }
  return result;
}

function correlateSubagentActivities(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const correlated = [...entries];
  const dropped = new Set<number>();
  const spawnParentIndexByAgentThreadId = new Map<string, number>();
  const latestParentIndexByAgentThreadId = new Map<string, number>();
  const metadataByProviderItemId = new Map<
    ProviderItemId,
    Pick<WorkLogEntry, "subagentPath" | "subagentThreadId">
  >();
  entries.forEach((entry, index) => {
    if (entry.activityKind !== "subagent.activity") {
      const correlatedMetadata = entry.providerItemId
        ? metadataByProviderItemId.get(entry.providerItemId)
        : undefined;
      if (correlatedMetadata) {
        correlated[index] = { ...entry, ...correlatedMetadata };
      }
      const normalizedSubagentType = normalizeCodexCollaborationTool(entry.subagentType);
      for (const threadId of entry.subagentReceiverThreadIds ?? []) {
        latestParentIndexByAgentThreadId.set(threadId, index);
        if (normalizedSubagentType === "spawnAgent") {
          spawnParentIndexByAgentThreadId.set(threadId, index);
        }
      }
      return;
    }

    if (!entry.subagentThreadId) {
      return;
    }
    const parentIndex =
      spawnParentIndexByAgentThreadId.get(entry.subagentThreadId) ??
      latestParentIndexByAgentThreadId.get(entry.subagentThreadId);
    if (parentIndex === undefined || parentIndex === index) {
      return;
    }
    const parent = correlated[parentIndex];
    if (!parent) {
      return;
    }
    const metadata = {
      subagentThreadId: entry.subagentThreadId,
      ...(entry.subagentPath ? { subagentPath: entry.subagentPath } : {}),
    };
    correlated[parentIndex] = {
      ...parent,
      ...metadata,
    };
    if (parent.providerItemId) {
      metadataByProviderItemId.set(parent.providerItemId, metadata);
    }
    // Hide the child only from the compact work-log rollup. The Agents panel
    // derives its own index from the authoritative activities and retains it.
    dropped.add(index);
  });
  return correlated.filter((_entry, index) => !dropped.has(index));
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options?: {
    readonly suppressCommandToolLifecycle?: boolean;
    readonly runtimeWarningVisibility?: RuntimeWarningVisibility;
    readonly mode?: WorkLogMode;
    readonly filter?: WorkLogFilter;
  },
): WorkLogEntry[] {
  const runtimeWarningVisibility = options?.runtimeWarningVisibility ?? "hidden";
  const mode = options?.mode ?? "essential";
  const selectedFilter = options?.filter ?? "all";
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const terminalCodexProviderItemIds = new Set<ProviderItemId>();
  for (const activity of ordered) {
    const payload = readToolActivityPayload(activity.payload);
    const status = inferWorkLogStatus(activity, payload?.status);
    if (
      payload?.providerItemId &&
      payload.codexCollaborationTool &&
      (status === "completed" || status === "failed" || status === "declined")
    ) {
      terminalCodexProviderItemIds.add(payload.providerItemId);
    }
  }
  const entries = ordered
    .filter((activity) =>
      shouldKeepHistoricalWorkEntry(activity, latestTurnId, terminalCodexProviderItemIds),
    )
    .filter((activity) =>
      options?.suppressCommandToolLifecycle ? !isCommandToolLifecycleActivity(activity) : true,
    )
    .filter((activity) => {
      if (activity.kind !== "runtime.warning") {
        return true;
      }

      const payload = workLogPayload(activity);
      const message = typeof payload?.message === "string" ? payload.message : "";
      if (isIgnorableCodexProcessStderrMessage(message)) {
        return false;
      }

      const category = asTrimmedString(payload?.category);
      const alwaysVisible =
        category === "guardian" ||
        category === "verification" ||
        category === "protocol" ||
        payload?.actionable === true;
      return alwaysVisible || runtimeWarningVisibility !== "hidden";
    })
    .filter(
      (activity) =>
        activity.kind !== "tool.started" ||
        Boolean(readToolActivityPayload(activity.payload)?.codexCollaborationTool),
    )
    .filter((activity) => activity.kind !== "runtime.configured")
    .filter((activity) => activity.kind !== "account.updated")
    .filter((activity) => activity.kind !== "account.rate-limits.updated")
    .filter((activity) => activity.kind !== "task.started" && activity.kind !== "task.completed")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .map((activity) => {
      const toolPayload = readToolActivityPayload(activity.payload);
      const payload = workLogPayload(activity);
      const diagnostic = diagnosticFromActivity(activity, payload);
      const warningCategory = asTrimmedString(payload?.category);
      const label =
        diagnostic?.type === "hook" &&
        diagnostic.status === "stopped" &&
        diagnostic.outcome === "success"
          ? `${diagnostic.hookEvent ?? "postToolUse"} hook applied output replacement`
          : toolPayload?.title && isGenericToolActivitySummary(activity.summary)
            ? toolPayload.title
            : activity.kind === "runtime.warning" &&
                (runtimeWarningVisibility === "full" ||
                  warningCategory === "guardian" ||
                  warningCategory === "verification" ||
                  warningCategory === "protocol" ||
                  payload?.actionable === true)
              ? typeof payload?.message === "string" && payload.message.length > 0
                ? payload.message
                : activity.summary
              : activity.summary;
      const entry: WorkLogEntry = {
        id: activity.id,
        createdAt: activity.createdAt,
        label,
        tone: activity.tone === "approval" ? "info" : activity.tone,
        activityKind: activity.kind,
      };
      if (activity.turnId) {
        entry.turnId = activity.turnId;
      }
      const itemType = extractWorkLogItemType(payload);
      const requestKind = extractWorkLogRequestKind(payload);
      const detailSource =
        toolPayload?.detail ??
        (payload && typeof payload.detail === "string" && payload.detail.length > 0
          ? payload.detail
          : undefined);
      if (detailSource) {
        const detail = stripTrailingExitCode(detailSource).output;
        if (detail) {
          entry.detail = detail;
        }
      }
      if (toolPayload?.command) {
        entry.command = toolPayload.command;
      }
      if (toolPayload?.providerItemId) {
        entry.providerItemId = toolPayload.providerItemId;
      }
      const payloadProviderItemId = providerItemIdFromPayload(payload);
      if (diagnostic && payloadProviderItemId) {
        entry.parentProviderItemId = payloadProviderItemId;
      }
      const displayHints = extractWorkLogDisplayHints({
        payload,
        toolPayload,
        ...(entry.detail ? { detail: entry.detail } : {}),
      });
      if (displayHints.readPaths && displayHints.readPaths.length > 0) {
        entry.readPaths = displayHints.readPaths;
      }
      if (displayHints.lineSummary) {
        entry.lineSummary = displayHints.lineSummary;
      }
      if (displayHints.searchSummary) {
        entry.searchSummary = displayHints.searchSummary;
      }
      if (toolPayload?.changedFiles && toolPayload.changedFiles.length > 0) {
        entry.changedFiles = toolPayload.changedFiles;
      }
      if (toolPayload?.title) {
        entry.toolTitle = toolPayload.title;
      }
      const inferredStatus = inferWorkLogStatus(activity, toolPayload?.status);
      if (inferredStatus) {
        entry.status = inferredStatus;
      }
      if (toolPayload?.fileChangeId) {
        entry.fileChangeId = toolPayload.fileChangeId;
      }
      if (itemType) {
        entry.itemType = itemType;
      }
      if (requestKind) {
        entry.requestKind = requestKind;
      }
      if (toolPayload?.subagentType) {
        entry.subagentType = toolPayload.subagentType;
      }
      if (toolPayload?.subagentDescription) {
        entry.subagentDescription = toolPayload.subagentDescription;
      }
      if (toolPayload?.subagentPrompt) {
        entry.subagentPrompt = toolPayload.subagentPrompt;
      }
      if (toolPayload?.subagentResult) {
        entry.subagentResult = toolPayload.subagentResult;
      }
      if (toolPayload?.subagentModel) {
        entry.subagentModel = toolPayload.subagentModel;
      }
      if (toolPayload?.subagentThreadId) {
        entry.subagentThreadId = toolPayload.subagentThreadId;
      }
      if (toolPayload?.subagentPath) {
        entry.subagentPath = toolPayload.subagentPath;
      }
      if (toolPayload?.subagentSenderThreadId) {
        entry.subagentSenderThreadId = toolPayload.subagentSenderThreadId;
      }
      if (
        toolPayload?.subagentReceiverThreadIds &&
        toolPayload.subagentReceiverThreadIds.length > 0
      ) {
        entry.subagentReceiverThreadIds = toolPayload.subagentReceiverThreadIds;
      }
      if (toolPayload?.codexCollaborationTool) {
        entry.codexCollaborationTool = toolPayload.codexCollaborationTool;
      }
      if (toolPayload?.subagentStates && toolPayload.subagentStates.length > 0) {
        entry.subagentStates = toolPayload.subagentStates;
      }
      if (toolPayload?.subagentStatesTruncated) {
        entry.subagentStatesTruncated = true;
      }
      if (toolPayload?.mcpServerName) {
        entry.mcpServerName = toolPayload.mcpServerName;
      }
      if (toolPayload?.mcpToolName) {
        entry.mcpToolName = toolPayload.mcpToolName;
      }
      if (toolPayload?.mcpInput) {
        entry.mcpInput = toolPayload.mcpInput;
      }
      if (toolPayload?.mcpResult) {
        entry.mcpResult = toolPayload.mcpResult;
      }
      if (diagnostic) {
        entry.diagnostic = diagnostic;
        entry.category = diagnostic.type === "hook" ? "hook" : "review";
      } else if (toolPayload) {
        entry.category = "tool";
      } else if (
        activity.kind === "runtime.warning" ||
        activity.kind === "runtime.error" ||
        activity.kind === "auth.status" ||
        activity.kind === "config.warning"
      ) {
        entry.category = "issue";
      } else {
        entry.category = "other";
      }
      if (activity.kind === "runtime.warning" && warningCategory) {
        entry.warningCategory = warningCategory;
      }
      if (activity.kind === "runtime.warning") {
        const detail = asUnknownRecord(payload?.detail);
        const warningProtocolMethod =
          asTrimmedString(payload?.protocolMethod) ??
          asTrimmedString(detail?.method) ??
          asTrimmedString(detail?.requestMethod);
        const warningProtocolValue =
          asTrimmedString(payload?.protocolValue) ??
          asTrimmedString(detail?.itemType) ??
          asTrimmedString(detail?.type) ??
          asTrimmedString(detail?.kind);
        if (warningProtocolMethod) {
          entry.warningProtocolMethod = warningProtocolMethod;
        }
        if (warningProtocolValue) {
          entry.warningProtocolValue = warningProtocolValue;
        }
      }
      entry.isIssue = isWorkLogIssue(entry);
      return entry;
    });

  const deduped = dedupeProviderItemWorkLogEntries(
    coalesceCodexCollaborationEntries(correlateSubagentActivities(entries)),
  );
  const paired = pairDiagnosticLifecycles(deduped);
  const modeFiltered = paired.filter((entry) => {
    if (mode === "diagnostics") {
      return true;
    }
    if (
      (entry.activityKind === "hook.started" || entry.activityKind === "approval-review.started") &&
      entry.diagnostic?.incomplete !== true
    ) {
      return false;
    }
    if (entry.diagnostic?.type === "hook") {
      return isWorkLogIssue(entry);
    }
    if (entry.diagnostic?.type === "approval-review") {
      return isWorkLogIssue(entry);
    }
    return true;
  });
  const filtered = modeFiltered.filter((entry) => {
    switch (selectedFilter) {
      case "tools":
        return entry.category === "tool";
      case "hooks":
        return entry.category === "hook";
      case "issues":
        return entry.isIssue === true;
      case "all":
        return true;
    }
  });
  return coalesceProtocolWarnings(filtered);
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return normalized.length > 0 ? normalized : undefined;
}

function extractWorkLogDisplayHints(input: {
  payload: Record<string, unknown> | null;
  toolPayload: ReturnType<typeof readToolActivityPayload>;
  detail?: string;
}): Pick<WorkLogEntry, "lineSummary" | "readPaths" | "searchSummary"> {
  const payloadReadPaths = normalizeStringList(input.payload?.readPaths);
  const payloadLineSummary = asTrimmedString(input.payload?.lineSummary);
  const payloadSearchSummary = asTrimmedString(input.payload?.searchSummary);
  const readPaths = input.toolPayload?.readPaths ?? payloadReadPaths;
  const lineSummary = input.toolPayload?.lineSummary ?? payloadLineSummary;
  const searchSummary = input.toolPayload?.searchSummary ?? payloadSearchSummary;
  const fallbackHints =
    !readPaths && !lineSummary && !searchSummary && input.detail
      ? deriveNarratedActivityDisplayHints(input.detail)
      : null;
  const resolvedReadPaths = readPaths ?? fallbackHints?.readPaths;
  const resolvedLineSummary = lineSummary ?? fallbackHints?.lineSummary;
  const resolvedSearchSummary = searchSummary ?? fallbackHints?.searchSummary;

  return {
    ...(resolvedReadPaths ? { readPaths: resolvedReadPaths } : {}),
    ...(resolvedLineSummary ? { lineSummary: resolvedLineSummary } : {}),
    ...(resolvedSearchSummary ? { searchSummary: resolvedSearchSummary } : {}),
  };
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  return readToolActivityPayload(payload)?.itemType;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change" ||
    payload?.requestKind === "permission" ||
    payload?.requestKind === "unknown"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function isGenericToolActivitySummary(value: string): boolean {
  return /^(?:tool(?: call)?(?: (?:started|updated))?|tool)$/i.test(value.trim());
}

function isCommandToolLifecycleActivity(activity: OrchestrationThreadActivity): boolean {
  if (
    activity.kind !== "tool.started" &&
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed"
  ) {
    return false;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return extractWorkLogItemType(payload) === "command_execution";
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
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

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
  commandExecutions: ReadonlyArray<OrchestrationCommandExecutionSummary> = [],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const diagnosticEntries = workEntries.filter((entry) => entry.diagnostic !== undefined);
  const regularWorkEntries = workEntries
    .filter((entry) => entry.diagnostic === undefined)
    .map((entry) => ({ ...entry }));
  const pendingDiagnosticsByProviderItemId = new Map<string, WorkLogEntry[]>();
  for (const diagnostic of diagnosticEntries) {
    if (!diagnostic.parentProviderItemId) {
      continue;
    }
    const key = String(diagnostic.parentProviderItemId);
    const existing = pendingDiagnosticsByProviderItemId.get(key) ?? [];
    existing.push(diagnostic);
    pendingDiagnosticsByProviderItemId.set(key, existing);
  }
  const takeDiagnostics = (providerItemId: ProviderItemId | null | undefined) => {
    if (!providerItemId) {
      return undefined;
    }
    const key = String(providerItemId);
    const diagnostics = pendingDiagnosticsByProviderItemId.get(key);
    if (!diagnostics) {
      return undefined;
    }
    pendingDiagnosticsByProviderItemId.delete(key);
    return diagnostics;
  };

  const workRows: TimelineEntry[] = regularWorkEntries.map((entry) => {
    const nestedDiagnostics = takeDiagnostics(entry.providerItemId);
    const nestedEntry = nestedDiagnostics ? { ...entry, nestedDiagnostics } : entry;
    return {
      id: nestedEntry.id,
      kind: "work",
      createdAt: nestedEntry.createdAt,
      entry: nestedEntry,
    };
  });
  const commandRows = deriveCommandTimelineEntries(commandExecutions).map((row) => {
    if (row.kind === "work") {
      const nestedDiagnostics = takeDiagnostics(row.entry.providerItemId);
      return nestedDiagnostics ? { ...row, entry: { ...row.entry, nestedDiagnostics } } : row;
    }
    if (row.kind === "command") {
      const nestedDiagnostics = takeDiagnostics(row.commandExecution.providerItemId);
      return nestedDiagnostics ? { ...row, nestedDiagnostics } : row;
    }
    return row;
  });
  const uncorrelatedDiagnosticRows: TimelineEntry[] = diagnosticEntries
    .filter(
      (entry) =>
        !entry.parentProviderItemId ||
        pendingDiagnosticsByProviderItemId.has(String(entry.parentProviderItemId)),
    )
    .map((entry) => ({
      id: entry.id,
      kind: "work",
      createdAt: entry.createdAt,
      entry,
    }));
  return [
    ...messageRows,
    ...proposedPlanRows,
    ...workRows,
    ...uncorrelatedDiagnosticRows,
    ...commandRows,
  ].toSorted(compareTimelineEntries);
}

export function deriveCommandTimelineEntries(
  executions: ReadonlyArray<OrchestrationCommandExecutionSummary>,
): TimelineEntry[] {
  return [...executions].toSorted(compareCommandExecutions).map((commandExecution) => {
    const commandClassification = classifyCompactCommand(commandExecution.command);
    if (commandClassification.kind === "file-read") {
      const label =
        commandExecution.title && !isGenericCommandTitle(commandExecution.title)
          ? commandExecution.title
          : "Read file";
      return {
        id: commandExecution.id,
        kind: "work" as const,
        createdAt: commandExecution.startedAt,
        entry: {
          id: commandExecution.id,
          createdAt: commandExecution.startedAt,
          label,
          ...(commandExecution.cwd ? { cwd: commandExecution.cwd } : {}),
          tone: "tool" as const,
          turnId: commandExecution.turnId,
          ...(commandExecution.providerItemId
            ? { providerItemId: commandExecution.providerItemId }
            : {}),
          changedFiles: commandClassification.fileRead.filePaths,
          requestKind: "file-read" as const,
          toolTitle: label,
          ...(commandClassification.fileRead.lineSummary
            ? { detail: commandClassification.fileRead.lineSummary }
            : {}),
        },
      };
    }

    if (commandClassification.kind === "search") {
      const label =
        commandExecution.title && !isGenericCommandTitle(commandExecution.title)
          ? commandExecution.title
          : commandClassification.summary;
      return {
        id: commandExecution.id,
        kind: "work" as const,
        createdAt: commandExecution.startedAt,
        entry: {
          id: commandExecution.id,
          createdAt: commandExecution.startedAt,
          label,
          ...(commandExecution.cwd ? { cwd: commandExecution.cwd } : {}),
          tone: "tool" as const,
          turnId: commandExecution.turnId,
          ...(commandExecution.providerItemId
            ? { providerItemId: commandExecution.providerItemId }
            : {}),
          itemType: "command_execution" as const,
          requestKind: "command" as const,
          toolTitle: label,
        },
      };
    }

    return {
      id: commandExecution.id,
      kind: "command" as const,
      createdAt: commandExecution.startedAt,
      commandExecution,
    };
  });
}

function compareTimelineEntries(left: TimelineEntry, right: TimelineEntry): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  if (left.kind === "command" && right.kind === "command") {
    return (
      left.commandExecution.startedSequence - right.commandExecution.startedSequence ||
      left.commandExecution.id.localeCompare(right.commandExecution.id)
    );
  }
  return left.id.localeCompare(right.id);
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
