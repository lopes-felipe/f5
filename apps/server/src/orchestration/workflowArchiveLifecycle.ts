import { timeOrderedUuid } from "@t3tools/shared/ids";
import type {
  PlanningWorkflow,
  CodeReviewWorkflow,
  InvestigationWorkflow,
  OrchestrationReadModel,
  OrchestrationCommand,
  OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import {
  threadIdsForPlanningWorkflow,
  threadIdsForCodeReviewWorkflow,
  threadIdsForInvestigationWorkflow,
} from "@t3tools/shared/workflowThreads";
import { Effect } from "effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { withEventBase } from "./eventBase.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import { CommandId } from "@t3tools/contracts";
import { makeOperationGate } from "../provider/operationGate.ts";

type WorkflowEntry =
  | { kind: "planning"; workflow: PlanningWorkflow }
  | { kind: "codeReview"; workflow: CodeReviewWorkflow }
  | { kind: "investigation"; workflow: InvestigationWorkflow };

export function workflowThreadIds(entry: WorkflowEntry): ThreadId[] {
  switch (entry.kind) {
    case "planning":
      return threadIdsForPlanningWorkflow(entry.workflow);
    case "codeReview":
      return threadIdsForCodeReviewWorkflow(entry.workflow);
    case "investigation":
      return threadIdsForInvestigationWorkflow(entry.workflow);
  }
}

export function workflowEntries(
  model: Pick<
    OrchestrationReadModel,
    "planningWorkflows" | "codeReviewWorkflows" | "investigationWorkflows"
  >,
) {
  const entries: WorkflowEntry[] = [
    ...(model.planningWorkflows ?? []).map((workflow) => ({ kind: "planning" as const, workflow })),
    ...(model.codeReviewWorkflows ?? []).map((workflow) => ({
      kind: "codeReview" as const,
      workflow,
    })),
    ...(model.investigationWorkflows ?? []).map((workflow) => ({
      kind: "investigation" as const,
      workflow,
    })),
  ];
  return entries.map((entry) => ({
    ...entry,
    threadIds: [
      ...new Set([
        ...workflowThreadIds(entry),
        ...(entry.workflow.archiveRestorations ?? []).map((item) => item.threadId),
      ]),
    ],
  }));
}

/** Parent and child deletions commit together; internal compensation stays record-only. */
export const decideWorkflowDelete = Effect.fn("decideWorkflowDelete")(function* (input: {
  entry: WorkflowEntry;
  readModel: OrchestrationReadModel;
  command: OrchestrationCommand;
  deleteThreads: boolean | undefined;
  event: Omit<OrchestrationEvent, "sequence">;
}) {
  if (!input.deleteThreads) return input.event;
  const entries = workflowEntries(input.readModel);
  const owner = entries.find(
    (entry) => entry.kind === input.entry.kind && entry.workflow.id === input.entry.workflow.id,
  );
  if (!owner) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: "Workflow does not exist.",
    });
  }
  const threadIds = new Set(owner.threadIds);
  const events: Omit<OrchestrationEvent, "sequence">[] = [input.event];
  let pinRevision = input.readModel.pinRevision ?? 0;
  for (const thread of input.readModel.threads) {
    if (!threadIds.has(thread.id) || thread.deletedAt !== null) continue;
    const sharedOwner = entries.some(
      (entry) =>
        entry.workflow.deletedAt === null &&
        !(entry.kind === owner.kind && entry.workflow.id === owner.workflow.id) &&
        entry.threadIds.includes(thread.id),
    );
    if (sharedOwner || thread.projectId !== owner.workflow.projectId) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: "Cannot delete a thread owned by another workflow or project.",
      });
    }
    events.push({
      ...withEventBase({
        commandId: input.command.commandId,
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: input.event.occurredAt,
      }),
      type: "thread.deleted",
      payload: {
        threadId: thread.id,
        deletedAt: input.event.occurredAt,
        ...(thread.pinnedAt != null ? { pinRevision: ++pinRevision } : {}),
      },
    });
  }
  return events;
});

/** Project deletion releases workflow retention even when old workflow JSON remains. */
export function retainedWorkflowThreadIds(model: OrchestrationReadModel): Set<ThreadId> {
  const deletedProjects = new Set(
    model.projects.filter((project) => project.deletedAt !== null).map((project) => project.id),
  );
  return new Set(
    workflowEntries(model)
      .filter(
        (entry) =>
          entry.workflow.deletedAt === null && !deletedProjects.has(entry.workflow.projectId),
      )
      .flatMap((entry) => entry.threadIds),
  );
}

