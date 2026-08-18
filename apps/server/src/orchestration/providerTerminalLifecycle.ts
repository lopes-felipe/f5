import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  TurnId,
  type UsageTurnFact,
} from "@t3tools/contracts";

import { normalizeTurnUsage } from "../usage/usageMetrics.ts";

export type TurnCompletedRuntimeEvent = Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;

export const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}`);

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
  // Claude `result.usage` aggregates the entire agentic turn. Occupancy
  // snapshots for the badge come from per-message usage stream events instead.
  if (event.provider === "claudeAgent") {
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
      input.event.providerInstanceId ??
      input.thread.session?.providerInstanceId ??
      input.thread.modelSelection?.instanceId ??
      null,
    model: input.thread.model || null,
    ...normalizeTurnUsage(input.event),
    completedAt: input.event.createdAt,
    sourceEventId: input.event.eventId,
  };
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
    session: {
      threadId: thread.id,
      status,
      providerName: event.provider,
      runtimeMode: thread.session?.runtimeMode ?? "full-access",
      activeTurnId: null,
      lastError,
      lastErrorId: failed ? event.eventId : null,
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
