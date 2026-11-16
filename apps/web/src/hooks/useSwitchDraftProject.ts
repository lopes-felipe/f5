import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import {
  threadAttachmentWorkspaceRoots,
  threadWorkspaceCwd,
} from "@t3tools/shared/threadWorkspace";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

import type { ProjectPickerSelection } from "../components/ProjectPicker";
import { toastManager } from "../components/ui/toast";
import {
  type PromptStashDraftSelection,
  hasSendableComposerDraftContent,
  useComposerDraftStore,
} from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { useStore } from "../store";
import { selectThreadById } from "../threadSelectors";
import type { Project } from "../types";
import {
  type CreateProjectBackedDraftThreadOptions,
  type CreateProjectBackedDraftThreadResult,
  useCreateProjectBackedDraftThread,
} from "./useCreateProjectBackedDraftThread";
import { useStartScratchThread } from "./useStartScratchThread";

export type SwitchDraftProjectOutcome = "unchanged" | "moved" | "stashed" | "failed";

export interface SwitchDraftProjectDeps {
  readonly createDraftThread: (
    projectId: ProjectId,
    options: CreateProjectBackedDraftThreadOptions,
  ) => Promise<CreateProjectBackedDraftThreadResult | null>;
  /** Shows its own error toast and resolves `null` when it fails. */
  readonly startScratchThread: (
    options: CreateProjectBackedDraftThreadOptions,
  ) => Promise<CreateProjectBackedDraftThreadResult | null>;
  /** Whether the user is still looking at this thread. */
  readonly isViewingThread: (threadId: ThreadId) => boolean;
  readonly navigateToThread: (threadId: ThreadId) => Promise<void>;
}

const FAILED_TITLE = "Could not change project";

const projectById = (projectId: ProjectId): Project | undefined =>
  useStore.getState().projects.find((project) => project.id === projectId);

const projectLabel = (project: Project | undefined): string =>
  isScratchProject(project) ? "No project" : (project?.name ?? "the selected project");

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The target draft's own model and modes, so its project's defaults survive the move. */
function targetSelection(threadId: ThreadId): PromptStashDraftSelection {
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  return {
    provider: draft?.provider ?? null,
    providerInstanceId: draft?.providerInstanceId ?? null,
    model: draft?.model ?? null,
    modelOptions: draft?.modelOptions ?? null,
    runtimeMode: draft?.runtimeMode ?? null,
    interactionMode: draft?.interactionMode ?? null,
    effort: draft?.effort ?? null,
    codexFastMode: draft?.codexFastMode ?? false,
  };
}

const normalizeAbsolutePathForComparison = (pathValue: string) =>
  (typeof window !== "undefined" ? window.desktopBridge?.resolveRealPath?.(pathValue) : null) ??
  pathValue;

const hasSendableContent = (threadId: ThreadId): boolean => {
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  return draft !== undefined && hasSendableComposerDraftContent(draft);
};

/** Still an unsent local draft: not removed and not promoted by a send. */
const isUnsentDraft = (threadId: ThreadId): boolean =>
  useComposerDraftStore.getState().getDraftThread(threadId) !== null &&
  selectThreadById(useStore.getState(), threadId) === undefined;

/** Drops a target draft the move opened but never filled. */
function discardEmptyDraft(threadId: ThreadId): void {
  if (hasSendableContent(threadId)) return;
  const store = useComposerDraftStore.getState();
  store.clearThreadDraft(threadId);
  store.clearDraftThread(threadId);
}

/**
 * Puts a stashed prompt back into the draft it came from after a failed move.
 * Returns false when it stays in the prompt stash (the source changed meanwhile).
 */
async function returnStashToSource(stashId: string, sourceThreadId: ThreadId): Promise<boolean> {
  const store = useComposerDraftStore.getState();
  const sourceDraftThread = store.getDraftThread(sourceThreadId);
  if (!sourceDraftThread) return false;
  const result = await store.restorePromptStash({
    stashId,
    threadId: sourceThreadId,
    projectId: sourceDraftThread.projectId,
    workspaceRoots: threadAttachmentWorkspaceRoots(
      sourceDraftThread,
      projectById(sourceDraftThread.projectId),
    ),
    normalizeAbsolutePathForComparison,
    dropInvalidTerminalContexts: true,
  });
  if (result.status !== "restored") return false;
  useComposerDraftStore.getState().deletePromptStash(stashId);
  return true;
}

/**
 * Mentions carry workspace-relative paths without a workspace identity, so in
 * another workspace they would resolve to a different file or block the send.
 * They stay in the prompt as plain text. Returns how many were converted.
 */
function demoteMentions(threadId: ThreadId): number {
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  if (!draft || draft.mentions.length === 0) return 0;
  useComposerDraftStore.getState().setPrompt(threadId, draft.prompt, []);
  return draft.mentions.length;
}

/**
 * Moves an unsent draft to another project. The target draft is opened (or
 * reused) first, while the source composer stays untouched; only then does the
 * composer content move through the prompt stash, which keeps the target's
 * model defaults and drops file paths outside its workspace.
 */
