/**
 * SnapshotRecovery - Rebuild a profile database from an orchestration read model.
 *
 * When `state.sqlite` is destroyed while the backend is still running, the
 * engine's in-memory read model (`orchestration.getSnapshot`) is the most
 * complete surviving copy. This module turns that read model back into
 * orchestration events so a fresh database can be bootstrapped through the
 * normal projection pipeline, and compares the rebuilt snapshot to the input.
 *
 * Event and command IDs are derived from each event's aggregate ID and its
 * position in the output, so the same snapshot always produces the same
 * events. Live sessions are always restored as stopped.
 *
 * Three read-model fields have no event that sets them to an arbitrary value:
 * `latestTurn` (its turn may have no checkpoint), `lastInteractionAt` and each
 * pin's `pinnedAt`. After replay they are written straight into the thread and
 * turn projections from the snapshot ({@link restoreProjectionOnlyState}).
 *
 * Not recovered, because the read model does not hold it:
 * - command executions and file changes (tool rows and tail details);
 * - usage and cost facts;
 * - turns other than the latest that have no checkpoint;
 * - the attachment registry: attachment files stay on disk but are not owned
 *   by any thread, so deleting or purging a thread does not remove them;
 * - queued turns, provider resume cursors and in-flight title regeneration;
 * - scheduled-task runs and telemetry.
 *
 * @module SnapshotRecovery
 */
import { createHash } from "node:crypto";

