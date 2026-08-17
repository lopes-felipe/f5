import {
  MAX_BACKGROUND_WORK_OUTPUT_BYTES,
  type BackgroundWorkClassification,
  type BackgroundWorkOwnership,
  type BackgroundWorkStatus,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Stream } from "effect";

import { ThreadBackgroundWorkRepositoryLive } from "../../persistence/Layers/ThreadBackgroundWork.ts";
import {
  ThreadBackgroundWorkRepository,
  type ThreadBackgroundWorkTransition,
} from "../../persistence/Services/ThreadBackgroundWork.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { truncateMiddleByBytes } from "../outputTruncation.ts";
import {
  ThreadBackgroundWork,
  type ThreadBackgroundWorkShape,
} from "../Services/ThreadBackgroundWork.ts";

const MONITOR_TASK_TYPES = new Set(["monitor", "monitor_mcp", "local_bash", "shell"]);
const INERT_TASK_TYPES = new Set(["plan", "dream"]);
const OUTPUT_TRUNCATION_MARKER = "\n\n[... background output truncated ...]\n\n";
const PROGRESS_EVENTS_PER_PRUNE = 100;
const MIN_PRUNE_INTERVAL_MS = 30_000;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function classifyTask(taskType: string | undefined): BackgroundWorkClassification {
  if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) return "inert";
  if (taskType !== undefined && MONITOR_TASK_TYPES.has(taskType)) return "monitoring";
  return "working";
}

function ownershipForTask(taskType: string | undefined): BackgroundWorkOwnership {
  return taskType?.toLowerCase().includes("workflow") === true ? "workflow" : "direct-subagent";
}

function itemTerminalStatus(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): BackgroundWorkStatus | null {
  const data = asRecord(event.payload.data);
  const result = asRecord(data?.result);
  const backgroundStatus = asString(result?.backgroundStatus);
  if (backgroundStatus === "completed") return "completed";
  if (backgroundStatus === "failed") return "failed";
  if (backgroundStatus === "stopped" || backgroundStatus === "cancelled") return "stopped";
  if (backgroundStatus === "interrupted") return "interrupted";
  if (backgroundStatus === "running") return null;

  if (event.payload.status === "completed") return "completed";
  if (event.payload.status === "failed") return "failed";
  if (event.payload.status === "declined") return "stopped";
  return event.type === "item.completed" ? "completed" : null;
}

function lifecycleItemTransition(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): Omit<ThreadBackgroundWorkTransition, "providerInstanceId" | "providerSessionIdentity"> | null {
  if (event.payload.itemType !== "collab_agent_tool_call" || event.itemId === undefined) {
    return null;
  }

  const data = asRecord(event.payload.data);
  const input = asRecord(data?.input);
  const result = asRecord(data?.result);
  const terminalStatus = itemTerminalStatus(event);
  const latestOutput =
    asString(data?.subagentResult) ??
    asString(result?.content) ??
    asString(event.payload.detail) ??
    asString(data?.subagentDescription) ??
    asString(input?.description) ??
    asString(input?.prompt);

  return {
    threadId: event.threadId,
    workItemId: event.itemId,
    provider: event.provider,
    turnId: event.turnId ?? null,
    ...(event.type === "item.started" ? { classification: "working" as const } : {}),
    ...(event.type === "item.started" ? { ownership: "direct-subagent" as const } : {}),
    status: terminalStatus ?? "running",
    active: terminalStatus === null,
    model: asString(data?.subagentModel) ?? asString(input?.model) ?? null,
    phase:
      asString(data?.subagentType) ??
      asString(input?.subagent_type) ??
      asString(data?.toolName) ??
      null,
    latestOutput: latestOutput ?? null,
    occurredAt: event.createdAt,
  };
}

function taskTransition(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "task.started" | "task.progress" | "task.completed" }
  >,
): Omit<ThreadBackgroundWorkTransition, "providerInstanceId" | "providerSessionIdentity"> {
  if (event.type === "task.started") {
    const taskType = event.payload.taskType;
    const classification = classifyTask(taskType);
    return {
      threadId: event.threadId,
      workItemId: event.payload.taskId,
      provider: event.provider,
      turnId: event.turnId ?? null,
      classification,
      ownership: ownershipForTask(taskType),
      status:
        classification === "monitoring"
          ? "monitoring"
          : classification === "inert"
            ? "idle"
            : "running",
      active: classification !== "inert",
      phase: taskType ?? null,
      latestOutput: event.payload.description ?? null,
      occurredAt: event.createdAt,
    };
  }

  if (event.type === "task.progress") {
    return {
      threadId: event.threadId,
      workItemId: event.payload.taskId,
      provider: event.provider,
      turnId: event.turnId ?? null,
      status: "running",
      active: true,
      phase: event.payload.lastToolName ?? undefined,
      latestOutput: event.payload.description,
      occurredAt: event.createdAt,
    };
  }

  return {
    threadId: event.threadId,
    workItemId: event.payload.taskId,
    provider: event.provider,
    turnId: event.turnId ?? null,
    status: event.payload.status,
    active: false,
    latestOutput: event.payload.summary ?? undefined,
    occurredAt: event.createdAt,
  };
}

function subagentTransition(
  event: Extract<ProviderRuntimeEvent, { type: "subagent.activity" }>,
): Omit<ThreadBackgroundWorkTransition, "providerInstanceId" | "providerSessionIdentity"> {
  const active = event.payload.kind !== "interrupted";
  return {
    threadId: event.threadId,
    workItemId: `subagent:${event.payload.agentThreadId}`,
    provider: event.provider,
    turnId: event.turnId ?? null,
    ...(event.payload.kind === "started" ? { classification: "working" as const } : {}),
    ...(event.payload.kind === "started" ? { ownership: "direct-subagent" as const } : {}),
    status: active ? "running" : "interrupted",
    active,
    phase: event.payload.agentPath,
    occurredAt: event.createdAt,
  };
}

