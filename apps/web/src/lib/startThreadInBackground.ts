import type {
  AssistantDeliveryMode,
  ClientThreadTurnStartCommand,
  ModelSelection,
  ProviderInteractionMode,
  ProviderKind,
  ProviderModelOptions,
  ProviderStartOptions,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import { buildFirstSendBootstrap } from "../components/ChatView.logic";
import { readNativeApi } from "../nativeApi";
import { useNextTurnQueueStore } from "../nextTurnQueueStore";
import type { Project } from "../types";
import { createUnconfirmedSubmissions } from "./unconfirmedSubmission";
import { newCommandId, newMessageId, newThreadId } from "./utils";

/** A first message and everything the new thread starts with. */
export interface BackgroundThreadStartInput {
  readonly project: Pick<Project, "id" | "cwd" | "model" | "scripts">;
  readonly text: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly modelSelection: ModelSelection;
  readonly modelOptions?: ProviderModelOptions | undefined;
  readonly providerOptions?: ProviderStartOptions | undefined;
  readonly titleGenerationModel: string;
  readonly titleGenerationModelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly assistantDeliveryMode: AssistantDeliveryMode;
  /** The branch a new worktree starts from; null runs the thread in the project folder. */
  readonly worktreeBaseBranch: string | null;
}

export interface BackgroundThreadStartResult {
  readonly threadId: ThreadId;
  /** `queued` while the server prepares the worktree; the turn starts by itself after. */
  readonly outcome: "started" | "queued";
}

/**
 * The same first-send command the thread composer builds for a new draft with text only:
 * the thread is created inside the submission, so a rejected send leaves nothing behind.
 */
export function buildBackgroundThreadStartCommand(
  input: BackgroundThreadStartInput,
): ClientThreadTurnStartCommand {
  const createdAt = new Date().toISOString();
  const bootstrap = buildFirstSendBootstrap({
    isLocalDraftThread: true,
    projectId: input.project.id,
    projectCwd: input.project.cwd,
    projectModel: input.project.model,
    projectScripts: [...input.project.scripts],
    selectedModel: input.model,
    selectedModelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    thread: { branch: input.worktreeBaseBranch, worktreePath: null, createdAt },
    baseBranchForWorktree: input.worktreeBaseBranch,
  });
  return {
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: newThreadId(),
    message: {
      messageId: newMessageId(),
      role: "user",
      text: input.text,
      attachments: [],
    },
    model: input.model,
    modelSelection: input.modelSelection,
    titleGenerationModel: input.titleGenerationModel,
    titleGenerationModelSelection: input.titleGenerationModelSelection,
    titleSourceText: input.text,
    ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    provider: input.provider,
    assistantDeliveryMode: input.assistantDeliveryMode,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    ...(bootstrap ? { bootstrap } : {}),
    createdAt,
  };
}

function attemptKey(input: BackgroundThreadStartInput): string {
  return JSON.stringify([
    input.project.id,
    input.text,
    input.provider,
    input.model,
    input.modelSelection,
    input.modelOptions ?? null,
    input.providerOptions ?? null,
    input.runtimeMode,
    input.interactionMode,
    input.worktreeBaseBranch,
  ]);
}

/**
 * The start whose outcome is not known. Until the server answers, it may have started the
 * thread: a timeout or a dropped connection says nothing either way. Sending the same
 * message with the same settings again resends this exact command, thread id included,
 * which the server replays instead of starting a second agent on the same task. It is
 * kept without a time limit, until the server answers or something else is sent.
 */
const unconfirmedStarts = createUnconfirmedSubmissions<ClientThreadTurnStartCommand>();
const HOME_START_SLOT = "home";

export function resetBackgroundThreadStartForTests(): void {
  unconfirmedStarts.clear();
}

/**
 * Starts a thread with its first message without opening it, through the same durable
 * admission as the thread composer. Rejects when the server did not take the message.
 */
export async function startThreadInBackground(
  input: BackgroundThreadStartInput,
): Promise<BackgroundThreadStartResult> {
  const api = readNativeApi();
  if (!api) throw new Error("F5 is not connected.");
  const { command, result: submission } = await unconfirmedStarts.submit({
    slot: HOME_START_SLOT,
    signature: attemptKey(input),
    build: () => buildBackgroundThreadStartCommand(input),
    send: (toSend) =>
      api.nextTurnQueue.submit({
        submissionId: toSend.commandId,
        command: toSend,
        intent: "auto",
      }),
  });
  if (
    submission.disposition === "canceled" ||
    submission.disposition === "cleared" ||
    submission.disposition === "rejected"
  ) {
    throw new Error(submission.detail ?? "The thread was not started.");
  }
  if (submission.disposition === "queued") {
    useNextTurnQueueStore.getState().applySnapshot(submission.snapshot);
  }
  return {
    threadId: command.threadId,
    outcome: submission.disposition === "queued" ? "queued" : "started",
  };
}
