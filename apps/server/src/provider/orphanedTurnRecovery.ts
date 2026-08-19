import {
  EventId,
  type ProviderInstanceId,
  type ProviderKind,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";

import type { ProviderTerminalRuntimeEvent } from "../persistence/Services/ProviderTerminalEvents.ts";

export const PROVIDER_SHUTDOWN_RUNTIME_EVENTS = new Set([
  "provider.stopAll",
  "provider.stopSession",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readPersistedActiveTurnId(runtimePayload: unknown): TurnId | undefined {
  const activeTurnId = asTrimmedString(asRecord(runtimePayload)?.activeTurnId);
  return activeTurnId === undefined ? undefined : TurnId.makeUnsafe(activeTurnId);
}

export function readPersistedLastRuntimeEvent(runtimePayload: unknown): string | undefined {
  return asTrimmedString(asRecord(runtimePayload)?.lastRuntimeEvent);
}

export function readPersistedLastRuntimeEventAt(runtimePayload: unknown): string | undefined {
  return asTrimmedString(asRecord(runtimePayload)?.lastRuntimeEventAt);
}

export function orphanedSessionExitEventId(threadId: ThreadId, turnId: TurnId): EventId {
  return EventId.makeUnsafe(`provider:orphaned-session-exit:${threadId}:${turnId}`);
}

export function makeOrphanedSessionExitedEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly provider: ProviderKind;
  readonly providerInstanceId?: ProviderInstanceId | null | undefined;
  readonly createdAt: string;
}): ProviderTerminalRuntimeEvent {
  return {
    type: "session.exited",
    eventId: orphanedSessionExitEventId(input.threadId, input.turnId),
    provider: input.provider,
    ...(input.providerInstanceId !== undefined && input.providerInstanceId !== null
      ? { providerInstanceId: input.providerInstanceId }
      : {}),
    threadId: input.threadId,
    turnId: input.turnId,
    createdAt: input.createdAt,
    payload: {
      exitKind: "graceful",
      reason: "The provider session ended before the active turn emitted a terminal event.",
    },
  };
}