/** Deleted threads cannot gain new owners once permanent cleanup may have started. */
export function requireAttachableWorkflowThreads(
  model: OrchestrationReadModel,
  command: OrchestrationCommand,
  ids: ReadonlyArray<ThreadId>,
) {
  return model.threads.some((thread) => ids.includes(thread.id) && thread.deletedAt !== null)
    ? Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Cannot attach a deleted thread to a workflow.",
        }),
      )
    : Effect.void;
}

/** One decision yields one atomic event batch; stage upserts cannot overwrite archive ownership. */
export const decideWorkflowArchive = Effect.fn("decideWorkflowArchive")(function* (input: {
  entry: WorkflowEntry;
  readModel: OrchestrationReadModel;
  command: OrchestrationCommand;
  occurredAt: string;
  operation: "archive" | "unarchive" | "preserve";
}) {
  const { readModel, command, occurredAt, operation } = input;
  const entries = workflowEntries(readModel);
  const current = entries.find(
    (entry) => entry.kind === input.entry.kind && entry.workflow.id === input.entry.workflow.id,
  )?.workflow;
  const previousThreadIds = new Set(
    entries.find(
      (entry) => entry.kind === input.entry.kind && entry.workflow.id === input.entry.workflow.id,
    )?.threadIds ?? [],
  );
  const archivedAt =
    operation === "archive"
      ? (current?.archivedAt ?? occurredAt)
      : operation === "unarchive"
        ? null
        : current
          ? current.archivedAt
          : input.entry.workflow.archivedAt;
  const restorations = [...(current?.archiveRestorations ?? [])];
  const deletedAt = current ? current.deletedAt : input.entry.workflow.deletedAt;
  const events: Omit<OrchestrationEvent, "sequence">[] = [];
  let pinRevision = readModel.pinRevision ?? 0;
  const threadBase = (threadId: ThreadId) =>
    withEventBase({
      commandId: command.commandId,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt,
    });
  const ids = new Set(workflowThreadIds(input.entry));
  if (operation === "unarchive") for (const item of restorations) ids.add(item.threadId);
  if (deletedAt !== null) ids.clear();
  // Once deleted, an unowned thread can be permanently purged. A stage update
  // must not acquire ownership halfway through that cleanup.
  yield* requireAttachableWorkflowThreads(
    readModel,
    command,
    [...ids].filter((id) => !previousThreadIds.has(id)),
  );
  for (const threadId of ids) {
    const thread = readModel.threads.find((thread) => thread.id === threadId);
    if (!thread || thread.deletedAt !== null) continue;
    if (archivedAt !== null || operation === "unarchive") {
      const conflict = entries.find(
        (entry) =>
          entry.workflow.deletedAt === null &&
          !(entry.kind === input.entry.kind && entry.workflow.id === input.entry.workflow.id) &&
          entry.threadIds.includes(threadId),
      );
      if (conflict || thread.projectId !== input.entry.workflow.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow thread ownership conflicts with another workflow or project.",
        });
      }
    }
    if (archivedAt !== null && thread.archivedAt === null) {
      const prior = restorations.findIndex((item) => item.threadId === threadId);
      const restoration = { threadId, archivedAt: occurredAt };
      if (prior < 0) restorations.push(restoration);
      else restorations[prior] = restoration;
      events.push({
        ...threadBase(threadId),
        type: "thread.archived",
        payload: {
          threadId,
          archivedAt: occurredAt,
          ...(thread.pinnedAt != null ? { pinRevision: ++pinRevision } : {}),
        },
      });
    } else if (
      operation === "unarchive" &&
      restorations.some(
        (item) => item.threadId === threadId && item.archivedAt === thread.archivedAt,
      )
    ) {
      events.push({
        ...threadBase(threadId),
        type: "thread.unarchived",
        payload: { threadId, unarchivedAt: occurredAt },
      });
    }
  }
  const patch = {
    archivedAt,
    deletedAt,
    archiveRestorations: operation === "unarchive" ? [] : restorations,
    updatedAt: operation === "preserve" ? input.entry.workflow.updatedAt : occurredAt,
  };
  const base = withEventBase({
    commandId: command.commandId,
    aggregateKind: "project",
    aggregateId: input.entry.workflow.projectId,
    occurredAt,
  });
  const projectId = input.entry.workflow.projectId;
  let workflowEvent: Omit<OrchestrationEvent, "sequence">;
  switch (input.entry.kind) {
    case "planning":
      workflowEvent = {
        ...base,
        type: "project.workflow-upserted",
        payload: { projectId, workflow: { ...input.entry.workflow, ...patch } },
      };
      break;
    case "codeReview":
      workflowEvent = {
        ...base,
        type: "project.code-review-workflow-upserted",
        payload: { projectId, workflow: { ...input.entry.workflow, ...patch } },
      };
      break;
    case "investigation":
      workflowEvent = {
        ...base,
        type: "project.investigation-workflow-upserted",
        payload: { projectId, workflow: { ...input.entry.workflow, ...patch } },
      };
      break;
  }
  // Preserve the single-event shape for ordinary stage updates.
  return events.length ? [workflowEvent, ...events] : workflowEvent;
});