import {
  CommandId,
  EventId,
  OrchestrationReadModel,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";

export type RecoveryEvent = Omit<OrchestrationEvent, "sequence">;
type EventType = OrchestrationEvent["type"];
// Distributes over the event union; some events declare several type literals.
type PayloadOf<T extends EventType> = OrchestrationEvent extends infer E
  ? E extends { readonly type: infer U; readonly payload: infer P }
    ? T extends U
      ? P
      : never
    : never
  : never;

/** Appends one event whose payload is type-checked against its event type. */
type PushEvent = <T extends EventType>(
  aggregateKind: "project" | "thread",
  aggregateId: ProjectId | ThreadId,
  type: T,
  occurredAt: string,
  payload: PayloadOf<T>,
) => void;

// Fixed namespace so repeated runs over one snapshot produce identical IDs.
const RECOVERY_NAMESPACE = "f5-snapshot-recovery-v1";

function deterministicUuid(...parts: ReadonlyArray<string | number>): string {
  const hash = createHash("sha1")
    .update([RECOVERY_NAMESPACE, ...parts].join("\u0000"))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Accepts either the raw `orchestration.getSnapshot` WebSocket response
 * (`{ id, result }`) or a bare read model, applying schema defaults.
 */
export function decodeRecoverySnapshot(input: unknown): OrchestrationReadModel {
  const candidate =
    input !== null && typeof input === "object" && "result" in input
      ? (input as { readonly result: unknown }).result
      : input;
  return Schema.decodeUnknownSync(OrchestrationReadModel)(candidate);
}

function latestTimestamp(values: ReadonlyArray<string | null | undefined>, fallback: string) {
  let latest = fallback;
  for (const value of values) if (value && value > latest) latest = value;
  return latest;
}

/**
 * Converts a read model into an ordered list of events that rebuild it.
 */
export function readModelToRecoveryEvents(model: OrchestrationReadModel): RecoveryEvent[] {
  const events: RecoveryEvent[] = [];
  const push: PushEvent = (aggregateKind, aggregateId, type, occurredAt, payload) => {
    const ordinal = events.length;
    const commandId = CommandId.makeUnsafe(deterministicUuid("command", aggregateId, ordinal));
    events.push({
      eventId: EventId.makeUnsafe(deterministicUuid("event", aggregateId, ordinal)),
      aggregateKind,
      aggregateId,
      type,
      occurredAt,
      commandId,
      causationEventId: null,
      correlationId: commandId,
      metadata: {},
      payload,
    } as RecoveryEvent);
  };

  for (const project of model.projects) {
    push("project", project.id, "project.created", project.createdAt, {
      projectId: project.id,
      kind: project.kind,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      defaultModel: project.defaultModel,
      defaultModelSelection: project.defaultModelSelection,
      defaultEnvMode: project.defaultEnvMode,
      icon: project.icon,
      scripts: project.scripts,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
    for (const memory of project.memories) {
      push("project", project.id, "project.memory-saved", memory.createdAt, {
        projectId: project.id,
        memory,
      });
    }
    if (project.skills && project.skills.length > 0) {
      push("project", project.id, "project.skills-replaced", project.updatedAt, {
        projectId: project.id,
        skills: project.skills,
        updatedAt: project.updatedAt,
      });
    }
  }

  for (const thread of model.threads) pushThreadEvents(thread, push);

  for (const workflow of model.planningWorkflows) {
    push("project", workflow.projectId, "project.workflow-created", workflow.createdAt, {
      projectId: workflow.projectId,
      workflow,
    });
  }
  for (const workflow of model.codeReviewWorkflows) {
    push(
      "project",
      workflow.projectId,
      "project.code-review-workflow-created",
      workflow.createdAt,
      { projectId: workflow.projectId, workflow },
    );
  }
  for (const workflow of model.investigationWorkflows) {
    push(
      "project",
      workflow.projectId,
      "project.investigation-workflow-created",
      workflow.createdAt,
      { projectId: workflow.projectId, workflow },
    );
  }

  const pinned = model.threads
    .filter((thread) => thread.pinOrderKey !== null && thread.deletedAt === null)
    .toSorted((left, right) => left.pinOrderKey! - right.pinOrderKey!);
  if (pinned.length > 0) {
    const updatedAt = latestTimestamp(
      pinned.map((thread) => thread.pinnedAt),
      pinned[0]!.createdAt,
    );
    push("thread", pinned[0]!.id, "thread.pins-replaced", updatedAt, {
      threadId: pinned[0]!.id,
      pinnedThreadIds: pinned.map((thread) => thread.id),
      pinRevision: Math.max(model.pinRevision ?? 0, 1),
      updatedAt,
    });
  }

  // Deleting a project last keeps thread and workflow events valid.
  for (const project of model.projects) {
    if (project.deletedAt !== null) {
      push("project", project.id, "project.deleted", project.deletedAt, {
        projectId: project.id,
        deletedAt: project.deletedAt,
      });
    }
  }
  return events;
}

interface PendingEvent {
  readonly occurredAt: string;
  readonly emit: () => void;
}

function pushThreadEvents(thread: OrchestrationThread, push: PushEvent) {
  const threadId = thread.id;
  push("thread", threadId, "thread.created", thread.createdAt, {
    ...(thread.scheduledOrigin !== undefined ? { scheduledOrigin: thread.scheduledOrigin } : {}),
    threadId,
    projectId: thread.projectId,
    title: thread.title,
    model: thread.model,
    ...(thread.modelSelection !== undefined ? { modelSelection: thread.modelSelection } : {}),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    scratchPath: thread.scratchPath,
    threadReferences: thread.threadReferences ?? [],
    titleSource: thread.titleSource,
    titleRevision: thread.titleRevision,
    titleUpdatedAt: thread.titleUpdatedAt,
    createdAt: thread.createdAt,
    updatedAt: thread.createdAt,
  });
  // The creation projector ignores titleState; only metadata updates store it.
  if (thread.titleState) {
    push("thread", threadId, "thread.meta-updated", thread.createdAt, {
      threadId,
      titleState: thread.titleState,
      updatedAt: thread.createdAt,
    });
  }
  // Before any checkpoint: the session projector sets latestTurnId to the
  // (always null) active turn, which would otherwise clear it.
  if (thread.session) {
    push("thread", threadId, "thread.session-set", thread.session.updatedAt, {
      threadId,
      session: {
        ...thread.session,
        status: "stopped",
        activeTurnId: null,
      },
    });
  }

  // Projectors overwrite lastInteractionAt with each event's time, so content
  // is replayed in time order, not grouped by kind.
  const content: PendingEvent[] = [];
  for (const message of thread.messages) {
    content.push({
      occurredAt: message.createdAt,
      emit: () => {
        push("thread", threadId, "thread.message-sent", message.createdAt, {
          threadId,
          messageId: message.id,
          role: message.role,
          text: message.text,
          ...(message.reasoningText !== undefined ? { reasoningText: message.reasoningText } : {}),
          ...(message.skillCall !== undefined ? { skillCall: message.skillCall } : {}),
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          turnId: message.turnId,
          // A message still streaming when the database died will never finish.
          streaming: false,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        });
        if (message.turnId !== null && (message.reasoningTokens ?? 0) > 0) {
          push("thread", threadId, "thread.message-reasoning-tokens-added", message.updatedAt, {
            threadId,
            messageId: message.id,
            turnId: message.turnId,
            tokens: message.reasoningTokens!,
            estimated: message.reasoningTokensEstimated ?? false,
            updatedAt: message.updatedAt,
          });
        }
      },
    });
  }
  for (const proposedPlan of thread.proposedPlans) {
    content.push({
      occurredAt: proposedPlan.updatedAt,
      emit: () =>
        push("thread", threadId, "thread.proposed-plan-upserted", proposedPlan.updatedAt, {
          threadId,
          proposedPlan,
        }),
    });
  }
  for (const activity of thread.activities) {
    content.push({
      occurredAt: activity.createdAt,
      emit: () =>
        push("thread", threadId, "thread.activity-appended", activity.createdAt, {
          threadId,
          activity,
        }),
    });
  }
  for (const checkpoint of thread.checkpoints.toSorted(
    (left, right) => left.checkpointTurnCount - right.checkpointTurnCount,
  )) {
    content.push({
      occurredAt: checkpoint.completedAt,
      emit: () => {
        push("thread", threadId, "thread.turn-diff-completed", checkpoint.completedAt, {
          threadId,
          ...checkpoint,
        });
        // A checkpointed turn finished processing; without this the thread
        // cannot be settled ("still running").
        push("thread", threadId, "thread.turn-processing-quiesced", checkpoint.completedAt, {
          threadId,
          turnId: checkpoint.turnId,
          processingQuiescedAt: checkpoint.completedAt,
        });
      },
    });
  }
  // An empty list still carries tracking state (generation, handled calls).
  if (thread.tasksUpdatedAt !== null) {
    const updatedAt = thread.tasksUpdatedAt;
    content.push({
      occurredAt: updatedAt,
      emit: () =>
        push("thread", threadId, "thread.tasks.updated", updatedAt, {
          threadId,
          tasks: thread.tasks,
          turnId: thread.tasksTurnId,
          tracking: thread.tasksTracking ?? null,
          updatedAt,
        }),
    });
  }
  if (thread.sessionNotes) {
    const sessionNotes = thread.sessionNotes;
    content.push({
      occurredAt: sessionNotes.updatedAt,
      emit: () =>
        push("thread", threadId, "thread.session-notes-recorded", sessionNotes.updatedAt, {
          threadId,
          sessionNotes,
        }),
    });
  }
  if (thread.compaction) {
    const compaction = thread.compaction;
    content.push({
      occurredAt: compaction.createdAt,
      emit: () =>
        push("thread", threadId, "thread.compacted", compaction.createdAt, {
          threadId,
          compaction,
        }),
    });
  }
  // Stable: same-time events keep the kind order above.
  for (const event of content.toSorted((left, right) =>
    left.occurredAt < right.occurredAt ? -1 : left.occurredAt > right.occurredAt ? 1 : 0,
  ))
    event.emit();

  if (thread.autoSettleDisabled) {
    push("thread", threadId, "thread.auto-settle-changed", thread.updatedAt, {
      threadId,
      enabled: false,
    });
  }
  if (thread.settledAt && thread.settledBy) {
    push("thread", threadId, "thread.settled", thread.settledAt, {
      threadId,
      settledAt: thread.settledAt,
      settledBy: thread.settledBy,
    });
  }
  if (thread.snoozedUntil && thread.snoozedAt) {
    push("thread", threadId, "thread.snoozed", thread.snoozedAt, {
      threadId,
      snoozedUntil: thread.snoozedUntil,
      snoozedAt: thread.snoozedAt,
    });
  }
  if (thread.archivedAt) {
    push("thread", threadId, "thread.archived", thread.archivedAt, {
      threadId,
      archivedAt: thread.archivedAt,
    });
  }
  if (thread.deletedAt) {
    push("thread", threadId, "thread.deleted", thread.deletedAt, {
      threadId,
      deletedAt: thread.deletedAt,
    });
  }
}

/**
 * Writes the read-model fields no event can set exactly: each thread's
 * `latestTurn` (creating its turn row when the turn had no checkpoint),
 * `lastInteractionAt` and `pinnedAt`.
 */
export const restoreProjectionOnlyState = (model: OrchestrationReadModel) =>
  Effect.gen(function* () {
    const threads = yield* ProjectionThreadRepository;
    const turns = yield* ProjectionTurnRepository;
    for (const thread of model.threads) {
      if (thread.deletedAt !== null) continue;
      const latest = thread.latestTurn;
      if (latest) {
        const existing = yield* turns.getByTurnId({ threadId: thread.id, turnId: latest.turnId });
        const base = Option.getOrNull(existing);
        yield* turns.upsertByTurnId({
          threadId: thread.id,
          turnId: latest.turnId,
          pendingMessageId: base?.pendingMessageId ?? null,
          assistantMessageId: latest.assistantMessageId,
          // A running turn died with the backend; the session is stopped too.
          state: latest.state === "running" ? "interrupted" : latest.state,
          requestedAt: latest.requestedAt,
          startedAt: latest.startedAt,
          completedAt: latest.completedAt,
          processingQuiescedAt: latest.processingQuiescedAt ?? base?.processingQuiescedAt ?? null,
          checkpointTurnCount: base?.checkpointTurnCount ?? null,
          checkpointRef: base?.checkpointRef ?? null,
          checkpointStatus: base?.checkpointStatus ?? null,
          checkpointFiles: base?.checkpointFiles ?? [],
        });
      }
      const row = yield* threads.getById({ threadId: thread.id });
      if (Option.isNone(row)) continue;
      yield* threads.upsert({
        ...row.value,
        latestTurnId: latest?.turnId ?? null,
        lastInteractionAt: thread.lastInteractionAt,
        pinnedAt: thread.pinOrderKey !== null ? (thread.pinnedAt ?? null) : row.value.pinnedAt,
      });
    }
  });

export interface RecoveryMismatch {
  readonly entity: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** JSON with sorted keys and without undefined values, for content comparison. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>)
            .filter(([, inner]) => inner !== undefined)
            .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        )
      : entry,
  );
}

/**
 * The thread as recovery is expected to reproduce it. Documented recovery
 * differences are applied (no streaming messages, stopped sessions,
 * interrupted running turns); fields recovery never restores are left out.
 */
function expectedThreadContent(thread: OrchestrationThread) {
  return {
    scheduledOrigin: thread.scheduledOrigin ?? null,
    projectId: thread.projectId,
    title: thread.title,
    model: thread.model,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    scratchPath: thread.scratchPath,
    threadReferences: thread.threadReferences ?? [],
    titleState: thread.titleState ?? null,
    titleSource: thread.titleSource,
    titleRevision: thread.titleRevision,
    titleUpdatedAt: thread.titleUpdatedAt,
    latestTurn: thread.latestTurn
      ? {
          ...thread.latestTurn,
          state: thread.latestTurn.state === "running" ? "interrupted" : thread.latestTurn.state,
          processingQuiescedAt: thread.latestTurn.processingQuiescedAt ?? null,
          workflowExecutionProfile: undefined,
        }
      : null,
    archivedAt: thread.archivedAt,
    pinOrderKey: thread.pinOrderKey,
    pinnedAt: thread.pinOrderKey !== null ? thread.pinnedAt : null,
    snoozedUntil: thread.snoozedUntil,
    snoozedAt: thread.snoozedAt,
    settledAt: thread.settledAt,
    settledBy: thread.settledBy,
    autoSettleDisabled: thread.autoSettleDisabled,
    lastInteractionAt: thread.lastInteractionAt,
    deletedAt: thread.deletedAt,
    messages: thread.messages.map((message) => ({
      ...message,
      streaming: false,
      // The projection stores an explicit `false` once tokens are recorded.
      reasoningTokensEstimated:
        message.reasoningTokens !== undefined
          ? (message.reasoningTokensEstimated ?? false)
          : message.reasoningTokensEstimated,
    })),
    proposedPlans: thread.proposedPlans,
    activities: thread.activities,
    checkpoints: thread.checkpoints.toSorted(
      (left, right) => left.checkpointTurnCount - right.checkpointTurnCount,
    ),
    tasks: thread.tasks,
    tasksTurnId: thread.tasksTurnId,
    tasksUpdatedAt: thread.tasksUpdatedAt,
    tasksTracking: thread.tasksTracking ?? null,
    sessionNotes: thread.sessionNotes ?? null,
    compaction: thread.compaction ?? null,
    // Usage figures are recomputed by the session projector, and the live
    // session's in-memory timestamps and estimates are never persisted.
    session: thread.session
      ? {
          ...thread.session,
          status: "stopped",
          activeTurnId: null,
          updatedAt: undefined,
          estimatedContextTokens: undefined,
          estimatedThinkingTokens: undefined,
          modelContextWindowTokens: undefined,
          tokenUsageSource: undefined,
          usageLimit: undefined,
        }
      : null,
  };
}

function projectContent(project: OrchestrationReadModel["projects"][number]) {
  return {
    kind: project.kind,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    defaultModel: project.defaultModel,
    defaultModelSelection: project.defaultModelSelection,
    defaultEnvMode: project.defaultEnvMode,
    icon: project.icon,
    scripts: project.scripts,
    deletedAt: project.deletedAt,
    memories: project.memories,
    skills: project.skills ?? [],
  };
}

/**
 * Lists differences between the snapshot that was recovered and the snapshot
 * read back from the rebuilt database, comparing entity contents (messages,
 * turns, tasks, notes, workflows and so on), not just counts.
 *
 * An empty list means every field recovery restores came back unchanged; it
 * says nothing about the data listed as not recovered in the module header.
 */
export function compareRecoveredReadModel(
  expected: OrchestrationReadModel,
  actual: OrchestrationReadModel,
): RecoveryMismatch[] {
  const mismatches: RecoveryMismatch[] = [];
  const check = (entity: string, field: string, left: unknown, right: unknown) => {
    if (left !== right) mismatches.push({ entity, field, expected: left, actual: right });
  };
  /** Compares two values by content; arrays report their first differing element. */
  const compare = (entity: string, field: string, left: unknown, right: unknown) => {
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) {
        check(entity, `${field}.length`, left.length, right.length);
        return;
      }
      const index = left.findIndex((entry, at) => canonical(entry) !== canonical(right[at]));
      if (index >= 0) {
        mismatches.push({
          entity,
          field: `${field}[${index}]`,
          expected: left[index],
          actual: right[index],
        });
      }
      return;
    }
    if (canonical(left) !== canonical(right)) {
      mismatches.push({ entity, field, expected: left, actual: right });
    }
  };
  const compareFields = (
    entity: string,
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ) => {
    for (const field of Object.keys(left)) compare(entity, field, left[field], right[field]);
  };

  check("model", "projects", expected.projects.length, actual.projects.length);
  check("model", "threads", expected.threads.length, actual.threads.length);

  const actualProjects = new Map(actual.projects.map((project) => [project.id, project]));
  for (const project of expected.projects) {
    const restored = actualProjects.get(project.id);
    const entity = `project ${project.id}`;
    if (!restored) {
      check(entity, "present", true, false);
      continue;
    }
    compareFields(entity, projectContent(project), projectContent(restored));
  }

  const actualThreads = new Map(actual.threads.map((thread) => [thread.id, thread]));
  for (const thread of expected.threads) {
    const restored = actualThreads.get(thread.id);
    const entity = `thread ${thread.id}`;
    if (!restored) {
      check(entity, "present", true, false);
      continue;
    }
    // Deleted threads keep their history in SQLite but not in read models.
    if (thread.deletedAt !== null) {
      check(entity, "deleted", true, restored.deletedAt !== null);
      continue;
    }
    compareFields(entity, expectedThreadContent(thread), expectedThreadContent(restored));
  }

  for (const kind of [
    "planningWorkflows",
    "codeReviewWorkflows",
    "investigationWorkflows",
  ] as const) {
    const restoredById = new Map<string, unknown>(
      (actual[kind] as ReadonlyArray<{ readonly id: string }>).map((workflow) => [
        workflow.id,
        workflow,
      ]),
    );
    check("model", kind, expected[kind].length, actual[kind].length);
    for (const workflow of expected[kind] as ReadonlyArray<{ readonly id: string }>) {
      const entity = `${kind} ${workflow.id}`;
      const restored = restoredById.get(workflow.id);
      if (restored === undefined) check(entity, "present", true, false);
      else compare(entity, "content", workflow, restored);
    }
  }
  return mismatches;
}

