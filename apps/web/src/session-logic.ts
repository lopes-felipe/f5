import { readMcpAppView, type McpAppView } from "@t3tools/shared/mcpApp";
import { HtmlRenderReference } from "@t3tools/contracts";
import { recordBrowserWork } from "./lib/performanceCounters";
import { messageListStructure } from "./lib/streamingTextRevision";
import { Schema } from "effect";
import {
  AGENT_BRIDGE_TURN_SUBMITTED_ACTIVITY_KIND,
  ApprovalRequestId,
  ProviderApprovalOption,
  ProviderApprovalPresentation,
  ElicitationDescriptor,
  type ElicitationReceiptState,
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
import { ELICITATION_SUBMITTED_ACTIVITY_KIND } from "@t3tools/shared/pendingUserInputs";
import {
  normalizeCodexCollaborationTool,
  REASONING_STATUS_ACTIVITY_KIND,
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
  resolveCommandExecutionSummaryText,
} from "@t3tools/shared/commandSummary";
import { compareCommandExecutions } from "./lib/commandExecutions";
import { formatUsageLimitActivityLabel, readUsageLimitActivityDisplay } from "./lib/usageLimits";
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
  { value: "antigravity", label: "Antigravity", available: true },
  { value: "muse", label: "Muse Code", available: true },
  { value: "acp", label: "Custom ACP agent", available: true },
  { value: "pi", label: "Pi", available: true },
];

export interface WorkLogEntry {
  htmlRender?: HtmlRenderReference;
  mcpApp?: McpAppView;
  imagePath?: string;
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
  computerTool?: boolean;
  mcpInput?: string;
  mcpResult?: string;
  mcpImages?: ReadonlyArray<{ attachmentId: string; mimeType: string; sizeBytes: number }>;
  mcpImagesOmitted?: number;
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
  appName?: string;
  approvalOptions?: ReadonlyArray<ProviderApprovalOption>;
  presentation?: ProviderApprovalPresentation;
  requestType?: string;
  createdAt: string;
  detail?: string;
  requestedPermissions?: Record<string, unknown>;
}