/** Repair old archives using commands so projections, replay and side effects agree. */
export const reconcileWorkflowArchives = (engine: OrchestrationEngineShape) =>
  Effect.gen(function* () {
    const model = yield* engine.getReadModel();
    for (const entry of workflowEntries(model)) {
      if (entry.workflow.deletedAt !== null || entry.workflow.archivedAt === null) continue;
      if (
        !model.threads.some(
          (thread) =>
            entry.threadIds.includes(thread.id) &&
            thread.deletedAt === null &&
            thread.archivedAt === null,
        )
      )
        continue;
      yield* engine
        .dispatch({
          type: "project.workflow.archive",
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
          projectId: entry.workflow.projectId,
          workflowId: entry.workflow.id,
          workflowKind: entry.kind,
          createdAt: new Date().toISOString(),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Failed to reconcile archived workflow; continuing startup", {
              workflowKind: entry.kind,
              workflowId: entry.workflow.id,
              cause,
            }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Failed to read workflows for archive reconciliation", { cause }),
    ),
  );

const setWorkflowArchived = (
  engine: OrchestrationEngineShape,
  kind: WorkflowEntry["kind"],
  workflowId: WorkflowEntry["workflow"]["id"],
  archived: boolean,
) =>
  Effect.gen(function* () {
    const entry = workflowEntries(yield* engine.getReadModel()).find(
      (entry) =>
        entry.kind === kind &&
        entry.workflow.id === workflowId &&
        entry.workflow.deletedAt === null,
    );
    if (!entry) return yield* Effect.fail(new Error("Workflow does not exist."));
    yield* engine
      .dispatch({
        type: archived ? "project.workflow.archive" : "project.workflow.unarchive",
        commandId: CommandId.makeUnsafe(timeOrderedUuid()),
        projectId: entry.workflow.projectId,
        workflowKind: kind,
        workflowId,
        createdAt: new Date().toISOString(),
      })
      .pipe(Effect.mapError((cause) => new Error(String(cause))));
    return entry.workflow.archivedAt !== null;
  });

/** Keep concurrent lifecycle RPCs and restore continuation ordered per workflow. */
export function makeWorkflowArchiveLifecycle(
  engine: OrchestrationEngineShape,
  kind: WorkflowEntry["kind"],
) {
  const withWorkflowGate = makeOperationGate<WorkflowEntry["workflow"]["id"]>();
  const changeArchive = <E = never>(
    workflowId: WorkflowEntry["workflow"]["id"],
    archived: boolean,
    reconcile?: (model: OrchestrationReadModel) => Effect.Effect<void, E>,
  ) =>
    withWorkflowGate(
      workflowId,
      Effect.gen(function* () {
        const wasArchived = yield* setWorkflowArchived(engine, kind, workflowId, archived);
        if (wasArchived && !archived && reconcile) yield* reconcile(yield* engine.getReadModel());
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    );
  return {
    archive: (workflowId: WorkflowEntry["workflow"]["id"]) => changeArchive(workflowId, true),
    unarchive: <E = never>(
      workflowId: WorkflowEntry["workflow"]["id"],
      reconcile?: (model: OrchestrationReadModel) => Effect.Effect<void, E>,
    ) => changeArchive(workflowId, false, reconcile),
    delete: <A, E>(workflowId: WorkflowEntry["workflow"]["id"], operation: Effect.Effect<A, E>) =>
      withWorkflowGate(workflowId, operation),
  };
}
