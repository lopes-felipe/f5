import { presentCodexMessageItem } from "@t3tools/shared/codexMessagePresentation";
import {
  normalizeCodexThreadItemType,
  itemTitle,
  itemDetail,
  itemLifecycleStatus,
} from "../codexItemPresentation.ts";
import { type AdmissionLease } from "../notificationAdmission.ts";
import { resolveComputerBackendSelection } from "../../computer/computerBackendPolicy";
import {
  formatCodexUsageError,
  detectCodexUsageLimit,
  isCodexAuthFailure,
  resolveCodexCompletionErrorInfo,
  type CodexLimitSnapshot,
  type CodexTerminalFailureEvidence,
} from "../codexErrors.ts";
import {
  codexCommandApprovalOptions,
  readCodexCommandApprovalOffer,
} from "../../codex/commandApprovalOffer.ts";
import { describeMcpElicitation } from "../../codex/mcpElicitation.ts";
import {
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  ElicitationDescriptor,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  SubagentActivityKind,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { validateProposedPlanOutput } from "@t3tools/shared/proposedPlan";
import { isCodexMcpLoginRequiredError } from "../mcpReconcile.ts";
import {
  isFatalCodexProcessStderrMessage,
  isIgnorableCodexProcessStderrMessage,
} from "@t3tools/shared/codexStderr";
import { codexNotificationDisposition } from "@t3tools/shared/codexProtocolManifest";
import { Effect, Schema } from "effect";

import {
  asArray,
  asObject,
  asString,
  CODEX_ELICITATION_OPENED_METHOD,
  CODEX_ELICITATION_SETTLED_METHOD,
} from "./CodexProtocolHelpers.ts";
import type { AgentCapabilityState } from "../Layers/claudeAgentBrowser.ts";
import { CODEX_CHROME_SERVER_NAME } from "../codexChromeIntegration.ts";
import { CodexChromeSession } from "../codexChromeSession.ts";

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function codexThreadTokenUsageSnapshot(payload: Record<string, unknown> | undefined): {
  readonly contextTokens?: number;
  readonly modelContextWindowTokens?: number;
} {
  const tokenUsage = asObject(payload?.tokenUsage);
  const lastUsage = asObject(tokenUsage?.last);
  const contextTokens = asNonNegativeInteger(lastUsage?.totalTokens);
  const modelContextWindowTokens = asNonNegativeInteger(tokenUsage?.modelContextWindow);

  return {
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {}),
  };
}

/**
 * Reasoning tokens spent since the previous usage frame. Codex can repeat a
 * frame (rate-limit refreshes), so the cumulative total is diffed against the
 * last seen total. Without a baseline, only `last` counts, so a resumed
 * thread's history is never attributed to one message.
 */
export function codexReasoningTokensSinceBaseline(
  payload: Record<string, unknown> | undefined,
  baseline: number | undefined,
): { readonly tokens: number; readonly baseline: number | undefined } | undefined {
  const tokenUsage = asObject(payload?.tokenUsage);
  const total = asNonNegativeInteger(asObject(tokenUsage?.total)?.reasoningOutputTokens);
  const last = asNonNegativeInteger(asObject(tokenUsage?.last)?.reasoningOutputTokens);
  if (total === undefined) {
    // Keep a missing baseline missing, so a later `total` is never diffed against 0.
    return last === undefined ? undefined : { tokens: last, baseline };
  }
  if (baseline === undefined || total < baseline) {
    return { tokens: last ?? 0, baseline: total };
  }
  return { tokens: total - baseline, baseline: total };
}

export function asMcpStartupStatus(
  value: unknown,
): "starting" | "ready" | "failed" | "cancelled" | "needs-auth" | undefined {
  switch (value) {
    case "starting":
    case "ready":
    case "failed":
    case "needs-auth":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

export function hookOutputEntriesText(value: unknown): string | undefined {
  const entries = asArray(value);
  if (!entries) {
    return undefined;
  }

  const parts = entries
    .map((entry) => asString(asObject(entry)?.text)?.trim())
    .filter((entry): entry is string => Boolean(entry && entry.length > 0));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function isPostToolUseHookEvent(value: unknown): boolean {
  const eventName = asString(value)?.trim();
  return eventName?.replace(/[^a-z0-9]/giu, "").toLowerCase() === "posttooluse";
}

export function hookCompletedOutcome(
  status: unknown,
  hookEvent: unknown,
): "success" | "error" | "cancelled" {
  switch (status) {
    case "completed":
      return "success";
    case "stopped":
      return isPostToolUseHookEvent(hookEvent) ? "success" : "cancelled";
    case "failed":
    case "blocked":
    case "running":
    default:
      return "error";
  }
}

export function hookCombinedOutput(run: Record<string, unknown> | undefined): string | undefined {
  if (!run) {
    return undefined;
  }

  const parts = [asString(run.statusMessage)?.trim(), hookOutputEntriesText(run.entries)].filter(
    (entry): entry is string => Boolean(entry && entry.length > 0),
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

export function permissionRequestType(permissions: Record<string, unknown>): CanonicalRequestType {
  const fileSystem = asObject(permissions.fileSystem);
  const entries = Array.isArray(fileSystem?.entries) ? fileSystem.entries : [];
  const requests = (access: "read" | "write") =>
    (Array.isArray(fileSystem?.[access]) && fileSystem[access].length > 0) ||
    entries.some((entry) => asObject(entry)?.access === access);
  if (requests("write")) return "file_change_approval";
  if (requests("read")) return "file_read_approval";
  return "permissions_approval";
}

export function toRequestTypeFromMethod(
  method: string,
  requestedPermissions?: unknown,
): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "mcpServer/elicitation/request":
      return "mcp_elicitation_approval";
    case "item/permissions/requestApproval":
      return permissionRequestType(asObject(requestedPermissions) ?? {});
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    case "mcp-elicitation":
      return "mcp_elicitation_approval";
    case "permission":
      return "permissions_approval";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method, payload?.requestedPermissions);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

export function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) => {
      if (typeof value === "string") {
        return [[questionId, value] as const];
      }

      if (Array.isArray(value)) {
        const normalized = value.filter((entry): entry is string => typeof entry === "string");
        return [[questionId, normalized.length === 1 ? normalized[0] : normalized] as const];
      }

      const answerObject = asObject(value);
      const answerList = asArray(answerObject?.answers)?.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (!answerList) {
        return [];
      }
      return [[questionId, answerList.length === 1 ? answerList[0] : answerList] as const];
    }),
  );
}

