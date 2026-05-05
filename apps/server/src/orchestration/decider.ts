import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
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

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
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
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
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
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: command.createdAt,
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

    case "thread.meta.update": {
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
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
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
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
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
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
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
      return {
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
    }

    case "thread.message.assistant.complete": {
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
      yield* requireThread({
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
      return {
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