export async function switchDraftProject(
  sourceThreadId: ThreadId,
  target: ProjectPickerSelection,
  deps: SwitchDraftProjectDeps,
): Promise<SwitchDraftProjectOutcome> {
  const sourceDraftThread = useComposerDraftStore.getState().getDraftThread(sourceThreadId);
  if (!sourceDraftThread) return "unchanged";
  const sourceProject = projectById(sourceDraftThread.projectId);
  const alreadyThere =
    target.kind === "none"
      ? isScratchProject(sourceProject)
      : target.projectId === sourceDraftThread.projectId;
  if (alreadyThere) return "unchanged";

  // 1. Network: settings, env mode and, for No project, the scratch project.
  let created: CreateProjectBackedDraftThreadResult | null;
  try {
    const options = { canNavigate: () => false };
    created =
      target.kind === "none"
        ? await deps.startScratchThread(options)
        : await deps.createDraftThread(target.projectId, options);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: FAILED_TITLE,
      description: error instanceof Error ? error.message : "An unexpected error occurred.",
    });
    return "failed";
  }
  if (!created) {
    // The scratch path already explained its failure.
    if (target.kind === "project") {
      toastManager.add({
        type: "error",
        title: FAILED_TITLE,
        description: "The project is no longer available.",
      });
    }
    return "failed";
  }
  if (created.threadId === sourceThreadId) return "unchanged";
  const targetThreadId = created.threadId;
  if (!isUnsentDraft(sourceThreadId)) {
    // Sent or removed while the target was opening: there is nothing left to move.
    discardEmptyDraft(targetThreadId);
    return "unchanged";
  }

  // 2. Local move, with no network wait between emptying the source and filling the target.
  const targetProject = projectById(created.projectId);
  let outcome: SwitchDraftProjectOutcome = "moved";
  if (hasSendableContent(sourceThreadId)) {
    const stashed = await useComposerDraftStore.getState().stashPromptDraft({
      threadId: sourceThreadId,
      projectId: sourceDraftThread.projectId,
      workspaceRoot: threadWorkspaceCwd(sourceDraftThread, sourceProject) ?? null,
    });
    if (stashed.status !== "stored") {
      discardEmptyDraft(targetThreadId);
      toastManager.add({ type: "error", title: FAILED_TITLE, description: stashed.message });
      return "failed";
    }
    const stashId = stashed.stash.id;
    const targetDraftThread = useComposerDraftStore.getState().getDraftThread(targetThreadId);
    const restored = await useComposerDraftStore.getState().restorePromptStash({
      stashId,
      threadId: targetThreadId,
      projectId: created.projectId,
      workspaceRoots: threadAttachmentWorkspaceRoots(
        { worktreePath: targetDraftThread?.worktreePath ?? null },
        targetProject,
      ),
      normalizeAbsolutePathForComparison,
      selection: targetSelection(targetThreadId),
      dropInvalidTerminalContexts: true,
      omitReauthorizationWarning: true,
    });
    if (restored.status === "restored") {
      useComposerDraftStore.getState().deletePromptStash(stashId);
      const warnings = [...restored.warnings];
      const sourceWorkspace = threadWorkspaceCwd(sourceDraftThread, sourceProject);
      const targetWorkspace = threadWorkspaceCwd(targetDraftThread, targetProject);
      const demoted =
        sourceWorkspace === targetWorkspace && sourceWorkspace !== undefined
          ? 0
          : demoteMentions(targetThreadId);
      if (demoted > 0) {
        warnings.push(
          `${demoted} file ${plural(demoted, "mention was", "mentions were")} kept as plain text because ${plural(demoted, "it points", "they point")} into the previous project.`,
        );
      }
      if (warnings.length > 0) {
        toastManager.add({
          type: "warning",
          title: `Prompt moved to ${projectLabel(targetProject)}`,
          description: warnings.join(" "),
        });
      }
    } else if (restored.status === "needs-replace-confirmation") {
      outcome = "stashed";
      toastManager.add({
        type: "info",
        title: "Prompt saved to the prompt stash",
        description: `${projectLabel(targetProject)} already has a draft, so your prompt was saved to the prompt stash instead of replacing it.`,
      });
    } else {
      const returned = await returnStashToSource(stashId, sourceThreadId);
      discardEmptyDraft(targetThreadId);
      toastManager.add({
        type: "error",
        title: FAILED_TITLE,
        description: returned
          ? restored.message
          : `${restored.message} Your prompt was saved to the prompt stash.`,
      });
      return "failed";
    }
  }

  // 3. Follow the draft only if the user is still on it.
  if (deps.isViewingThread(sourceThreadId)) {
    requestComposerFocus(targetThreadId);
    await deps.navigateToThread(targetThreadId);
  } else {
    toastManager.add({
      type: "info",
      title: `Draft moved to ${projectLabel(targetProject)}`,
      actionProps: {
        children: "Open",
        onClick: () => {
          requestComposerFocus(targetThreadId);
          void deps.navigateToThread(targetThreadId);
        },
      },
    });
  }

  // 4. Drop the source unless something new was typed into it meanwhile.
  if (!hasSendableContent(sourceThreadId)) {
    const store = useComposerDraftStore.getState();
    store.clearThreadDraft(sourceThreadId);
    store.clearDraftThread(sourceThreadId);
  }
  return outcome;
}

/** Returns the switch action and whether one is running, so pickers can disable themselves. */
export function useSwitchDraftProject() {
  const navigate = useNavigate();
  const router = useRouter();
  const createDraftThread = useCreateProjectBackedDraftThread();
  const startScratchThread = useStartScratchThread();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const switchProject = useCallback(
    async (
      sourceThreadId: ThreadId,
      target: ProjectPickerSelection,
    ): Promise<SwitchDraftProjectOutcome> => {
      if (inFlight.current) return "unchanged";
      inFlight.current = true;
      setPending(true);
      try {
        return await switchDraftProject(sourceThreadId, target, {
          createDraftThread,
          startScratchThread,
          isViewingThread: (threadId) =>
            router.state.matches.some(
              (match) => (match.params as { threadId?: string }).threadId === threadId,
            ),
          navigateToThread: async (threadId) => {
            await navigate({ to: "/$threadId", params: { threadId } });
          },
        });
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [createDraftThread, navigate, router, startScratchThread],
  );
  return { switchProject, pending };
}