export function toUserInputQuestions(payload: Record<string, unknown> | undefined) {
  const questions = asArray(payload?.questions);
  if (!questions) {
    return undefined;
  }

  const parsedQuestions = questions
    .map((entry) => {
      const question = asObject(entry);
      if (!question) return undefined;
      const options = asArray(question.options)
        ?.map((option) => {
          const optionRecord = asObject(option);
          if (!optionRecord) return undefined;
          const label = asString(optionRecord.label)?.trim();
          const description = asString(optionRecord.description)?.trim();
          if (!label || !description) {
            return undefined;
          }
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== undefined);
      const id = asString(question.id)?.trim();
      const header = asString(question.header)?.trim();
      const prompt = asString(question.question)?.trim();
      if (!id || !header || !prompt || !options || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
      };
    })
    .filter(
      (
        question,
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
      } => question !== undefined,
    );

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

export function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  const status = asString(asObject(value)?.type) ?? asString(value);
  switch (status) {
    case "notLoaded":
    case "idle":
      return "idle";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

export function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

export const CONTENT_DELTA_METHODS: ReadonlySet<string> = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
]);

/** Text one queued notification may hold after waiting deltas merge into it. */
export const MAX_MERGED_DELTA_BYTES = 64 * 1024;

/** Ordered preparation, admission quotas and delta merging are scoped per context. */
export function notificationContextKey(event: ProviderEvent): string {
  return `${event.threadId}:${event.providerInstanceId ?? "legacy"}:${event.sessionGeneration ?? 0}`;
}

/**
 * Content deltas of one item that are still waiting for preparation can merge
 * into one queued notification. The identity covers everything the mapped
 * runtime event depends on, so merging only ever concatenates text.
 */
export function mergeableContentDelta(
  event: ProviderEvent,
): { readonly identity: string; readonly delta: string } | undefined {
  if (
    event.kind !== "notification" ||
    !CONTENT_DELTA_METHODS.has(event.method) ||
    event.turnId === undefined ||
    event.itemId === undefined
  )
    return undefined;
  const payload = asObject(event.payload);
  const delta = asString(payload?.delta);
  if (!delta) return undefined;
  if (event.textDelta !== undefined && event.textDelta !== delta) return undefined;
  return {
    identity: JSON.stringify([
      event.method,
      event.turnId,
      event.itemId,
      payload?.contentIndex ?? "",
      payload?.summaryIndex ?? "",
      event.textDelta !== undefined,
    ]),
    delta,
  };
}

/** A waiting delta notification that later deltas of the same item may join. */
export interface PendingDeltaSlot {
  readonly first: ProviderEvent;
  readonly parts: string[];
  textBytes: number;
  readonly lease: AdmissionLease;
  next?: Promise<void>;
  /** The last native delta merged in, recorded in the native log. */
  last?: { readonly id: string; readonly createdAt: string };
}

/** The first delta's identity and timestamp, carrying every merged part in order. */
export function mergeContentDeltas(
  first: ProviderEvent,
  parts: ReadonlyArray<string>,
): ProviderEvent {
  if (parts.length === 1) return first;
  const delta = parts.join("");
  return {
    ...first,
    payload: { ...asObject(first.payload), delta },
    ...(first.textDelta !== undefined ? { textDelta: delta } : {}),
  };
}

export function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

export function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

export function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

export function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

export function codexPatchApplyChangesMessage(
  message: Record<string, unknown> | undefined,
): ReadonlyArray<Record<string, unknown>> {
  const changes = asObject(message?.changes);
  if (!changes) {
    return [];
  }

  return Object.entries(changes).flatMap(([path, value]) => {
    const record = asObject(value);
    if (!record) {
      return [];
    }

    const type = asString(record.type);
    const movePath = asString(record.move_path) ?? asString(record.movePath);
    const diff = asString(record.unified_diff) ?? asString(record.unifiedDiff);
    const content = asString(record.content);
    const kind =
      type || movePath
        ? {
            ...(type ? { type } : {}),
            ...(movePath ? { move_path: movePath } : {}),
          }
        : undefined;

    return [
      {
        path,
        ...(kind ? { kind } : {}),
        ...(diff ? { diff } : content ? { diff: content } : {}),
      },
    ];
  });
}

export function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const turnId = asString(msg?.turn_id) ?? asString(msg?.turnId);
  const itemId = asString(msg?.item_id) ?? asString(msg?.itemId);
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: ProviderItemId.makeUnsafe(itemId) } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: ProviderItemId.makeUnsafe(itemId) } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId: TurnId.makeUnsafe(turnId) } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(ProviderItemId.makeUnsafe(itemId)) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

