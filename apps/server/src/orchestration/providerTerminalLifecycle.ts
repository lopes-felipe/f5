import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationUsageLimit,
  type RuntimeUsageLimit,
  type ProviderRuntimeEvent,
  TurnId,
  type UsageTurnFact,
} from "@t3tools/contracts";

import { normalizeTurnUsage } from "../usage/usageMetrics.ts";

export type TurnCompletedRuntimeEvent = Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;

export const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}`);

export const INCOMPLETE_HISTORY_SESSION_ERROR =
  "Provider output is incomplete. Review history recovery before continuing.";

type SessionErrorFields = Pick<
  OrchestrationSession,
  "lastError" | "lastErrorId" | "lastErrorOccurredAt"
>;

/**
 * The session update that removes the incomplete-history warning once `markerId` is no longer
 * fenced (verified recovery or the user accepting the history), or undefined when nothing
 * should change: the session shows another error, or a turn already started, whose own
 * lifecycle updates own the session from here.
 */
export function makeHistoryRecoveredSessionSet(input: {
  readonly thread: Pick<OrchestrationThread, "id" | "session"> | undefined;
  readonly markerId: string;
  readonly commandId: CommandId;
  readonly createdAt: string;
}): Extract<OrchestrationCommand, { type: "thread.session.set" }> | undefined {
  const session = input.thread?.session;
  if (
    !input.thread ||
    !session ||
    session.lastErrorId !== input.markerId ||
    session.activeTurnId != null ||
    session.status === "running" ||
    session.status === "starting"
  )
    return undefined;
  return {
    type: "thread.session.set",
    commandId: input.commandId,
    threadId: input.thread.id,
    session: {
      ...session,
      status: session.status === "error" ? "ready" : session.status,
      lastError: null,
      lastErrorId: null,
      lastErrorOccurredAt: null,
      lastErrorRetryability: null,
      updatedAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

/**
 * Sends stay fenced while an incomplete-history marker exists, so a session
 * update that would otherwise clear the error keeps one naming the marker. The
 * marker's own runtime error text is kept when it is still the projected one.
 * Only a verified or manual history recovery clears it.
 */
export function retainIncompleteHistoryError<S extends SessionErrorFields>(
  session: S,
  previous: SessionErrorFields | null | undefined,
  marker: { readonly eventId: string } | undefined,
  now: string,
): S {
  if (!marker || session.lastError !== null) return session;
  const same = previous && previous.lastErrorId === marker.eventId ? previous : undefined;
  return {
    ...session,
    lastError: same?.lastError ?? INCOMPLETE_HISTORY_SESSION_ERROR,
    lastErrorId: marker.eventId,
    lastErrorOccurredAt: same?.lastErrorOccurredAt ?? now,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function extractContextTokens(usage: unknown): number | undefined {
  const usageRecord = asRecord(usage);
  const inputTokens = asNonNegativeNumber(usageRecord?.input_tokens);
  if (inputTokens === undefined) {
    return undefined;
  }

  return (
    inputTokens +
    (asNonNegativeNumber(usageRecord?.cache_creation_input_tokens) ?? 0) +
    (asNonNegativeNumber(usageRecord?.cache_read_input_tokens) ?? 0)
  );
}

export function extractTurnCompletedContextTokens(
  event: TurnCompletedRuntimeEvent,
): number | undefined {
  // Claude and Pi aggregate billable usage across all messages in an agentic
  // turn. Occupancy comes from their separate authoritative context snapshots.
  if (event.provider === "claudeAgent" || event.provider === "pi") {
    return undefined;
  }

  return extractContextTokens(event.payload?.usage);
}

export function mergeProviderReportedContextTokens(input: {
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly eventType: "turn.completed" | "thread.token-usage.updated";
  readonly providerReportedContextTokens: number | undefined;
  readonly previousEstimatedContextTokens: number | null;
  readonly authoritativeSnapshot?: boolean | undefined;
}): number | undefined {
  if (input.providerReportedContextTokens === undefined) {
    return undefined;
  }

  if (
    input.authoritativeSnapshot ||
    (input.provider === "claudeAgent" && input.eventType === "thread.token-usage.updated")
  ) {
    return input.providerReportedContextTokens;
  }

  return Math.max(input.providerReportedContextTokens, input.previousEstimatedContextTokens ?? 0);
}

export function runtimeTurnState(
  event: ProviderRuntimeEvent,
): "completed" | "failed" | "interrupted" | "cancelled" {
  const payloadState = asString(asRecord(event.payload)?.state);
  switch (payloadState) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return payloadState;
    default:
      return "completed";
  }
}

export function runtimeTurnErrorMessage(event: ProviderRuntimeEvent): string | undefined {
  return asString(asRecord(event.payload)?.errorMessage);
}

export function makeCompletedTurnUsageFact(input: {
  readonly event: TurnCompletedRuntimeEvent;
  readonly thread: OrchestrationThread;
}): UsageTurnFact | undefined {
  if (input.event.turnId === undefined) {
    return undefined;
  }
  return {
    turnId: TurnId.makeUnsafe(String(input.event.turnId)),
    threadId: input.thread.id,
    projectId: input.thread.projectId,
    provider: input.event.provider,
    providerInstanceId:
      input.event.providerInstanceId ?? input.thread.session?.providerInstanceId ?? null,
    model: input.thread.model || null,
    ...normalizeTurnUsage(input.event),
    completedAt: input.event.createdAt,
    sourceEventId: input.event.eventId,
  };
}

/** Correlate terminal reports by provider instance and turn, rather than event id. */
export function toOrchestrationUsageLimit(
  limit: RuntimeUsageLimit | undefined,
  event: ProviderRuntimeEvent,
  thread: OrchestrationThread,
): OrchestrationUsageLimit | null {
  if (!limit) return null;
  const providerInstanceId = event.providerInstanceId ?? thread.session?.providerInstanceId ?? null;
  const turnId = event.turnId
    ? TurnId.makeUnsafe(String(event.turnId))
    : (thread.session?.activeTurnId ?? null);
  if (!providerInstanceId || !turnId) return null;
  return { ...limit, providerInstanceId, turnId, deliveryId: null };
}

export function makeTurnCompletedSessionSetCommand(input: {
  readonly event: TurnCompletedRuntimeEvent;
  readonly thread: OrchestrationThread;
  readonly createdAt?: string;
}): Extract<OrchestrationCommand, { type: "thread.session.set" }> {
  const { event, thread } = input;
  const createdAt = input.createdAt ?? event.createdAt;
  const failed = runtimeTurnState(event) === "failed";
  const status = failed ? "error" : "ready";
  const lastError = failed
    ? (runtimeTurnErrorMessage(event) ?? thread.session?.lastError ?? "Turn failed")
    : null;
  const providerReportedContextTokens = extractTurnCompletedContextTokens(event);
  const estimatedContextTokens = mergeProviderReportedContextTokens({
    provider: event.provider,
    eventType: "turn.completed",
    providerReportedContextTokens,
    previousEstimatedContextTokens: thread.estimatedContextTokens ?? null,
  });
  const tokenUsageSource =
    estimatedContextTokens === undefined
      ? undefined
      : estimatedContextTokens === providerReportedContextTokens
        ? ("provider" as const)
        : ("estimated" as const);

  return {
    type: "thread.session.set",
    commandId: providerCommandId(event, "thread-session-set"),
    threadId: thread.id,
    ...(event.turnId !== undefined
      ? { settledTurnId: TurnId.makeUnsafe(String(event.turnId)) }
      : {}),
    session: {
      threadId: thread.id,
      status,
      providerName: event.provider,
      providerInstanceId: event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
      runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
      activeTurnId: null,
      lastError,
      lastErrorId: failed ? event.eventId : null,
      usageLimit: failed
        ? toOrchestrationUsageLimit(event.payload?.usageLimit, event, thread)
        : null,
      lastErrorOccurredAt: failed ? createdAt : null,
      ...(event.payload?.totalCostUsd !== undefined
        ? { turnCostUsd: event.payload.totalCostUsd }
        : {}),
      ...(estimatedContextTokens !== undefined ? { estimatedContextTokens, tokenUsageSource } : {}),
      estimatedThinkingTokens: 0,
      updatedAt: createdAt,
    },
    createdAt,
  };
}
