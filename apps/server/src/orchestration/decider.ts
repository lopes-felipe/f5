import {
  MAX_PINNED_THREADS,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError, ThreadTurnAlreadyActiveError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { validateThreadTasks } from "./threadTasks.ts";

const nowIso = () => new Date().toISOString();
const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered" as const;
const GLOBAL_PIN_AGGREGATE_ID = ProjectId.makeUnsafe("f5-global-pins");

const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function makeThreadUnsnoozedEvent(input: {
  readonly commandId: OrchestrationCommand["commandId"];
  readonly threadId: ThreadId;
  readonly occurredAt: string;
}): Omit<OrchestrationEvent, "sequence"> {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.occurredAt,
      commandId: input.commandId,
    }),
    type: "thread.unsnoozed",
    payload: {
      threadId: input.threadId,
      unsnoozedAt: input.occurredAt,
    },
  };
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError | ThreadTurnAlreadyActiveError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModel: command.defaultModel ?? null,
          defaultEnvMode: command.defaultEnvMode ?? null,
          icon: command.icon ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModel !== undefined ? { defaultModel: command.defaultModel } : {}),
          ...(command.defaultEnvMode !== undefined
            ? { defaultEnvMode: command.defaultEnvMode }
            : {}),
          ...(command.icon !== undefined ? { icon: command.icon } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeChildThreadCount = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      ).length;
      if (activeChildThreadCount > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted while active threads still exist.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "project.memory.save": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const existing = readModel.projects
        .find((project) => project.id === command.projectId)
        ?.memories.find((memory) => memory.id === command.memoryId && memory.deletedAt === null);
      if (existing) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project memory '${command.memoryId}' already exists.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.memory-saved",
        payload: {
          projectId: command.projectId,
          memory: {
            id: command.memoryId,
            projectId: command.projectId,
            scope: command.scope,
            type: command.memoryType,
            name: command.name,
            description: command.description,
            body: command.body,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
            deletedAt: null,
          },
        },
      };
    }

    case "project.memory.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const existing = readModel.projects
        .find((project) => project.id === command.projectId)
        ?.memories.find((memory) => memory.id === command.memoryId && memory.deletedAt === null);
      if (!existing) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project memory '${command.memoryId}' does not exist.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "project.memory-updated",
        payload: {
          projectId: command.projectId,
          memory: {
            ...existing,
            scope: command.scope,
            type: command.memoryType,
            name: command.name,
            description: command.description,
            body: command.body,
            updatedAt: command.updatedAt,
          },
        },
      };
    }

    case "project.memory.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const existing = readModel.projects
        .find((project) => project.id === command.projectId)
        ?.memories.find((memory) => memory.id === command.memoryId && memory.deletedAt === null);
      if (!existing) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project memory '${command.memoryId}' does not exist.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.deletedAt,
          commandId: command.commandId,
        }),
        type: "project.memory-deleted",
        payload: {
          projectId: command.projectId,
          memoryId: command.memoryId,
          deletedAt: command.deletedAt,
        },
      };
    }

    case "project.skills.replace": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const mismatchedSkill = command.skills.find((skill) => skill.projectId !== command.projectId);
      if (mismatchedSkill) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Skill '${mismatchedSkill.id}' must belong to project '${command.projectId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "project.skills-replaced",
        payload: {
          projectId: command.projectId,
          skills: command.skills,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "project.workflow.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const existing = readModel.planningWorkflows.find(
        (entry) => entry.id === command.workflowId && entry.deletedAt === null,
      );
      if (existing) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow '${command.workflowId}' already exists.`,
        });
      }
      const duplicateSlug = readModel.planningWorkflows.find(
        (entry) =>
          entry.projectId === command.projectId &&
          entry.slug === command.slug &&
          entry.deletedAt === null,
      );
      if (duplicateSlug) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow slug '${command.slug}' already exists in project '${command.projectId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.workflow-created",
        payload: {
          projectId: command.projectId,
          workflow: {
            id: command.workflowId,
            projectId: command.projectId,
            title: command.title,
            slug: command.slug,
            requirementPrompt: command.requirementPrompt,
            plansDirectory: command.plansDirectory,
            selfReviewEnabled: command.selfReviewEnabled,
            branchA: {
              branchId: "a",
              authorSlot: command.branchA,
              authorThreadId: command.authorThreadIdA,
              planFilePath: null,
              planTurnId: null,
              revisionTurnId: null,
              reviews: [],
              status: "pending",
              error: null,
              errorStage: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: command.createdAt,
            },
            branchB: {
              branchId: "b",
              authorSlot: command.branchB,
              authorThreadId: command.authorThreadIdB,
              planFilePath: null,
              planTurnId: null,
              revisionTurnId: null,
              reviews: [],
              status: "pending",
              error: null,
              errorStage: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: command.createdAt,
            },
            merge: {
              mergeSlot: command.merge,
              threadId: null,
              outputFilePath: null,
              turnId: null,
              approvedPlanId: null,
              status: "not_started",
              error: null,
              updatedAt: command.createdAt,
            },
            implementation: null,
            totalCostUsd: 0,
            maxCostUsd: command.maxCostUsd ?? null,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
            archivedAt: null,
            deletedAt: null,
          },
        },
      };
    }

    case "project.workflow.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const workflow = readModel.planningWorkflows.find(
        (entry) => entry.id === command.workflowId && entry.projectId === command.projectId,
      );
      if (!workflow || workflow.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow '${command.workflowId}' does not exist.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.workflow-deleted",
        payload: {
          projectId: command.projectId,
          workflowId: command.workflowId,
          deletedAt: command.createdAt,
        },
      };
    }

    case "project.code-review-workflow.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const existing = readModel.codeReviewWorkflows.find(
        (entry) => entry.id === command.workflowId && entry.deletedAt === null,
      );
      if (existing) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Code review workflow '${command.workflowId}' already exists.`,
        });
      }
      const duplicateSlug = readModel.codeReviewWorkflows.find(
        (entry) =>
          entry.projectId === command.projectId &&
          entry.slug === command.slug &&
          entry.deletedAt === null,
      );
      if (duplicateSlug) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Code review workflow slug '${command.slug}' already exists in project '${command.projectId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.code-review-workflow-created",
        payload: {
          projectId: command.projectId,
          workflow: {
            id: command.workflowId,
            projectId: command.projectId,
            title: command.title,
            slug: command.slug,
            reviewPrompt: command.reviewPrompt,
            branch: command.branch,
            reviewerA: {
              label: `Reviewer A (${command.reviewerA.provider}:${command.reviewerA.model})`,
              slot: command.reviewerA,
              threadId: command.reviewerThreadIdA,
              status: "pending",
              pinnedTurnId: null,
              pinnedAssistantMessageId: null,
              error: null,
              updatedAt: command.createdAt,
            },
            reviewerB: {
              label: `Reviewer B (${command.reviewerB.provider}:${command.reviewerB.model})`,
              slot: command.reviewerB,
              threadId: command.reviewerThreadIdB,
              status: "pending",
              pinnedTurnId: null,
              pinnedAssistantMessageId: null,
              error: null,
              updatedAt: command.createdAt,
            },
            consolidation: {
              slot: command.consolidation,
              threadId: null,
              status: "not_started",
              pinnedTurnId: null,
              pinnedAssistantMessageId: null,
              error: null,
              updatedAt: command.createdAt,
            },
            totalCostUsd: 0,
            maxCostUsd: command.maxCostUsd ?? null,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
            archivedAt: null,
            deletedAt: null,
          },
        },
      };
    }

    case "project.investigation-workflow.create":
    case "project.debug-workflow.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (
        command.investigatorA.provider === command.investigatorB.provider &&
        command.investigatorA.model === command.investigatorB.model
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Investigation investigator models must be different.",
        });
      }
      const existing = readModel.investigationWorkflows.find(
        (entry) => entry.id === command.workflowId && entry.deletedAt === null,
      );
      if (existing) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Investigation workflow '${command.workflowId}' already exists.`,
        });
      }
      const duplicateSlug = readModel.investigationWorkflows.find(
        (entry) =>
          entry.projectId === command.projectId &&
          entry.slug === command.slug &&
          entry.deletedAt === null,
      );
      if (duplicateSlug) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Investigation workflow slug '${command.slug}' already exists in project '${command.projectId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.investigation-workflow-created",
        payload: {
          projectId: command.projectId,
          workflow: {
            id: command.workflowId,
            projectId: command.projectId,
            title: command.title,
            slug: command.slug,
            problemPrompt: command.problemPrompt,
            branch: command.branch,
            selfReviewEnabled: command.selfReviewEnabled,
            investigatorA: {
              label: `Investigator A (${command.investigatorA.provider}:${command.investigatorA.model})`,
              slot: command.investigatorA,
              investigationThreadId: command.investigationThreadIdA,
              investigationStatus: "pending",
              investigationTurnId: null,
              investigationMessageId: null,
              crossReviewThreadId: null,
              crossReviewStatus: "not_started",
              crossReviewTurnId: null,
              crossReviewMessageId: null,
              selfReviewThreadId: null,
              selfReviewStatus: "not_started",
              selfReviewTurnId: null,
              selfReviewMessageId: null,
              error: null,
              updatedAt: command.createdAt,
            },
            investigatorB: {
              label: `Investigator B (${command.investigatorB.provider}:${command.investigatorB.model})`,
              slot: command.investigatorB,
              investigationThreadId: command.investigationThreadIdB,
              investigationStatus: "pending",
              investigationTurnId: null,
              investigationMessageId: null,
              crossReviewThreadId: null,
              crossReviewStatus: "not_started",
              crossReviewTurnId: null,
              crossReviewMessageId: null,
              selfReviewThreadId: null,
              selfReviewStatus: "not_started",
              selfReviewTurnId: null,
              selfReviewMessageId: null,
              error: null,
              updatedAt: command.createdAt,
            },
            synthesis: {
              slot: command.synthesis,
              threadId: null,
              status: "not_started",
              pinnedTurnId: null,
              pinnedAssistantMessageId: null,
              error: null,
              updatedAt: command.createdAt,
            },
            totalCostUsd: 0,
            maxCostUsd: command.maxCostUsd ?? null,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
            archivedAt: null,
            deletedAt: null,
          },
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          titleSource: "default",
          titleRevision: 0,
          titleUpdatedAt: command.createdAt,
          model: command.model,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          threadReferences: command.threadReferences ?? [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        command.expectedArchivedAt !== undefined &&
        thread.archivedAt !== command.expectedArchivedAt
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' archive state changed before deletion.`,
        });
      }
      if (
        command.expectedWorktreePath !== undefined &&
        thread.worktreePath !== command.expectedWorktreePath
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' worktree path changed before deletion.`,
        });
      }
      const occurredAt = nowIso();
      const pinRevision = thread.pinnedAt != null ? (readModel.pinRevision ?? 0) + 1 : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
          ...(pinRevision !== undefined ? { pinRevision } : {}),
        },
      };
    }

    case "thread.archive": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const pinRevision = thread.pinnedAt != null ? (readModel.pinRevision ?? 0) + 1 : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: command.createdAt,
          ...(pinRevision !== undefined ? { pinRevision } : {}),
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          unarchivedAt: command.createdAt,
        },
      };
    }

    case "thread.pins.replace": {
      const anchorThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (anchorThread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Deleted thread '${command.threadId}' cannot anchor a pin update.`,
        });
      }
      const currentRevision = readModel.pinRevision ?? 0;
      if (command.expectedRevision !== currentRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Pinned thread order changed (expected revision ${command.expectedRevision}, current revision ${currentRevision}).`,
        });
      }
      const uniqueIds = new Set(command.pinnedThreadIds);
      if (uniqueIds.size !== command.pinnedThreadIds.length) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Pinned thread order contains duplicate thread IDs.",
        });
      }
      for (const threadId of command.pinnedThreadIds) {
        const thread = yield* requireThread({ readModel, command, threadId });
        if (thread.archivedAt !== null || thread.deletedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Archived or deleted thread '${threadId}' cannot be pinned.`,
          });
        }
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: GLOBAL_PIN_AGGREGATE_ID,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.pins-replaced",
        payload: {
          threadId: command.threadId,
          pinnedThreadIds: command.pinnedThreadIds,
          pinRevision: currentRevision + 1,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.pins.import-legacy": {
      const anchorThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (anchorThread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Deleted thread '${command.threadId}' cannot anchor a legacy pin import.`,
        });
      }
      const currentRevision = readModel.pinRevision ?? 0;
      if (command.expectedRevision !== currentRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Pinned thread order changed (expected revision ${command.expectedRevision}, current revision ${currentRevision}).`,
        });
      }

      const currentPinnedThreadIds = readModel.threads
        .filter(
          (thread) =>
            thread.pinnedAt != null &&
            thread.pinOrderKey != null &&
            thread.archivedAt === null &&
            thread.deletedAt === null,
        )
        .toSorted(
          (left, right) =>
            (left.pinOrderKey ?? Number.MAX_SAFE_INTEGER) -
              (right.pinOrderKey ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
        )
        .slice(0, MAX_PINNED_THREADS)
        .map((thread) => thread.id);
      const nextPinnedThreadIds = [...currentPinnedThreadIds];
      const acceptedThreadIds: ThreadId[] = [];
      const overflowedThreadIds: ThreadId[] = [];
      const unknownThreadIds: ThreadId[] = [];
      const seenLegacyIds = new Set<ThreadId>();

      for (const threadId of command.legacyThreadIds) {
        if (seenLegacyIds.has(threadId)) continue;
        seenLegacyIds.add(threadId);
        const thread = readModel.threads.find((entry) => entry.id === threadId);
        if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
          unknownThreadIds.push(threadId);
          continue;
        }
        if (nextPinnedThreadIds.includes(threadId)) {
          acceptedThreadIds.push(threadId);
          continue;
        }
        if (nextPinnedThreadIds.length >= MAX_PINNED_THREADS) {
          overflowedThreadIds.push(threadId);
          continue;
        }
        nextPinnedThreadIds.push(threadId);
        acceptedThreadIds.push(threadId);
      }

      const changed =
        nextPinnedThreadIds.length !== currentPinnedThreadIds.length ||
        nextPinnedThreadIds.some((threadId, index) => threadId !== currentPinnedThreadIds[index]);
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: GLOBAL_PIN_AGGREGATE_ID,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.legacy-pins-imported",
        payload: {
          threadId: command.threadId,
          pinnedThreadIds: nextPinnedThreadIds,
          pinRevision: changed ? currentRevision + 1 : currentRevision,
          acceptedThreadIds,
          overflowedThreadIds,
          unknownThreadIds,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Deleted thread '${command.threadId}' cannot be snoozed.`,
        });
      }
      const snoozedUntilMs = Date.parse(command.until);
      const snoozedAtMs = Date.parse(command.createdAt);
      if (
        !Number.isFinite(snoozedUntilMs) ||
        !Number.isFinite(snoozedAtMs) ||
        snoozedUntilMs <= snoozedAtMs
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A snooze must end after it starts.",
        });
      }
      const pinRevision = thread.pinnedAt != null ? (readModel.pinRevision ?? 0) + 1 : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.until,
          snoozedAt: command.createdAt,
          ...(pinRevision !== undefined ? { pinRevision } : {}),
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (
        command.expectedSnoozedUntil !== undefined &&
        thread.snoozedUntil !== command.expectedSnoozedUntil
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' snooze changed before wake-up.`,
        });
      }
      return makeThreadUnsnoozedEvent({
        commandId: command.commandId,
        threadId: command.threadId,
        occurredAt: command.createdAt,
      });
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        command.expectedArchivedAt !== undefined &&
        thread.archivedAt !== command.expectedArchivedAt
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' archive state changed before metadata update.`,
        });
      }
      if (command.expectedBranch !== undefined && thread.branch !== command.expectedBranch) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' branch changed before metadata update.`,
        });
      }
      if (
        command.expectedWorktreePath !== undefined &&
        thread.worktreePath !== command.expectedWorktreePath
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' worktree path changed before metadata update.`,
        });
      }
      const occurredAt = nowIso();
      if (command.regenerateTitle === true) {
        if (thread.archivedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Archived thread '${command.threadId}' cannot regenerate its title.`,
          });
        }
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.title-regeneration-started",
          payload: {
            threadId: command.threadId,
            titleRegeneration: {
              requestId: command.commandId,
              startedAt: occurredAt,
            },
            expectedTitleRevision: thread.titleRevision ?? 0,
            origin: "explicit",
          },
        };
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined
            ? {
                title: command.title,
                titleSource: "manual" as const,
                titleRevision: (thread.titleRevision ?? 0) + 1,
                titleUpdatedAt: occurredAt,
                titleRegeneration: null,
              }
            : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.title.generation.start": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        thread.archivedAt !== null ||
        thread.titleSource !== "default" ||
        (thread.titleRevision ?? 0) !== command.expectedTitleRevision
      ) {
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.title-regeneration-discarded",
          payload: {
            threadId: command.threadId,
            requestId: command.commandId,
            reason: "The automatic title request was superseded before it started.",
            discardedAt: command.createdAt,
          },
        };
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.title-regeneration-started",
        payload: {
          threadId: command.threadId,
          titleRegeneration: {
            requestId: command.commandId,
            startedAt: command.createdAt,
          },
          expectedTitleRevision: command.expectedTitleRevision,
          origin: "first-turn",
          ...(command.titleSourceText !== undefined
            ? { titleSourceText: command.titleSourceText }
            : {}),
          ...(command.titleGenerationModel !== undefined
            ? { titleGenerationModel: command.titleGenerationModel }
            : {}),
          ...(command.titleGenerationModelSelection !== undefined
            ? { titleGenerationModelSelection: command.titleGenerationModelSelection }
            : {}),
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const isCurrent =
        thread.archivedAt === null &&
        thread.titleRegeneration?.requestId === command.requestId &&
        (thread.titleRevision ?? 0) === command.expectedTitleRevision;
      if (!isCurrent) {
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.title-regeneration-discarded",
          payload: {
            threadId: command.threadId,
            requestId: command.requestId,
            reason: "A newer title change superseded this generated result.",
            discardedAt: command.createdAt,
          },
        };
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.title-regenerated",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          title: command.title,
          titleSource: "generated",
          titleRevision: (thread.titleRevision ?? 0) + 1,
          titleUpdatedAt: command.createdAt,
        },
      };
    }

    case "thread.title.regeneration.fail": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const isCurrent =
        thread.titleRegeneration?.requestId === command.requestId &&
        (thread.titleRevision ?? 0) === command.expectedTitleRevision;
      if (!isCurrent) {
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.title-regeneration-discarded",
          payload: {
            threadId: command.threadId,
            requestId: command.requestId,
            reason: "A newer title change superseded this failed request.",
            discardedAt: command.createdAt,
          },
        };
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.title-regeneration-failed",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          reason: command.reason,
          failedAt: command.createdAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const threadIsBusy =
        targetThread.latestTurn?.state === "running" ||
        targetThread.session?.status === "starting" ||
        targetThread.session?.status === "running" ||
        targetThread.session?.activeTurnId != null;
      if (threadIsBusy && command.dispatchSource === "next-turn-queue") {
        return yield* new ThreadTurnAlreadyActiveError({
          threadId: command.threadId,
          activeTurnId: targetThread.session?.activeTurnId ?? null,
          sessionStatus: targetThread.session?.status ?? null,
        });
      }
      if (threadIsBusy) {
        yield* Effect.logWarning("turn start on a busy thread", {
          threadId: command.threadId,
          commandId: command.commandId,
          activeTurnId: targetThread.session?.activeTurnId ?? null,
          sessionStatus: targetThread.session?.status ?? null,
        });
      }
      const queueSourced = command.dispatchSource === "next-turn-queue";
      const effectiveRuntimeMode = queueSourced ? command.runtimeMode : targetThread.runtimeMode;
      const effectiveInteractionMode = queueSourced
        ? command.interactionMode
        : targetThread.interactionMode;
      const settingEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.snoozedUntil != null && !queueSourced) {
        settingEvents.push(
          makeThreadUnsnoozedEvent({
            commandId: command.commandId,
            threadId: command.threadId,
            occurredAt: command.createdAt,
          }),
        );
      }
      if (queueSourced && effectiveRuntimeMode !== targetThread.runtimeMode) {
        settingEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.runtime-mode-set",
          payload: {
            threadId: command.threadId,
            runtimeMode: effectiveRuntimeMode,
            updatedAt: command.createdAt,
          },
        });
      }
      if (queueSourced && effectiveInteractionMode !== targetThread.interactionMode) {
        settingEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.interaction-mode-set",
          payload: {
            threadId: command.threadId,
            interactionMode: effectiveInteractionMode,
            updatedAt: command.createdAt,
          },
        });
      }
      const modelSelectionChanged =
        command.modelSelection !== undefined &&
        JSON.stringify(command.modelSelection) !== JSON.stringify(targetThread.modelSelection);
      if (
        queueSourced &&
        ((command.model !== undefined && command.model !== targetThread.model) ||
          modelSelectionChanged)
      ) {
        settingEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.meta-updated",
          payload: {
            threadId: command.threadId,
            ...(command.model !== undefined ? { model: command.model } : {}),
            ...(command.modelSelection !== undefined
              ? { modelSelection: command.modelSelection }
              : {}),
            updatedAt: command.createdAt,
          },
        });
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          ...(command.message.skillCall !== undefined
            ? { skillCall: command.message.skillCall }
            : {}),
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.provider !== undefined ? { provider: command.provider } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleGenerationModel !== undefined
            ? { titleGenerationModel: command.titleGenerationModel }
            : {}),
          ...(command.titleGenerationModelSelection !== undefined
            ? { titleGenerationModelSelection: command.titleGenerationModelSelection }
            : {}),
          ...(command.titleSourceText !== undefined
            ? { titleSourceText: command.titleSourceText }
            : {}),
          ...(command.modelOptions !== undefined ? { modelOptions: command.modelOptions } : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
          runtimeMode: effectiveRuntimeMode,
          interactionMode: effectiveInteractionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return [...settingEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
          ...(command.usageFact !== undefined ? { usageFact: command.usageFact } : {}),
        },
      };
    }

    case "thread.message.assistant.delta": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const thread = readModel.threads.find((entry) => entry.id === command.threadId);
      const existingMessage = thread?.messages.find((entry) => entry.id === command.messageId);
      if (existingMessage?.role === "assistant" && existingMessage.streaming === false) {
        // The message has already been marked complete (usually by snapshot
        // reconciliation). Drop the delta rather than reopen the message, but
        // log it so legitimate late deltas from a reconnected stream or an
        // out-of-order event remain observable in operator logs.
        yield* Effect.logWarning("decider dropped late assistant delta on completed message", {
          threadId: command.threadId,
          messageId: command.messageId,
          deltaLength: command.delta.length,
        });
        return [];
      }
      const messageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          ...(command.reasoningDelta && command.reasoningDelta.length > 0
            ? { reasoningText: command.reasoningDelta }
            : {}),
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const wakesSnoozedThread = targetThread.snoozedUntil != null && existingMessage === undefined;
      return wakesSnoozedThread
        ? [
            makeThreadUnsnoozedEvent({
              commandId: command.commandId,
              threadId: command.threadId,
              occurredAt: command.createdAt,
            }),
            messageEvent,
          ]
        : messageEvent;
    }

    case "thread.message.assistant.complete": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = targetThread.messages.find((entry) => entry.id === command.messageId);
      const messageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const wakesSnoozedThread = targetThread.snoozedUntil != null && existingMessage === undefined;
      return wakesSnoozedThread
        ? [
            makeThreadUnsnoozedEvent({
              commandId: command.commandId,
              threadId: command.threadId,
              occurredAt: command.createdAt,
            }),
            messageEvent,
          ]
        : messageEvent;
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.turn.processing.quiesce": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-processing-quiesced",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          processingQuiescedAt: command.processingQuiescedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      const wakesSnoozedThread =
        targetThread.snoozedUntil != null &&
        (command.activity.kind === "approval.requested" ||
          command.activity.kind === "user-input.requested");
      return wakesSnoozedThread
        ? [
            makeThreadUnsnoozedEvent({
              commandId: command.commandId,
              threadId: command.threadId,
              occurredAt: command.createdAt,
            }),
            activityEvent,
          ]
        : activityEvent;
    }

    case "thread.tasks.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      const taskValidationError = validateThreadTasks(command.tasks);
      if (taskValidationError) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: taskValidationError,
        });
      }

      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.tasks.updated",
        payload: {
          threadId: command.threadId,
          tasks: command.tasks,
          turnId: command.turnId ?? null,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.compact.request": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      const hasDirection = command.direction !== undefined;
      const hasPivotMessageId = command.pivotMessageId !== undefined;
      if (hasDirection !== hasPivotMessageId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Partial compaction requires both direction and pivotMessageId.",
        });
      }

      if (command.pivotMessageId !== undefined) {
        const pivotExists = thread.messages.some(
          (message) => message.id === command.pivotMessageId,
        );
        if (!pivotExists) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Pivot message '${command.pivotMessageId}' does not exist on thread '${command.threadId}'.`,
          });
        }
      }

      if (
        thread.session?.activeTurnId !== null &&
        thread.session?.activeTurnId !== undefined &&
        thread.session.status === "running"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Interrupt the current turn before compacting the conversation.",
        });
      }

      if (thread.session?.status === "starting") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Wait for the provider session to finish starting before compacting.",
        });
      }

      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.compact-requested",
        payload: {
          threadId: command.threadId,
          trigger: command.trigger,
          direction: command.direction ?? null,
          pivotMessageId: command.pivotMessageId ?? null,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.compacted.record": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.compacted",
        payload: {
          threadId: command.threadId,
          compaction: command.compaction,
        },
      };
    }

    case "thread.session-notes.record": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-notes-recorded",
        payload: {
          threadId: command.threadId,
          sessionNotes: command.sessionNotes,
        },
      };
    }

    case "thread.command-execution.record": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.command-execution-recorded",
        payload: {
          threadId: command.threadId,
          commandExecution: command.commandExecution,
        },
      };
    }

    case "thread.command-execution.output.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.command-execution-output-appended",
        payload: {
          threadId: command.threadId,
          commandExecutionId: command.commandExecutionId,
          chunk: command.chunk,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "thread.file-change.record": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.file-change-recorded",
        payload: {
          threadId: command.threadId,
          fileChange: command.fileChange,
        },
      };
    }

    case "project.workflow.upsert": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workflow.id === undefined || command.workflow.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow project id must match the enclosing project aggregate.",
        });
      }
      if (command.workflow.branchA.branchId !== "a" || command.workflow.branchB.branchId !== "b") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow branches must preserve branch ids 'a' and 'b'.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.workflow-upserted",
        payload: {
          projectId: command.projectId,
          workflow: command.workflow,
        },
      };
    }

    case "project.code-review-workflow.upsert": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workflow.id === undefined || command.workflow.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow project id must match the enclosing project aggregate.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "project.code-review-workflow-upserted",
        payload: {
          projectId: command.projectId,
          workflow: command.workflow,
        },
      };
    }

    case "project.code-review-workflow.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const workflow = readModel.codeReviewWorkflows.find(
        (entry) => entry.id === command.workflowId && entry.projectId === command.projectId,
      );
      if (!workflow || workflow.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Code review workflow '${command.workflowId}' does not exist.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.code-review-workflow-deleted",
        payload: {
          projectId: command.projectId,
          workflowId: command.workflowId,
          deletedAt: command.createdAt,
        },
      };
    }

    case "project.investigation-workflow.upsert":
    case "project.debug-workflow.upsert": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workflow.id === undefined || command.workflow.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow project id must match the enclosing project aggregate.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "project.investigation-workflow-upserted",
        payload: {
          projectId: command.projectId,
          workflow: command.workflow,
        },
      };
    }

    case "project.investigation-workflow.delete":
    case "project.debug-workflow.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const workflow = readModel.investigationWorkflows.find(
        (entry) => entry.id === command.workflowId && entry.projectId === command.projectId,
      );
      if (!workflow || workflow.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Investigation workflow '${command.workflowId}' does not exist.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.investigation-workflow-deleted",
        payload: {
          projectId: command.projectId,
          workflowId: command.workflowId,
          deletedAt: command.createdAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