export function eventRawSource(
  event: ProviderEvent,
): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

export function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

export function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

export function runtimeEventBaseForTargetItem(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  targetItemId: string | undefined,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const base = runtimeEventBase(event, canonicalThreadId);
  if (!targetItemId) {
    return base;
  }
  const providerItemId = ProviderItemId.makeUnsafe(targetItemId);
  return {
    ...base,
    itemId: asRuntimeItemId(providerItemId),
    providerRefs: {
      ...base.providerRefs,
      providerItemId,
    },
  };
}

export function protocolWarningEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  message: string,
  protocolValue?: string,
): ProviderRuntimeEvent {
  return {
    type: "runtime.warning",
    ...runtimeEventBase(event, canonicalThreadId),
    payload: {
      message,
      category: "protocol",
      actionable: true,
      protocolMethod: event.method,
      ...(protocolValue ? { protocolValue } : {}),
      ...(event.payload !== undefined ? { detail: event.payload } : {}),
    },
  };
}

export const isSubagentActivityKind = Schema.is(SubagentActivityKind);

export function mapSubagentActivity(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  source: Record<string, unknown>,
): ProviderRuntimeEvent {
  const kind = source.kind;
  const agentThreadId = asString(source.agentThreadId ?? source.agent_thread_id)?.trim();
  const agentPath = asString(source.agentPath ?? source.agent_path)?.trim();
  if (!isSubagentActivityKind(kind)) {
    return protocolWarningEvent(
      event,
      canonicalThreadId,
      typeof kind === "string"
        ? `Unsupported Codex subagent activity kind ${JSON.stringify(kind)}.`
        : "Malformed Codex subagent activity: expected a string kind.",
      "subAgentActivity",
    );
  }
  if (!agentThreadId || !agentPath) {
    return protocolWarningEvent(
      event,
      canonicalThreadId,
      "Malformed Codex subagent activity: expected nonempty agentThreadId and agentPath.",
      "subAgentActivity",
    );
  }

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: "subagent.activity",
    payload: {
      kind,
      agentThreadId,
      agentPath,
      ...(asString(source.model)?.trim() ? { model: asString(source.model)!.trim() } : {}),
      ...(asString(source.reasoningEffort)?.trim()
        ? { reasoningEffort: asString(source.reasoningEffort)!.trim() }
        : {}),
    },
  };
}

export function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(presentCodexMessageItem(payload?.item));
  const source = item ?? payload;
  if (!source) {
    return protocolWarningEvent(
      event,
      canonicalThreadId,
      "Malformed Codex thread item: missing item payload.",
    );
  }

  const itemType = normalizeCodexThreadItemType(source.type ?? source.kind);
  if (itemType === "hook_prompt") {
    return undefined;
  }
  if (itemType === "subagent_activity") {
    return mapSubagentActivity(event, canonicalThreadId, source);
  }
  if (itemType === "unknown") {
    const rawType = asString(source.type ?? source.kind)?.trim() ?? "unknown";
    return protocolWarningEvent(
      event,
      canonicalThreadId,
      `Unsupported Codex thread item: ${rawType}`,
      rawType,
    );
  }

  const detail = itemDetail(itemType, source, payload ?? {});
  const status = itemLifecycleStatus(source, lifecycle);

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: item ? { ...payload, item } : event.payload } : {}),
    },
  };
}

export const CODEX_EXEC_ITEM_ID_REGEX =
  /^exec-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tool hook run ids end in the provider item id. Source paths can contain
 * colons on Windows, so only the final segment is considered and it must match
 * Codex's exec UUID shape.
 */
export function hookTargetItemId(hookId: string): string | undefined {
  const separator = hookId.lastIndexOf(":");
  const candidate = separator >= 0 ? hookId.slice(separator + 1) : "";
  return CODEX_EXEC_ITEM_ID_REGEX.test(candidate) ? candidate : undefined;
}

export function approvalReviewStatus(
  value: unknown,
): "inProgress" | "approved" | "denied" | "timedOut" | "aborted" {
  switch (value) {
    case "approved":
    case "denied":
    case "timedOut":
    case "aborted":
      return value;
    case "inProgress":
    default:
      return "inProgress";
  }
}

export function approvalReviewRiskLevel(
  value: unknown,
): "low" | "medium" | "high" | "critical" | undefined {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "critical":
      return value;
    default:
      return undefined;
  }
}

export function approvalReviewUserAuthorization(
  value: unknown,
): "unknown" | "low" | "medium" | "high" | undefined {
  switch (value) {
    case "unknown":
    case "low":
    case "medium":
    case "high":
      return value;
    default:
      return undefined;
  }
}