export interface PendingUserInput {
  responseMode?: "message" | undefined;
  blocking?: boolean | undefined;
  elicitation?: ElicitationDescriptor | undefined;
  receipt?: ElicitationReceiptState | undefined;
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
  if (durationMs >= 3_599_500) {
    const minutes = Math.round(durationMs / 60_000);
    return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`;
  }
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
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
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
        payload.requestKind === "mcp-elicitation" ||
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
      const approvalOptions = Array.isArray(payload?.approvalOptions)
        ? payload.approvalOptions.filter(Schema.is(ProviderApprovalOption))
        : undefined;
      const presentation = Schema.decodeUnknownOption(ProviderApprovalPresentation)(
        payload?.presentation,
      );
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(requestKind === "mcp-elicitation"
          ? {
              appName: typeof payload?.appName === "string" ? payload.appName : "MCP app",
              approvalOptions: approvalOptions ?? [],
            }
          : approvalOptions?.length
            ? { approvalOptions }
            : {}),
        ...(presentation._tag === "Some" ? { presentation: presentation.value } : {}),
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
      if (question.options.length > 0 && options.length === 0) return null;
      const parsedQuestion: {
        id: string;
        header: string;
        question: string;
        options: UserInputQuestion["options"];
        multiSelect?: boolean;
        optional?: boolean;
        initialAnswer?: string;
      } = {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
      if (typeof question.initialAnswer === "string" && question.initialAnswer.length <= 64 * 1024)
        parsedQuestion.initialAnswer = question.initialAnswer;
      if (typeof question.optional === "boolean") parsedQuestion.optional = question.optional;
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
      const elicitation = Schema.decodeUnknownOption(ElicitationDescriptor)(payload?.elicitation);
      const questions =
        parseUserInputQuestions(payload) ?? (elicitation._tag === "Some" ? [] : null);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        ...(payload?.responseMode === "message" ? { responseMode: "message" as const } : {}),
        ...(payload?.blocking === false ? { blocking: false } : {}),
        ...(elicitation._tag === "Some" ? { elicitation: elicitation.value } : {}),
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === ELICITATION_SUBMITTED_ACTIVITY_KIND && requestId) {
      const open = openByRequestId.get(requestId);
      if (open?.elicitation && !open.receipt)
        openByRequestId.set(requestId, { ...open, receipt: "submitted" });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      const open = openByRequestId.get(requestId);
      if (payload?.receipt === "indeterminate" && open) {
        openByRequestId.set(requestId, { ...open, receipt: "indeterminate" });
        continue;
      }
      if (
        open?.receipt === "indeterminate" &&
        payload?.receipt !== "resolved" &&
        payload?.receipt !== "cancelled"
      )
        continue;
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
  // "Sent by … via F5 Agent Bridge" stays visible after later turns.
  AGENT_BRIDGE_TURN_SUBMITTED_ACTIVITY_KIND,
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
  if (!latestTurnId || activity.kind === "htmlRender" || activity.kind === "mcpApp") {
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
    htmlRender: entry.htmlRender,
    mcpApp: entry.mcpApp?.reference.attachmentId,
    label: entry.label,
    toolTitle: entry.toolTitle,
    itemType: entry.itemType,
    requestKind: entry.requestKind,
    detail: entry.detail,
    imagePath: entry.imagePath,
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
    computerTool: entry.computerTool,
    mcpInput: entry.mcpInput,
    mcpResult: entry.mcpResult,
    mcpImages: entry.mcpImages?.map((image) => image.attachmentId) ?? [],
    mcpImagesOmitted: entry.mcpImagesOmitted,
  });
}

function dedupeProviderItemWorkLogEntries(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const deduped: Array<WorkLogEntry | null> = [];
  const latestByProviderItemId = new Map<ProviderItemId, { index: number; signature: string }>();
  const terminalTieKeys = new Set<string>();

  for (const entry of entries) {
    if (!entry.providerItemId) {
      deduped.push(entry);
      continue;
    }

    // A non-terminal snapshot sorting after its item's terminal entry with
    // the same createdAt is an ordering artifact: providers can emit the
    // final update and the completion in the same millisecond, and without an
    // activity sequence the tie falls back to random ids. Keeping it would
    // regress a finished item to in-progress and hide its inline diff. A
    // later-stamped in-progress update (a task backgrounded after its tool
    // result, or a reused item id in another turn) is real and stays.
    const tieKey = `${entry.providerItemId}\u0000${entry.createdAt}`;
    if (workEntryLifecyclePrecedence(entry) === TERMINAL_LIFECYCLE_PRECEDENCE) {
      terminalTieKeys.add(tieKey);
    } else if (terminalTieKeys.has(tieKey)) {
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

const TERMINAL_LIFECYCLE_PRECEDENCE = 2;

function workEntryLifecyclePrecedence(entry: WorkLogEntry): number {
  if (entry.status === "completed" || entry.status === "failed" || entry.status === "declined") {
    return TERMINAL_LIFECYCLE_PRECEDENCE;
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
      workEntryLifecyclePrecedence(entry) >= workEntryLifecyclePrecedence(existing)
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

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Each user-input request's question text, joined with " · " when it asked several. */
function userInputQuestionTextByRequestId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, string> {
  const questions = new Map<string, string>();
  for (const activity of activities) {
    if (activity.kind !== "user-input.requested") continue;
    const payload = workLogPayload(activity);
    if (typeof payload?.requestId !== "string") continue;
    const text = (parseUserInputQuestions(payload) ?? [])
      .map((question) => collapseWhitespace(question.question))
      .filter(Boolean)
      .join(" · ");
    if (text) questions.set(payload.requestId, text);
  }
  return questions;
}

/** The submitted answers as one line; empty when nothing was answered. */
function userInputAnswerPreview(answers: unknown): string {
  if (!answers || typeof answers !== "object") return "";
  const values = Object.values(answers as Record<string, unknown>).flatMap((value) => {
    const answer =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { answers?: unknown }).answers
        : value;
    return (Array.isArray(answer) ? answer : [answer]).filter(
      (item): item is string => typeof item === "string",
    );
  });
  return values.map(collapseWhitespace).filter(Boolean).join(" · ");
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

export type LiveWorkActivity =
  | { kind: "thinking"; detail: string | null }
  | {
      kind: "tool";
      providerItemId: string | null;
      title: string;
      /** The turn's latest reasoning heading, kept in view while a later tool runs. */
      thought?: string;
    }
  /** The provider is retrying a dropped model stream; `attempt` reads like "2/5". */
  | { kind: "reconnecting"; attempt: string | null }
  /**
   * The turn runs with no tool, reasoning, or hook open and does not wait on
   * the user, so the model is most likely producing its next step. Codex
   * reports reasoning only once it has finished, so this covers it. Work the
   * activities do not show, such as provider context compaction, reads the
   * same.
   */
  | { kind: "idle" }
  | null;

/**
 * The turn whose live activity the Working label may show: only a running
 * session whose active turn is the latest turn. Sending or connecting before
 * a turn exists, terminal/error sessions, and a stale `activeTurnId` get none.
 */
export function deriveLiveWorkTurnId(
  session: Pick<ThreadSession, "status" | "activeTurnId"> | null | undefined,
  latestTurnId: TurnId | null | undefined,
): TurnId | undefined {
  return session?.status === "running" && latestTurnId && session.activeTurnId === latestTurnId
    ? latestTurnId
    : undefined;
}

/** A running command reads as its command, not the provider's "Ran command". */
function liveToolTitle(
  activity: OrchestrationThreadActivity,
  payload: ReturnType<typeof readToolActivityPayload>,
): string {
  if (payload?.itemType === "command_execution" && payload.command) {
    return resolveCommandExecutionSummaryText({
      command: payload.command,
      detail: payload.detail ?? null,
      title: payload.title ?? null,
    });
  }
  return payload?.title ?? activity.summary.replace(/ started$/, "");
}

function isTerminalItemStatus(status: RuntimeItemStatus | undefined): boolean {
  return status === "completed" || status === "failed" || status === "declined";
}

function asPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

/** A provider error it will retry, such as Codex's "Reconnecting... 2/5". */
function isRetryingWarning(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "runtime.warning" &&
    asPayloadRecord(asPayloadRecord(activity.payload)?.detail)?.willRetry === true
  );
}

/**
 * When the activity last changed. The reasoning status is upserted in place
 * and keeps its first `createdAt`, so its latest write carries `updatedAt`.
 */
function activityChangedAt(activity: OrchestrationThreadActivity): string {
  if (activity.kind !== REASONING_STATUS_ACTIVITY_KIND) return activity.createdAt;
  return asTrimmedString(asPayloadRecord(activity.payload)?.updatedAt) ?? activity.createdAt;
}

/**
 * Activities that show the model stream produced something. Status and
 * metadata activities (plans, MCP status, hooks, warnings) arrive without
 * it, so they cannot prove that a stream retry recovered.
 */
const MODEL_PROGRESS_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  REASONING_STATUS_ACTIVITY_KIND,
  "tool.started",
  "tool.updated",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
]);

/**
 * When an assistant message of the turn last showed output. Assistant text
 * is a message rather than an activity, so it reaches the live label here.
 */
export function deriveLatestAssistantOutputAt(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "turnId" | "createdAt" | "completedAt">>,
  turnId: TurnId | undefined,
): string | null {
  if (!turnId) return null;
  let latest: string | null = null;
  for (const message of messages) {
    if (message.role !== "assistant" || message.turnId !== turnId) continue;
    const at = message.completedAt ?? message.createdAt;
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

/**
 * What the latest turn is doing right now: the most recently started item
 * that has not finished. A completion only closes its own item, so a
 * background tool finishing does not hide a newer tool or active reasoning.
 * A terminal status is final for its item: activities without a session
 * sequence can sort a start after its completion when timestamps tie.
 * With nothing open, a turn waiting on the user or running a hook reads as
 * generic work; a stream retry that no model output has followed yet reads
 * as reconnecting; otherwise the model is between items.
 */
export function deriveLiveWorkActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options?: {
    /** A pending approval, question, or blocking form. */
    readonly awaitingUser?: boolean;
    /** From {@link deriveLatestAssistantOutputAt}. */
    readonly latestAssistantOutputAt?: string | null;
  },
): LiveWorkActivity {
  if (!latestTurnId) return null;
  const ordered = activities
    .filter((activity) => activity.turnId === latestTurnId)
    .toSorted(compareActivitiesByOrder);
  const items = new Map<
    string,
    {
      startIndex: number;
      status: RuntimeItemStatus | undefined;
      activity: Exclude<LiveWorkActivity, null>;
    }
  >();
  // The latest model progress; the index breaks timestamp ties.
  let progressAt = "";
  let progressIndex = -1;
  const openHookIds = new Set<string>();
  ordered.forEach((activity, index) => {
    if (MODEL_PROGRESS_ACTIVITY_KINDS.has(activity.kind)) {
      const changedAt = activityChangedAt(activity);
      if (changedAt > progressAt || (changedAt === progressAt && index > progressIndex)) {
        progressAt = changedAt;
        progressIndex = index;
      }
    }
    if (activity.kind === "hook.started" || activity.kind === "hook.completed") {
      const hookId = asTrimmedString(asPayloadRecord(activity.payload)?.hookId);
      if (hookId && activity.kind === "hook.started") openHookIds.add(hookId);
      if (hookId && activity.kind === "hook.completed") openHookIds.delete(hookId);
      return;
    }
    if (activity.kind === REASONING_STATUS_ACTIVITY_KIND) {
      const payload = asPayloadRecord(activity.payload);
      const detail = asTrimmedString(payload?.detail) ?? null;
      items.set(activity.id, {
        startIndex: index,
        status: payload?.state === "active" ? "inProgress" : "completed",
        activity: { kind: "thinking", detail },
      });
      return;
    }
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      return;
    }
    const payload = readToolActivityPayload(activity.payload);
    const status =
      activity.kind === "tool.started"
        ? "inProgress"
        : inferWorkLogStatus(activity, payload?.status);
    if (!payload?.providerItemId) {
      // Without an item id a completion cannot name its start; it closes
      // every id-less tool started before it.
      if (activity.kind === "tool.started") {
        items.set(activity.id, {
          startIndex: index,
          status,
          activity: { kind: "tool", providerItemId: null, title: liveToolTitle(activity, payload) },
        });
      } else if (isTerminalItemStatus(status)) {
        for (const [key, item] of items) {
          if (item.activity.kind === "tool" && item.activity.providerItemId === null) {
            items.set(key, { ...item, status });
          }
        }
      }
      return;
    }
    const existing = items.get(payload.providerItemId);
    items.set(payload.providerItemId, {
      startIndex: existing ? Math.min(existing.startIndex, index) : index,
      status: isTerminalItemStatus(existing?.status) ? existing?.status : status,
      activity: {
        kind: "tool",
        providerItemId: payload.providerItemId,
        title: liveToolTitle(activity, payload),
      },
    });
  });
  let live: { startIndex: number; activity: Exclude<LiveWorkActivity, null> } | null = null;
  for (const item of items.values()) {
    if (item.status !== "inProgress") continue;
    if (!live || item.startIndex > live.startIndex) live = item;
  }
  if (live) {
    if (live.activity.kind !== "tool") return live.activity;
    // A thought is often a finding; without this, the next tool call hides it.
    let thought: string | null = null;
    let thoughtIndex = -1;
    for (const item of items.values()) {
      if (
        item.activity.kind === "thinking" &&
        item.activity.detail &&
        item.startIndex > thoughtIndex
      ) {
        thought = item.activity.detail;
        thoughtIndex = item.startIndex;
      }
    }
    return thought ? { ...live.activity, thought } : live.activity;
  }
  if (options?.awaitingUser) return null;
  const retryIndex = ordered.findLastIndex(isRetryingWarning);
  const retry = ordered[retryIndex];
  if (retry) {
    const assistantOutputAt = options?.latestAssistantOutputAt ?? "";
    const recovered =
      progressAt > retry.createdAt ||
      (progressAt === retry.createdAt && progressIndex > retryIndex) ||
      assistantOutputAt >= retry.createdAt;
    if (!recovered) {
      const message = asTrimmedString(asPayloadRecord(retry.payload)?.message);
      const attempt = message?.match(/\d+\s*\/\s*\d+/)?.[0].replace(/\s+/g, "") ?? null;
      return { kind: "reconnecting", attempt };
    }
  }
  if (openHookIds.size > 0) return null;
  return { kind: "idle" };
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
  // A usage limit arrives as one warning per exhausted window and then as the
  // turn's error; show one row per turn. The error carries the combined reset,
  // so it wins; until it arrives, the latest warning stands in.
  const usageLimitRowByTurn = new Map<TurnId, OrchestrationThreadActivity>();
  for (const activity of ordered) {
    if (
      (activity.kind !== "runtime.warning" && activity.kind !== "runtime.error") ||
      !activity.turnId ||
      !readUsageLimitActivityDisplay(workLogPayload(activity)?.usageLimit)
    ) {
      continue;
    }
    if (
      usageLimitRowByTurn.get(activity.turnId)?.kind !== "runtime.error" ||
      activity.kind === "runtime.error"
    ) {
      usageLimitRowByTurn.set(activity.turnId, activity);
    }
  }
  const userInputQuestionByRequestId = userInputQuestionTextByRequestId(ordered);
  const entries = ordered
    .filter((activity) =>
      shouldKeepHistoricalWorkEntry(activity, latestTurnId, terminalCodexProviderItemIds),
    )
    .filter(
      (activity) =>
        (activity.kind !== "runtime.warning" && activity.kind !== "runtime.error") ||
        !activity.turnId ||
        !readUsageLimitActivityDisplay(workLogPayload(activity)?.usageLimit) ||
        usageLimitRowByTurn.get(activity.turnId)?.id === activity.id,
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
        payload?.actionable === true ||
        readUsageLimitActivityDisplay(payload?.usageLimit) !== null;
      return alwaysVisible || runtimeWarningVisibility !== "hidden";
    })
    .filter(
      (activity) =>
        activity.kind !== "tool.started" ||
        Boolean(readToolActivityPayload(activity.payload)?.codexCollaborationTool),
    )
    .filter((activity) => activity.kind !== "runtime.configured")
    .filter((activity) => activity.kind !== REASONING_STATUS_ACTIVITY_KIND)
    .filter((activity) => activity.kind !== "account.updated")
    .filter((activity) => activity.kind !== "account.rate-limits.updated")
    .filter((activity) => activity.kind !== "task.started" && activity.kind !== "task.completed")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .map((activity) => {
      const toolPayload = readToolActivityPayload(activity.payload);
      const payload = workLogPayload(activity);
      const diagnostic = diagnosticFromActivity(activity, payload);
      const warningCategory = asTrimmedString(payload?.category);
      const usageLimit =
        activity.kind === "runtime.warning" || activity.kind === "runtime.error"
          ? readUsageLimitActivityDisplay(payload?.usageLimit)
          : null;
      const label = usageLimit
        ? formatUsageLimitActivityLabel(usageLimit)
        : diagnostic?.type === "hook" &&
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
      // "User input submitted" buries what was asked: lead with the question and keep the
      // answer as the row's detail.
      const answeredQuestion =
        activity.kind === "user-input.resolved" && typeof payload?.requestId === "string"
          ? userInputQuestionByRequestId.get(payload.requestId)
          : undefined;
      const answerPreview = answeredQuestion ? userInputAnswerPreview(payload?.answers) : "";
      const entry: WorkLogEntry = {
        id: activity.id,
        createdAt: activity.createdAt,
        label: answeredQuestion && answerPreview ? answeredQuestion : label,
        tone: usageLimit || activity.tone === "approval" ? "info" : activity.tone,
        activityKind: activity.kind,
        ...(answeredQuestion && answerPreview ? { detail: answerPreview } : {}),
      };
      if (activity.kind === "mcpApp") {
        const app = readMcpAppView(payload);
        if (app) entry.mcpApp = app;
      }
      if (activity.kind === "htmlRender") {
        const parsed = Schema.decodeUnknownOption(HtmlRenderReference)(payload?.htmlRender);
        if (parsed._tag === "Some") entry.htmlRender = parsed.value;
      }
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
      if (toolPayload?.imagePath) entry.imagePath = toolPayload.imagePath;
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
      if (toolPayload?.computerTool === true) entry.computerTool = true;
      if (toolPayload?.mcpToolName) {
        entry.mcpToolName = toolPayload.mcpToolName;
      }
      if (toolPayload?.mcpInput) {
        entry.mcpInput = toolPayload.mcpInput;
      }
      if (toolPayload?.mcpResult) {
        entry.mcpResult = toolPayload.mcpResult;
      }
      if (toolPayload?.mcpImages) {
        entry.mcpImages = toolPayload.mcpImages;
      }
      if (toolPayload?.mcpImagesOmitted) {
        entry.mcpImagesOmitted = toolPayload.mcpImagesOmitted;
      }
      if (diagnostic) {
        entry.diagnostic = diagnostic;
        entry.category = diagnostic.type === "hook" ? "hook" : "review";
      } else if (toolPayload || entry.mcpApp) {
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
      entry.isIssue = usageLimit !== null || isWorkLogIssue(entry);
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

/**
 * Per-caller reuse state for `deriveTimelineEntries`, typically held in a
 * `useRef`. An entry whose source objects are unchanged keeps its previous
 * object, and an unchanged entry list keeps its previous array, so memoized
 * timeline rows only re-render when their own entry changed.
 */
const timelineStructures = new WeakMap<ReadonlyArray<TimelineEntry>, object>();
export const timelineEntriesStructure = (
  entries: ReadonlyArray<TimelineEntry>,
): object | undefined => timelineStructures.get(entries);
const EMPTY_COMMAND_EXECUTIONS: ReadonlyArray<OrchestrationCommandExecutionSummary> = [];

export interface TimelineEntryCache {
  structure?: object;
  otherSources?: ReadonlyArray<unknown>;
  structuralDerivations: number;
  contentUpdates: number;
  entries: Map<string, { readonly sources: ReadonlyArray<unknown>; readonly entry: TimelineEntry }>;
  result: TimelineEntry[] | null;
}

export function createTimelineEntryCache(): TimelineEntryCache {
  return { entries: new Map(), result: null, structuralDerivations: 0, contentUpdates: 0 };
}

function sameSources(left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
  commandExecutions: ReadonlyArray<OrchestrationCommandExecutionSummary> = EMPTY_COMMAND_EXECUTIONS,
  cache?: TimelineEntryCache,
): TimelineEntry[] {
  const structure = messageListStructure(messages);
  const otherSources = [proposedPlans, workEntries, commandExecutions];
  if (
    cache?.result &&
    cache.structure === structure &&
    cache.otherSources &&
    sameSources(cache.otherSources, otherSources)
  ) {
    const byId = new Map<string, ChatMessage>(messages.map((message) => [message.id, message]));
    let changed = false;
    const result = cache.result.map((entry) => {
      if (entry.kind !== "message") return entry;
      const message = byId.get(entry.id);
      if (!message || message === entry.message) return entry;
      changed = true;
      const next = { ...entry, message };
      cache.entries.set(entry.id, { sources: [message], entry: next });
      return next;
    });
    if (changed) {
      const identity = timelineStructures.get(cache.result);
      if (identity) timelineStructures.set(result, identity);
      cache.contentUpdates++;
      recordBrowserWork("timelineContentUpdates");
      cache.result = result;
    }
    return cache.result;
  }
  if (cache) {
    cache.structure = structure;
    cache.otherSources = otherSources;
    cache.structuralDerivations++;
    recordBrowserWork("timelineDerivations");
  }
  const nextCacheEntries: TimelineEntryCache["entries"] = new Map();
  const reuse = (
    id: string,
    sources: ReadonlyArray<unknown>,
    build: () => TimelineEntry,
  ): TimelineEntry => {
    const cached = cache?.entries.get(id);
    const entry = cached && sameSources(cached.sources, sources) ? cached.entry : build();
    nextCacheEntries.set(id, { sources, entry });
    return entry;
  };

  const messageRows: TimelineEntry[] = messages.map((message) =>
    reuse(message.id, [message], () => ({
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    })),
  );
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) =>
    reuse(proposedPlan.id, [proposedPlan], () => ({
      id: proposedPlan.id,
      kind: "proposed-plan",
      createdAt: proposedPlan.createdAt,
      proposedPlan,
    })),
  );
  const diagnosticEntries = workEntries.filter((entry) => entry.diagnostic !== undefined);
  const regularWorkEntries = workEntries.filter((entry) => entry.diagnostic === undefined);
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
    return reuse(entry.id, [entry, ...(nestedDiagnostics ?? [])], () => {
      const nestedEntry = nestedDiagnostics ? { ...entry, nestedDiagnostics } : entry;
      return {
        id: nestedEntry.id,
        kind: "work",
        createdAt: nestedEntry.createdAt,
        entry: nestedEntry,
      };
    });
  });
  const commandRows = [...commandExecutions]
    .toSorted(compareCommandExecutions)
    .map((commandExecution) => {
      const providerItemId = commandExecution.providerItemId;
      const nestedDiagnostics = takeDiagnostics(providerItemId);
      return reuse(commandExecution.id, [commandExecution, ...(nestedDiagnostics ?? [])], () => {
        const row = commandTimelineEntry(commandExecution);
        if (!nestedDiagnostics) return row;
        if (row.kind === "work") return { ...row, entry: { ...row.entry, nestedDiagnostics } };
        if (row.kind === "command") return { ...row, nestedDiagnostics };
        return row;
      });
    });
  const uncorrelatedDiagnosticRows: TimelineEntry[] = diagnosticEntries
    .filter(
      (entry) =>
        !entry.parentProviderItemId ||
        pendingDiagnosticsByProviderItemId.has(String(entry.parentProviderItemId)),
    )
    .map((entry) =>
      reuse(entry.id, [entry], () => ({
        id: entry.id,
        kind: "work",
        createdAt: entry.createdAt,
        entry,
      })),
    );
  const result = [
    ...messageRows,
    ...proposedPlanRows,
    ...workRows,
    ...uncorrelatedDiagnosticRows,
    ...commandRows,
  ].toSorted(compareTimelineEntries);
  timelineStructures.set(result, {});
  if (!cache) return result;
  cache.entries = nextCacheEntries;
  if (cache.result && sameSources(cache.result, result)) return cache.result;
  cache.result = result;
  return result;
}

export function deriveCommandTimelineEntries(
  executions: ReadonlyArray<OrchestrationCommandExecutionSummary>,
): TimelineEntry[] {
  return [...executions].toSorted(compareCommandExecutions).map(commandTimelineEntry);
}

function commandTimelineEntry(
  commandExecution: OrchestrationCommandExecutionSummary,
): TimelineEntry {
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
