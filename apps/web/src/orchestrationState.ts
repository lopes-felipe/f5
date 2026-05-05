import {
  DEFAULT_MODEL_BY_PROVIDER,
  type OrchestrationCheckpointStatus,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type ProviderKind,
} from "@t3tools/contracts";
import { inferProviderForModel, resolveModelSlugForProvider } from "@t3tools/shared/model";

import { sanitizeThreadErrorMessage } from "./transportError";
import type { ChatMessage, Thread } from "./types";

export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_CHECKPOINTS = 500;
export const MAX_THREAD_ACTIVITIES = 500;
export const MAX_THREAD_PROPOSED_PLANS = 200;

export function arraysShallowEqual<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function areUnknownEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => areUnknownEqual(entry, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) =>
    areUnknownEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
    ),
  );
}

export function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

export function toLegacyProvider(providerName: string | null): ProviderKind {
  if (
    providerName === "codex" ||
    providerName === "claudeAgent" ||
    providerName === "cursor" ||
    providerName === "opencode"
  ) {
    return providerName;
  }
  return "codex";
}

export function inferProviderForThreadModel(input: {
  readonly model: string;
  readonly sessionProviderName: string | null;
}): ProviderKind {
  if (
    input.sessionProviderName === "codex" ||
    input.sessionProviderName === "claudeAgent" ||
    input.sessionProviderName === "cursor" ||
    input.sessionProviderName === "opencode"
  ) {
    return input.sessionProviderName;
  }
  return inferProviderForModel(input.model);
}

export function resolveThreadModel(input: {
  readonly model: string;
  readonly sessionProviderName: string | null;
}): string {
  return resolveModelSlugForProvider(
    inferProviderForThreadModel(input),
    input.model ?? DEFAULT_MODEL_BY_PROVIDER.codex,
  );
}

export function mapSessionFromReadModel(
  incoming: OrchestrationSession | null | undefined,
  previous: Thread["session"] | null | undefined,
): Thread["session"] | null {
  if (!incoming) {
    return null;
  }

  const lastError = sanitizeThreadErrorMessage(incoming.lastError);
  const next: Thread["session"] = {
    provider: toLegacyProvider(incoming.providerName),
    providerInstanceId: incoming.providerInstanceId ?? null,
    status: toLegacySessionStatus(incoming.status),
    orchestrationStatus: incoming.status,
    activeTurnId: incoming.activeTurnId ?? undefined,
    createdAt: incoming.updatedAt,
    updatedAt: incoming.updatedAt,
    ...(lastError ? { lastError } : {}),
    ...(incoming.tokenUsageSource
      ? { tokenUsageSource: incoming.tokenUsageSource }
      : previous?.tokenUsageSource
        ? { tokenUsageSource: previous.tokenUsageSource }
        : {}),
  };

  if (
    previous &&
    previous.provider === next.provider &&
    previous.providerInstanceId === next.providerInstanceId &&
    previous.status === next.status &&
    previous.orchestrationStatus === next.orchestrationStatus &&
    previous.activeTurnId === next.activeTurnId &&
    previous.createdAt === next.createdAt &&
    previous.updatedAt === next.updatedAt &&
    previous.lastError === next.lastError &&
    previous.tokenUsageSource === next.tokenUsageSource
  ) {
    return previous;
  }

  return next;
}

export function mapMessageAttachmentsFromReadModel(
  incoming:
    | OrchestrationReadModel["threads"][number]["messages"][number]["attachments"]
    | undefined,
  previous: ChatMessage["attachments"] | undefined,
): ChatMessage["attachments"] | undefined {
  if (!incoming || incoming.length === 0) {
    return undefined;
  }

  const previousAttachments = previous ?? [];
  let changed = previousAttachments.length !== incoming.length;
  const next = incoming.map((attachment, index) => {
    const previewUrl = toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id));
    const existing = previousAttachments[index];
    if (
      existing &&
      existing.type === "image" &&
      existing.id === attachment.id &&
      existing.name === attachment.name &&
      existing.mimeType === attachment.mimeType &&
      existing.sizeBytes === attachment.sizeBytes &&
      existing.previewUrl === previewUrl
    ) {
      return existing;
    }
    changed = true;
    return {
      type: "image" as const,
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      previewUrl,
    };
  });

  return !changed && previous ? previous : next;
}

export function checkpointStatusToLatestTurnState(status: OrchestrationCheckpointStatus) {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

export function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<Thread["messages"][number]>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<Thread["messages"][number]> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId == null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId == null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

export function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<Thread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

export function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<Thread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

export function compareThreadActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
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

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}
