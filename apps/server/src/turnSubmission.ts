import {
  CommandId,
  MessageId,
  ThreadId,
  DEFAULT_NEW_THREAD_TITLE,
  type ClientThreadTurnStartCommand,
  type ModelSelection,
  type OrchestrationProject,
  type RuntimeMode,
  type ProviderKind,
  type ScheduledOrigin,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { setupProjectScript } from "@t3tools/shared/projectScripts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/worktree";

/** Pure builder shared by chat transports and scheduled admission. All identities are supplied before side effects. */
export function buildNewThreadSubmission(input: {
  project: OrchestrationProject;
  threadId: ThreadId;
  commandId: CommandId;
  messageId: MessageId;
  prompt: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  createdAt: string;
  provider?: ProviderKind;
  title?: string;
  interactionMode?: ProviderInteractionMode;
  branch: string | null;
  useWorktree: boolean;
  requireWorktree?: boolean;
  worktreeBranch?: string;
  scheduledOrigin?: typeof ScheduledOrigin.Type;
}): ClientThreadTurnStartCommand {
  const interactionMode = input.interactionMode ?? "default";
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.threadId,
    message: { messageId: input.messageId, role: "user", text: input.prompt, attachments: [] },
    ...(input.provider ? { provider: input.provider } : {}),
    model: input.modelSelection.model,
    modelSelection: input.modelSelection,
    titleSourceText: input.prompt,
    runtimeMode: input.runtimeMode,
    interactionMode,
    createdAt: input.createdAt,
    bootstrap: {
      createThread: {
        projectId: input.project.id,
        title: input.title ?? DEFAULT_NEW_THREAD_TITLE,
        model: input.modelSelection.model,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode,
        branch: input.branch,
        worktreePath: null,
        createdAt: input.createdAt,
        ...(input.scheduledOrigin ? { scheduledOrigin: input.scheduledOrigin } : {}),
      },
      ...(input.useWorktree && input.branch !== null
        ? {
            prepareWorktree: {
              projectCwd: input.project.workspaceRoot,
              baseBranch: input.branch,
              branch: input.worktreeBranch ?? buildTemporaryWorktreeBranchName(),
              ...(input.requireWorktree ? { requireWorktree: true } : {}),
            },
            ...(setupProjectScript(input.project.scripts) ? { runSetupScript: true } : {}),
          }
        : {}),
    },
  };
}