export function transitionFromProviderEvent(
  event: ProviderRuntimeEvent,
): Omit<ThreadBackgroundWorkTransition, "providerInstanceId" | "providerSessionIdentity"> | null {
  switch (event.type) {
    case "task.started":
    case "task.progress":
    case "task.completed":
      return taskTransition(event);
    case "item.started":
    case "item.updated":
    case "item.completed":
      return lifecycleItemTransition(event);
    case "subagent.activity":
      return subagentTransition(event);
    default:
      return null;
  }
}

function boundedOutput(value: string | null | undefined): {
  readonly latestOutput?: string | null;
  readonly outputTruncated?: boolean;
} {
  if (value === undefined) return {};
  if (value === null) return { latestOutput: null, outputTruncated: false };
  const result = truncateMiddleByBytes(value, {
    maxBytes: MAX_BACKGROUND_WORK_OUTPUT_BYTES,
    headBytes: 6 * 1024,
    marker: OUTPUT_TRUNCATION_MARKER,
  });
  return { latestOutput: result.output, outputTruncated: result.truncated };
}

const make = Effect.gen(function* () {
  const repository = yield* ThreadBackgroundWorkRepository;
  const directory = yield* ProviderSessionDirectory;
  const changesPubSub = yield* PubSub.unbounded<ThreadId | null>();
  const sessionIdentityByThreadId = new Map<
    ThreadId,
    {
      readonly providerInstanceId: ThreadBackgroundWorkTransition["providerInstanceId"];
      readonly providerSessionIdentity: string;
    }
  >();
  let transitionsSincePrune = 0;
  let lastPrunedAt = 0;

  const publish = (threadId: ThreadId | null) =>
    PubSub.publish(changesPubSub, threadId).pipe(Effect.asVoid);

  const recordProviderEvent: ThreadBackgroundWorkShape["recordProviderEvent"] = (event) =>
    Effect.gen(function* () {
      if (event.type === "session.started" || event.type === "thread.started") {
        sessionIdentityByThreadId.delete(event.threadId);
        return;
      }
      if (event.type === "session.exited") {
        yield* repository.markThreadInactive({
          threadId: event.threadId,
          completedAt: event.createdAt,
        });
        sessionIdentityByThreadId.delete(event.threadId);
        yield* publish(event.threadId);
        return;
      }

      const transition = transitionFromProviderEvent(event);
      if (transition === null) return;

      let sessionIdentity = sessionIdentityByThreadId.get(event.threadId);
      if (sessionIdentity === undefined) {
        const binding = yield* directory
          .getBinding(event.threadId)
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        const bindingValue = Option.getOrUndefined(binding);
        const providerInstanceId =
          event.providerInstanceId ?? bindingValue?.providerInstanceId ?? null;
        const providerSessionIdentity = bindingValue
          ? [
              bindingValue.provider,
              bindingValue.providerInstanceId ?? "default",
              bindingValue.adapterKey ?? bindingValue.provider,
              bindingValue.launchFingerprint ?? "default",
            ].join("|")
          : `${event.provider}|${providerInstanceId ?? "default"}`;
        sessionIdentity = { providerInstanceId, providerSessionIdentity };
        if (sessionIdentityByThreadId.size >= 2_048) {
          const oldestThreadId = sessionIdentityByThreadId.keys().next().value;
          if (oldestThreadId !== undefined) sessionIdentityByThreadId.delete(oldestThreadId);
        }
        sessionIdentityByThreadId.set(event.threadId, sessionIdentity);
      }

      yield* repository.upsertTransition({
        ...transition,
        ...sessionIdentity,
        ...boundedOutput(transition.latestOutput),
      });
      transitionsSincePrune += 1;
      const pruneNow = Date.now();
      const lifecyclePruneDue =
        (transition.classification !== undefined || !transition.active) &&
        pruneNow - lastPrunedAt >= MIN_PRUNE_INTERVAL_MS;
      if (lifecyclePruneDue || transitionsSincePrune >= PROGRESS_EVENTS_PER_PRUNE) {
        yield* repository.prune();
        transitionsSincePrune = 0;
        lastPrunedAt = pruneNow;
      }
      yield* publish(event.threadId);
    });

  const getSnapshot: ThreadBackgroundWorkShape["getSnapshot"] = repository
    .listSnapshot()
    .pipe(
      Effect.map((entries) => ({ entries: [...entries], generatedAt: new Date().toISOString() })),
    );

  const expireStale: ThreadBackgroundWorkShape["expireStale"] = (input) =>
    repository.expireStale(input).pipe(Effect.andThen(publish(null)));

  const listProtectedThreadIds: ThreadBackgroundWorkShape["listProtectedThreadIds"] = (input) =>
    repository.listProtectedThreadIds(input).pipe(Effect.map((threadIds) => new Set(threadIds)));

  return {
    recordProviderEvent,
    getSnapshot,
    expireStale,
    listProtectedThreadIds,
    hasFreshProtectingWork: (input) => repository.hasFreshProtectingWork(input),
    changes: Stream.fromPubSub(changesPubSub),
  } satisfies ThreadBackgroundWorkShape;
});

export const ThreadBackgroundWorkLive = Layer.effect(ThreadBackgroundWork, make).pipe(
  Layer.provide(ThreadBackgroundWorkRepositoryLive),
);