export interface RecoveryReport {
  readonly events: number;
  readonly projects: number;
  readonly threads: number;
  readonly messages: number;
  readonly integrity: string;
  readonly mismatches: ReadonlyArray<RecoveryMismatch>;
}

/**
 * Appends recovery events to an empty database, bootstraps projections and
 * verifies the rebuilt snapshot against the input.
 */
export const rebuildFromSnapshot = (model: OrchestrationReadModel) =>
  Effect.gen(function* () {
    const eventStore = yield* OrchestrationEventStore;
    const pipeline = yield* OrchestrationProjectionPipeline;
    const snapshots = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;

    const existing = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events
    `;
    if ((existing[0]?.count ?? 0) > 0) {
      return yield* Effect.die(new Error("Refusing to recover into a database that has events."));
    }

    const events = readModelToRecoveryEvents(model);
    for (const event of events) yield* eventStore.append(event);
    yield* pipeline.bootstrap;
    yield* restoreProjectionOnlyState(model);

    // The read the engine hydrates from at startup; unlike `getSnapshot` it has
    // no interactive time budget, which a full profile easily exceeds.
    const restored = yield* snapshots.getBootstrapSnapshot();
    const integrityRows = yield* sql<{ readonly integrity_check: string }>`PRAGMA integrity_check`;
    return {
      events: events.length,
      projects: restored.projects.length,
      threads: restored.threads.length,
      messages: restored.threads.reduce((sum, thread) => sum + thread.messages.length, 0),
      integrity: integrityRows.map((row) => row.integrity_check).join("; "),
      mismatches: compareRecoveredReadModel(model, restored),
    } satisfies RecoveryReport;
  });