export function mapApprovalReview(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  type: "approval-review.started" | "approval-review.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const review = asObject(payload?.review);
  const action = asObject(payload?.action);
  const reviewId = asString(payload?.reviewId)?.trim();
  if (!reviewId) {
    return undefined;
  }
  const targetItemId = asString(payload?.targetItemId)?.trim();
  const startedAtMs = asNumber(payload?.startedAtMs);
  const completedAtMs = asNumber(payload?.completedAtMs);
  const durationMs =
    startedAtMs !== undefined && completedAtMs !== undefined
      ? Math.max(0, completedAtMs - startedAtMs)
      : undefined;
  const riskLevel = approvalReviewRiskLevel(review?.riskLevel);
  const userAuthorization = approvalReviewUserAuthorization(review?.userAuthorization);
  const rationale = asString(review?.rationale)?.trim();
  const decisionSource = asString(payload?.decisionSource)?.trim();
  const actionType = asString(action?.type)?.trim();

  return {
    ...runtimeEventBaseForTargetItem(event, canonicalThreadId, targetItemId),
    type,
    payload: {
      reviewId,
      ...(targetItemId
        ? { targetItemId: asRuntimeItemId(ProviderItemId.makeUnsafe(targetItemId)) }
        : {}),
      status: approvalReviewStatus(review?.status),
      ...(actionType ? { actionType } : {}),
      ...(riskLevel ? { riskLevel } : {}),
      ...(userAuthorization ? { userAuthorization } : {}),
      ...(rationale ? { rationale } : {}),
      ...(decisionSource ? { decisionSource } : {}),
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(completedAtMs !== undefined ? { completedAtMs } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(payload?.action !== undefined ? { action: payload.action } : {}),
    },
  };
}

export function hookRunMetadata(run: Record<string, unknown>) {
  const hookId = asString(run.id)?.trim();
  const hookEvent = asString(run.eventName)?.trim();
  if (!hookId || !hookEvent) {
    return undefined;
  }
  const targetItemId = hookTargetItemId(hookId);
  const handlerType = asString(run.handlerType)?.trim();
  const executionMode = asString(run.executionMode)?.trim();
  const scope = asString(run.scope)?.trim();
  const source = asString(run.source)?.trim();
  const sourcePath = asString(run.sourcePath)?.trim();
  const displayOrder = asNumber(run.displayOrder);
  const rawStatus = asString(run.status)?.trim();
  const statusMessage = asString(run.statusMessage)?.trim();
  const startedAt = asNumber(run.startedAt);
  const completedAt = asNumber(run.completedAt);
  const durationMs = asNumber(run.durationMs);
  const entries = asArray(run.entries);

  return {
    hookId,
    hookEvent,
    ...(targetItemId ? { targetItemId } : {}),
    ...(handlerType ? { handlerType } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(scope ? { scope } : {}),
    ...(source ? { source } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(displayOrder !== undefined ? { displayOrder } : {}),
    ...(rawStatus ? { rawStatus } : {}),
    ...(statusMessage ? { statusMessage } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(entries ? { entries } : {}),
  };
}

export function describePatchApproval(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const reason = asString(payload?.reason)?.trim();
  if (reason) return reason;
  const changes = asObject(payload?.fileChanges);
  const entries = Object.entries(changes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length) {
    const lines = entries.slice(0, 20).map(([path, value]) => {
      const change = asObject(value);
      const move = asString(change?.move_path);
      return `${asString(change?.type) ?? "change"} ${path}${move ? ` -> ${move}` : ""}`;
    });
    if (entries.length > 20) lines.push(`+${entries.length - 20} more`);
    return lines.join("\n");
  }
  return asString(payload?.grantRoot)?.trim() || undefined;
}

/** Record the F5 preview server installed for this session on `session.configured`. */
/**
 * F5 configures Codex's preview server itself, with a per-session credential, so its
 * provenance holds by construction: there is no SDK check to wait for.
 */
/**
 * Feeds Codex Chrome's supervision from the session's own events, in order: `node_repl`'s
 * startup (adoption) and turn completion (drain, then the idle stop).
 */
export function observeCodexChrome(
  session: Pick<CodexChromeSession, "startupStatus" | "turnEnded">,
  event: Pick<ProviderEvent, "method" | "payload" | "turnId">,
): void {
  const payload = asObject(event.payload);
  if (event.method === "mcpServer/startupStatus/updated") {
    // The manager reads either key; so does this.
    if ((asString(payload?.name) ?? asString(payload?.server)) !== CODEX_CHROME_SERVER_NAME) return;
    const status = asString(payload?.status);
    const error = asString(payload?.error);
    if (status) session.startupStatus(status, error);
    return;
  }
  if (event.method === "turn/completed" && event.turnId) session.turnEnded(event.turnId);
}

/**
 * Tracks the model's `node_repl` calls (running, not idle) as Codex reports them, ahead
 * of the session's ordered output preparation: an interrupt reads them while earlier
 * output (an MCP app capture) can still hold that queue. Calls without an id are ignored.
 */
export function trackCodexChromeCall(
  session: Pick<CodexChromeSession, "toolCall">,
  event: Pick<ProviderEvent, "method" | "payload">,
): void {
  if (event.method !== "item/started" && event.method !== "item/completed") return;
  const item = asObject(asObject(event.payload)?.item);
  const id = asString(item?.id);
  if (item?.type === "mcpToolCall" && item.server === CODEX_CHROME_SERVER_NAME && id)
    session.toolCall(id, event.method === "item/started");
}

export function withAgentBrowserPreview(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  previewServerName: string | undefined,
  computerServerName?: string,
  decision?: Effect.Success<ReturnType<typeof resolveComputerBackendSelection>>,
  chrome?: { readonly state: AgentCapabilityState; readonly detail?: string },
): ReadonlyArray<ProviderRuntimeEvent> {
  if (!previewServerName && !computerServerName && !decision && !chrome) return events;
  return events.map((runtimeEvent) =>
    runtimeEvent.type === "session.configured"
      ? {
          ...runtimeEvent,
          payload: {
            ...runtimeEvent.payload,
            config: {
              ...runtimeEvent.payload.config,
              agentBrowser: {
                ...(previewServerName
                  ? { preview: { serverName: previewServerName, installed: true, verified: true } }
                  : {}),
                ...(chrome
                  ? {
                      chrome: {
                        state: chrome.state,
                        ...(chrome.detail ? { detail: chrome.detail } : {}),
                      },
                    }
                  : {}),
                ...(computerServerName
                  ? {
                      computer: { serverName: computerServerName, installed: true, verified: true },
                      computerUse: {
                        state: decision && !decision.status.available ? "unavailable" : "connected",
                        backend: "native",
                        ...(decision && !decision.status.available
                          ? { detail: decision.status.detail ?? decision.status.reason }
                          : decision?.selection?.fallbackFrom
                            ? { detail: decision.selection.fallbackFrom.reason }
                            : {}),
                      },
                    }
                  : decision
                    ? {
                        computerUse: {
                          state:
                            !decision.status.available && decision.status.reason === "disabled"
                              ? "off"
                              : "unavailable",
                          backend: decision.selection?.kind ?? "native",
                          ...(!decision.status.available ? { detail: decision.status.reason } : {}),
                          ...(decision.selection?.fallbackFrom
                            ? { detail: decision.selection.fallbackFrom.reason }
                            : {}),
                        },
                      }
                    : {}),
              },
            },
          },
        }
      : runtimeEvent,
  );
}

export function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  limits?: CodexLimitSnapshot,
  snapshots?: ReadonlyArray<{ snapshot: CodexLimitSnapshot; observedAt: string }>,
  snapshotNotBefore?: string,
  previousFailure?: CodexTerminalFailureEvidence,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);

  if (event.kind === "request") {
    if (event.method === CODEX_ELICITATION_OPENED_METHOD) {
      const elicitation = Schema.decodeUnknownOption(ElicitationDescriptor)(payload?.elicitation);
      if (elicitation._tag === "None") return [];
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: { questions: [], elicitation: elicitation.value },
        },
      ];
    }
    if (event.method === "item/tool/requestUserInput") {
      const questions = toUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            // Only an explicit `isBlocking: false` relaxes blocking; older CLIs omit it.
            ...(payload?.isBlocking === false ? { blocking: false } : {}),
            questions,
          },
        },
      ];
    }

    const detail =
      event.method === "applyPatchApproval" || event.method === "item/fileChange/requestApproval"
        ? describePatchApproval(payload)
        : (asString(payload?.command) ??
          asString(payload?.reason) ??
          asString(payload?.message) ??
          asString(payload?.prompt));
    const requestedPermissionsValue = payload?.permissions;
    const requestedPermissions =
      event.method === "item/permissions/requestApproval" &&
      requestedPermissionsValue &&
      typeof requestedPermissionsValue === "object" &&
      !Array.isArray(requestedPermissionsValue)
        ? (requestedPermissionsValue as Record<string, unknown>)
        : undefined;
    const commandApprovalOptions =
      event.method === "item/commandExecution/requestApproval"
        ? codexCommandApprovalOptions(readCodexCommandApprovalOffer(payload))
        : undefined;
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method, requestedPermissions),
          ...(event.method === "mcpServer/elicitation/request"
            ? describeMcpElicitation(payload)
            : {}),
          ...(commandApprovalOptions ? { approvalOptions: commandApprovalOptions } : {}),
          ...(detail ? { detail } : {}),
          ...(requestedPermissions ? { requestedPermissions } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
    const requestMethod = asString(payload?.requestMethod);
    const requestType = requestMethod
      ? toRequestTypeFromMethod(requestMethod, payload?.requestedPermissions)
      : event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/configured") {
    const config = asObject(asObject(event.payload)?.config);
    if (!config) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.configured",
        payload: {
          config,
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/deleted" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed" || event.method === "thread/deleted"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(
                      asObject(payload?.thread)?.state ?? payload?.state ?? payload?.status,
                    ),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "f5/aside/completed") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: { metadata: { nativeAside: payload } },
      },
    ];
  }
  if (
    ["thread/attachment/updated", "thread/goal/updated", "thread/goal/cleared"].includes(
      event.method ?? "",
    )
  ) {
    const metadata =
      event.method === "thread/attachment/updated"
        ? {
            nativeAttachment: {
              attachmentId: payload?.attachmentId,
              attachmentType: payload?.attachmentType,
              identityKey: payload?.identityKey,
              operation: payload?.operation,
              source: "codex",
            },
          }
        : { nativeGoal: event.method === "thread/goal/cleared" ? null : payload?.goal };
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        raw: {
          source: "codex.app-server.notification",
          method: event.method ?? "native/metadata",
          payload: metadata,
        },
        payload: { metadata },
      },
    ];
  }
  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const snapshot = codexThreadTokenUsageSnapshot(payload);
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: event.payload ?? {},
          ...snapshot,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const tier = asString(turn && "serviceTier" in turn ? turn.serviceTier : payload?.serviceTier);
    const usageSpeed =
      tier === "fast" || tier === "priority"
        ? ("fast" as const)
        : tier === "ultrafast"
          ? ("ultrafast" as const)
          : tier === "standard" || tier === "default"
            ? ("standard" as const)
            : undefined;
    const rawErrorMessage = asString(asObject(turn?.error)?.message);
    const errorInfo = resolveCodexCompletionErrorInfo({
      message: rawErrorMessage,
      errorInfo: asObject(turn?.error)?.codexErrorInfo,
      previous: previousFailure,
    });
    const usageLimit =
      toTurnStatus(turn?.status) === "failed"
        ? detectCodexUsageLimit({
            message: rawErrorMessage ?? previousFailure?.message ?? "",
            errorInfo,
            snapshots: snapshots ?? (limits ? [limits] : []),
            ...(snapshotNotBefore ? { snapshotNotBefore } : {}),
            at: event.createdAt,
            deferMessageReset: true,
          })
        : null;
    const errorMessage = rawErrorMessage
      ? formatCodexUsageError(rawErrorMessage, limits, event.createdAt, errorInfo)
      : undefined;
    // A failure the `error` notification already reported keeps its class; only an
    // unannounced expired login needs its own typed error so the thread can offer sign-in.
    const unannouncedAuthFailure =
      toTurnStatus(turn?.status) === "failed" &&
      !previousFailure &&
      !usageLimit &&
      isCodexAuthFailure({ message: rawErrorMessage, errorInfo });
    return [
      ...(unannouncedAuthFailure
        ? [
            {
              ...runtimeEventBase(event, canonicalThreadId),
              eventId: EventId.makeUnsafe(`auth-failure:${event.id}`),
              type: "runtime.error" as const,
              payload: {
                message: errorMessage ?? "Codex login expired. Sign in again, then retry.",
                class: "auth_error" as const,
              },
            },
          ]
        : []),
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(usageSpeed ? { usageSpeed } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
          ...(usageLimit ? { usageLimit } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(asString(payload?.explanation)
            ? { explanation: asString(payload?.explanation) }
            : {}),
          plan: steps
            .map((entry) => asObject(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== undefined)
            .map((entry) => ({
              step: asString(entry.step) ?? "step",
              status:
                entry.status === "completed" || entry.status === "inProgress"
                  ? entry.status
                  : "pending",
            })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff:
            asString(payload?.unifiedDiff) ??
            asString(payload?.diff) ??
            asString(payload?.patch) ??
            "",
        },
      },
    ];
  }

  if (event.method === "item/autoApprovalReview/started") {
    const review = mapApprovalReview(event, canonicalThreadId, "approval-review.started");
    return review ? [review] : [];
  }

  if (event.method === "item/autoApprovalReview/completed") {
    const review = mapApprovalReview(event, canonicalThreadId, "approval-review.completed");
    return review ? [review] : [];
  }

  if (event.method === "item/fileChange/patchUpdated") {
    const itemId = asString(payload?.itemId)?.trim() ?? event.itemId;
    if (!itemId) {
      return [];
    }
    return [
      {
        ...runtimeEventBaseForTargetItem(event, canonicalThreadId, itemId),
        type: "item.updated",
        payload: {
          itemType: "file_change",
          title: "File change",
          data: {
            item: {
              type: "fileChange",
              id: itemId,
              changes: asArray(payload?.changes) ?? [],
            },
          },
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const asyncItem = asObject(asObject(event.payload)?.item);
    if (
      asyncItem?.type === "agentMessage" &&
      asyncItem.delivery === "async" &&
      Array.isArray(asyncItem.questions) &&
      asyncItem.questions.length
    ) {
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          eventId: EventId.makeUnsafe(`codex-async:${canonicalThreadId}:${String(asyncItem.id)}`),
          type: "user-input.requested",
          requestId: RuntimeRequestId.makeUnsafe(
            `codex-async:${canonicalThreadId}:${String(asyncItem.id)}`,
          ),
          payload: {
            // Message transport keeps the composer free; automatic resume still waits.
            responseMode: "message",
            questions: asyncItem.questions.map((value, index) => {
              const question = asObject(value);
              return {
                id: String(index),
                header: "Question",
                question: asString(question?.title) ?? "Question",
                options: (Array.isArray(question?.options) ? question.options : [])
                  .filter((label): label is string => typeof label === "string")
                  .map((label) => ({ label, description: label })),
                multiSelect: false,
              };
            }),
          },
        },
      ];
    }
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (!source) {
      return [];
    }
    const itemType = source ? normalizeCodexThreadItemType(source.type ?? source.kind) : "unknown";
    if (itemType === "plan") {
      const detail = itemDetail(itemType, source, payload ?? {});
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    const updated = mapItemLifecycle(event, canonicalThreadId, "item.updated");
    return updated ? [updated] : [];
  }

  if (event.method === "item/plan/delta") {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (CONTENT_DELTA_METHODS.has(event.method)) {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(typeof payload?.summaryIndex === "number"
            ? { summaryIndex: payload.summaryIndex }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const requestType =
      toRequestTypeFromResolvedPayload(payload) !== "unknown"
        ? toRequestTypeFromResolvedPayload(payload)
        : event.requestId && event.requestKind !== undefined
          ? toRequestTypeFromKind(event.requestKind)
          : "unknown";
    if (requestType === "tool_user_input") {
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.resolved",
          payload: {
            answers: {},
          },
        },
      ];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === CODEX_ELICITATION_SETTLED_METHOD) {
    const receipt = payload?.receipt;
    if (receipt !== "resolved" && receipt !== "cancelled" && receipt !== "indeterminate") return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: { answers: {}, receipt },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(
            asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/patch_apply_end") {
    const msg = codexEventMessage(payload);
    const itemId = asString(msg?.call_id) ?? asString(msg?.callId);
    if (!itemId) {
      return [];
    }
    const providerItemId = ProviderItemId.makeUnsafe(itemId);
    const base = codexEventBase(event, canonicalThreadId);

    return [
      {
        ...base,
        itemId: asRuntimeItemId(providerItemId),
        providerRefs: {
          ...base.providerRefs,
          providerItemId,
        },
        type: "item.updated",
        payload: {
          itemType: "file_change",
          title: "File change",
          data: {
            item: {
              type: "fileChange",
              id: itemId,
              changes: codexPatchApplyChangesMessage(msg),
              ...(asString(msg?.status) ? { status: asString(msg?.status) } : {}),
            },
          },
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    const planValidation = validateProposedPlanOutput(asString(msg?.last_agent_message));
    const proposedPlanMarkdown = planValidation.valid ? planValidation.markdown : undefined;
    if (!taskId) {
      if (!proposedPlanMarkdown) {
        return [];
      }
      return [
        {
          ...codexEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        },
      ];
    }
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          status: "completed",
          ...(asString(msg?.last_agent_message)
            ? { summary: asString(msg?.last_agent_message) }
            : {}),
        },
      },
    ];
    if (proposedPlanMarkdown) {
      events.push({
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: proposedPlanMarkdown,
        },
      });
    }
    return events;
  }

  if (event.method === "codex/event/agent_reasoning") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id);
    const description = asString(msg?.text);
    if (!taskId || !description) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          description,
        },
      },
    ];
  }

  if (event.method === "codex/event/reasoning_content_delta") {
    const msg = codexEventMessage(payload);
    const delta = asString(msg?.delta);
    if (!delta) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            asNumber(msg?.summary_index) !== undefined
              ? "reasoning_summary_text"
              : "reasoning_text",
          delta,
          ...(asNumber(msg?.summary_index) !== undefined
            ? { summaryIndex: asNumber(msg?.summary_index) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "warning" || event.method === "guardianWarning") {
    const guardian = event.method === "guardianWarning";
    const message =
      asString(payload?.message)?.trim() ??
      event.message?.trim() ??
      (guardian ? "Codex guardian warning" : "Codex warning");
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          category: guardian ? "guardian" : "provider",
          actionable: guardian,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "model/verification") {
    const verifications = asArray(payload?.verifications)?.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    const description =
      verifications && verifications.length > 0 ? verifications.join(", ") : "additional access";
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: `Model verification required: ${description}`,
          category: "verification",
          actionable: true,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Deprecation notice",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Configuration warning",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
          ...(asString(payload?.path) ? { path: asString(payload?.path) } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/login/completed") {
    const success = payload?.success === true;
    const error = asString(payload?.error)?.trim();
    return [
      {
        type: "auth.status",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          isAuthenticating: false,
          output: [success ? "Account login completed" : "Account login failed"],
          ...(!success && error ? { error } : {}),
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "hook/started") {
    const run = asObject(payload?.run);
    const metadata = run ? hookRunMetadata(run) : undefined;
    if (!metadata) {
      return [];
    }

    return [
      {
        type: "hook.started",
        ...runtimeEventBaseForTargetItem(event, canonicalThreadId, metadata.targetItemId),
        payload: {
          hookId: metadata.hookId,
          hookName: metadata.hookEvent,
          hookEvent: metadata.hookEvent,
          ...(metadata.targetItemId
            ? {
                targetItemId: asRuntimeItemId(ProviderItemId.makeUnsafe(metadata.targetItemId)),
              }
            : {}),
          ...(metadata.handlerType ? { handlerType: metadata.handlerType } : {}),
          ...(metadata.executionMode ? { executionMode: metadata.executionMode } : {}),
          ...(metadata.scope ? { scope: metadata.scope } : {}),
          ...(metadata.source ? { source: metadata.source } : {}),
          ...(metadata.sourcePath ? { sourcePath: metadata.sourcePath } : {}),
          ...(metadata.displayOrder !== undefined ? { displayOrder: metadata.displayOrder } : {}),
          ...(metadata.statusMessage ? { statusMessage: metadata.statusMessage } : {}),
          ...(metadata.startedAt !== undefined ? { startedAt: metadata.startedAt } : {}),
        },
      },
    ];
  }

  if (event.method === "hook/completed") {
    const run = asObject(payload?.run);
    const metadata = run ? hookRunMetadata(run) : undefined;
    if (!run || !metadata) {
      return [];
    }
    const output = hookCombinedOutput(run);

    return [
      {
        type: "hook.completed",
        ...runtimeEventBaseForTargetItem(event, canonicalThreadId, metadata.targetItemId),
        payload: {
          hookId: metadata.hookId,
          hookName: metadata.hookEvent,
          hookEvent: metadata.hookEvent,
          outcome: hookCompletedOutcome(run.status, metadata.hookEvent),
          ...(metadata.targetItemId
            ? {
                targetItemId: asRuntimeItemId(ProviderItemId.makeUnsafe(metadata.targetItemId)),
              }
            : {}),
          ...(metadata.handlerType ? { handlerType: metadata.handlerType } : {}),
          ...(metadata.executionMode ? { executionMode: metadata.executionMode } : {}),
          ...(metadata.scope ? { scope: metadata.scope } : {}),
          ...(metadata.source ? { source: metadata.source } : {}),
          ...(metadata.sourcePath ? { sourcePath: metadata.sourcePath } : {}),
          ...(metadata.displayOrder !== undefined ? { displayOrder: metadata.displayOrder } : {}),
          ...(metadata.rawStatus ? { rawStatus: metadata.rawStatus } : {}),
          ...(metadata.statusMessage ? { statusMessage: metadata.statusMessage } : {}),
          ...(metadata.startedAt !== undefined ? { startedAt: metadata.startedAt } : {}),
          ...(metadata.completedAt !== undefined ? { completedAt: metadata.completedAt } : {}),
          ...(metadata.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
          ...(metadata.entries ? { entries: metadata.entries } : {}),
          ...(output ? { output } : {}),
        },
      },
    ];
  }

  if (event.method === "mcpServer/startupStatus/updated") {
    const name = asString(payload?.name);
    const startupStatus = asMcpStartupStatus(payload?.status);
    if (!name || !startupStatus) {
      return [];
    }
    // Codex reports a missing or expired OAuth token as a failed startup.
    const status =
      startupStatus === "failed" && isCodexMcpLoginRequiredError(asString(payload?.error))
        ? "needs-auth"
        : startupStatus;

    return [
      {
        type: "mcp.status.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          status: {
            name,
            status,
            ...(typeof payload?.sessionGeneration === "number"
              ? { sessionGeneration: payload.sessionGeneration }
              : {}),
            ...(asString(payload?.providerInstanceId)
              ? {
                  providerInstanceId: ProviderInstanceId.makeUnsafe(
                    asString(payload?.providerInstanceId)!,
                  ),
                }
              : {}),
            ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
          },
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const realtimeSessionId = asString(payload?.realtimeSessionId);
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = asString(payload?.message) ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: event.message,
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    if (isIgnorableCodexProcessStderrMessage(message)) {
      return [];
    }
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              class: "provider_error" as const,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "protocol/unsupportedServerRequest") {
    const requestMethod = asString(payload?.requestMethod)?.trim();
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Unsupported Codex server request",
          category: "protocol",
          actionable: true,
          protocolMethod: requestMethod ?? event.method,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (
    event.method === "protocol/parseError" ||
    event.method === "protocol/invalidMessage" ||
    event.method === "protocol/unrecognizedMessage"
  ) {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Malformed Codex protocol record",
          category: "protocol",
          actionable: false,
          protocolMethod: event.method,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "error") {
    const message =
      asString(asObject(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    const usageLimit = willRetry
      ? null
      : detectCodexUsageLimit({
          message,
          errorInfo: asObject(payload?.error)?.codexErrorInfo,
          snapshots: snapshots ?? (limits ? [limits] : []),
          ...(snapshotNotBefore ? { snapshotNotBefore } : {}),
          at: event.createdAt,
          deferMessageReset: true,
        });
    const authFailure =
      !willRetry &&
      !usageLimit &&
      isCodexAuthFailure({ message, errorInfo: asObject(payload?.error)?.codexErrorInfo });
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: willRetry
            ? message
            : formatCodexUsageError(
                message,
                limits,
                event.createdAt,
                asObject(payload?.error)?.codexErrorInfo,
              ),
          ...(!willRetry
            ? { class: authFailure ? ("auth_error" as const) : ("provider_error" as const) }
            : {}),
          ...(usageLimit ? { usageLimit } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asObject(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  if (event.kind === "notification") {
    const disposition = codexNotificationDisposition(event.method);
    if (disposition !== undefined) {
      return [];
    }
    if (!event.method.startsWith("codex/event/")) {
      return [
        protocolWarningEvent(
          event,
          canonicalThreadId,
          `Unsupported Codex notification: ${event.method}`,
        ),
      ];
    }
  }

  return [];
}
