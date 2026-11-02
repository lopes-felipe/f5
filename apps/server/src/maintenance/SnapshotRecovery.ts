/**
 * SnapshotRecovery - Rebuild a profile database from an orchestration read model.
 *
 * When `state.sqlite` is destroyed while the backend is still running, the
 * engine's in-memory read model (`orchestration.getSnapshot`) is the most
 * complete surviving copy. This module turns that read model back into
 * orchestration events so a fresh database can be bootstrapped through the
 * normal projection pipeline, and compares the rebuilt snapshot to the input.
 *
 * Event and command IDs are derived deterministically from entity IDs, so the
 * same snapshot always produces the same events. Live sessions are always
 * restored as stopped; turn lifecycle, queued turns and provider resume state
 * are not part of the read model and are not recovered.
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
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";

export type RecoveryEvent = Omit<OrchestrationEvent, "sequence">;

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
  const push = (
    aggregateKind: "project" | "thread",
    aggregateId: ProjectId | ThreadId,
    type: RecoveryEvent["type"],
    occurredAt: string,
    payload: unknown,
  ) => {
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

function pushThreadEvents(
  thread: OrchestrationThread,
  push: (
    aggregateKind: "thread",
    aggregateId: ThreadId,
    type: RecoveryEvent["type"],
    occurredAt: string,
    payload: unknown,
  ) => void,
) {
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
    ...(thread.titleState !== undefined ? { titleState: thread.titleState } : {}),
    titleSource: thread.titleSource,
    titleRevision: thread.titleRevision,
    titleUpdatedAt: thread.titleUpdatedAt,
    createdAt: thread.createdAt,
    updatedAt: thread.createdAt,
  });
  for (const message of thread.messages) {
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
  }
  for (const proposedPlan of thread.proposedPlans) {
    push("thread", threadId, "thread.proposed-plan-upserted", proposedPlan.updatedAt, {
      threadId,
      proposedPlan,
    });
  }
  for (const activity of thread.activities) {
    push("thread", threadId, "thread.activity-appended", activity.createdAt, {
      threadId,
      activity,
    });
  }
  for (const checkpoint of thread.checkpoints) {
    push("thread", threadId, "thread.turn-diff-completed", checkpoint.completedAt, {
      threadId,
      ...checkpoint,
    });
  }
  if (thread.tasks.length > 0 && thread.tasksUpdatedAt !== null) {
    push("thread", threadId, "thread.tasks.updated", thread.tasksUpdatedAt, {
      threadId,
      tasks: thread.tasks,
      turnId: thread.tasksTurnId,
      tracking: thread.tasksTracking ?? null,
      updatedAt: thread.tasksUpdatedAt,
    });
  }
  if (thread.sessionNotes) {
    push("thread", threadId, "thread.session-notes-recorded", thread.updatedAt, {
      threadId,
      sessionNotes: thread.sessionNotes,
    });
  }
  if (thread.compaction) {
    push("thread", threadId, "thread.compacted", thread.updatedAt, {
      threadId,
      compaction: thread.compaction,
    });
  }
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

export interface RecoveryMismatch {
  readonly entity: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Lists differences between the snapshot that was recovered and the snapshot
 * read back from the rebuilt database. An empty list means a faithful rebuild.
 */
export function compareRecoveredReadModel(
  expected: OrchestrationReadModel,
  actual: OrchestrationReadModel,
): RecoveryMismatch[] {
  const mismatches: RecoveryMismatch[] = [];
  const check = (entity: string, field: string, left: unknown, right: unknown) => {
    if (left !== right) mismatches.push({ entity, field, expected: left, actual: right });
  };

  check("model", "projects", expected.projects.length, actual.projects.length);
  check("model", "threads", expected.threads.length, actual.threads.length);
  check(
    "model",
    "planningWorkflows",
    expected.planningWorkflows.length,
    actual.planningWorkflows.length,
  );
  check(
    "model",
    "codeReviewWorkflows",
    expected.codeReviewWorkflows.length,
    actual.codeReviewWorkflows.length,
  );
  check(
    "model",
    "investigationWorkflows",
    expected.investigationWorkflows.length,
    actual.investigationWorkflows.length,
  );

  const actualProjects = new Map(actual.projects.map((project) => [project.id, project]));
  for (const project of expected.projects) {
    const restored = actualProjects.get(project.id);
    const entity = `project ${project.id}`;
    if (!restored) {
      check(entity, "present", true, false);
      continue;
    }
    check(entity, "title", project.title, restored.title);
    check(entity, "workspaceRoot", project.workspaceRoot, restored.workspaceRoot);
    check(entity, "deleted", project.deletedAt !== null, restored.deletedAt !== null);
    check(entity, "memories", project.memories.length, restored.memories.length);
  }

  const actualThreads = new Map(actual.threads.map((thread) => [thread.id, thread]));
  for (const thread of expected.threads) {
    const restored = actualThreads.get(thread.id);
    const entity = `thread ${thread.id}`;
    if (!restored) {
      check(entity, "present", true, false);
      continue;
    }
    check(entity, "title", thread.title, restored.title);
    check(entity, "projectId", thread.projectId, restored.projectId);
    check(entity, "worktreePath", thread.worktreePath, restored.worktreePath);
    check(entity, "archived", thread.archivedAt !== null, restored.archivedAt !== null);
    check(entity, "deleted", thread.deletedAt !== null, restored.deletedAt !== null);
    // Deleted threads keep their history in SQLite but not in read models.
    if (thread.deletedAt !== null) continue;
    check(entity, "messages", thread.messages.length, restored.messages.length);
    check(entity, "proposedPlans", thread.proposedPlans.length, restored.proposedPlans.length);
    check(entity, "checkpoints", thread.checkpoints.length, restored.checkpoints.length);
    check(entity, "pinned", thread.pinOrderKey !== null, restored.pinOrderKey !== null);
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
