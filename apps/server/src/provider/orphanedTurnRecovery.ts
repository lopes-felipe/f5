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

const ORPHANED_SESSION_EXIT_PREFIX = "provider:orphaned-session-exit:";

export function orphanedSessionExitEventId(threadId: ThreadId, turnId: TurnId): EventId {
  return EventId.makeUnsafe(`${ORPHANED_SESSION_EXIT_PREFIX}${threadId}:${turnId}`);
}

/**
 * F5's own settlement for a turn whose provider is gone. It carries no
 * provider output, so it is owned by its turn rather than by a session
 * generation: it may only settle that exact turn.
 */
export function isOrphanedSessionExitEvent(event: {
  readonly type: string;
  readonly eventId: string;
}): boolean {
  return event.type === "session.exited" && event.eventId.startsWith(ORPHANED_SESSION_EXIT_PREFIX);
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
