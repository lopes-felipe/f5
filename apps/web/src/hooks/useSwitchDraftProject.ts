import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import {
  threadAttachmentWorkspaceRoots,
  threadWorkspaceCwd,
} from "@t3tools/shared/threadWorkspace";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import type { ProjectPickerSelection } from "../components/ProjectPicker";
import { toastManager } from "../components/ui/toast";
import {
  type PromptStashDraftSelection,
  hasSendableComposerDraftContent,
  useComposerDraftStore,
} from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { useStore } from "../store";
import type { Project } from "../types";
import {
  type CreateProjectBackedDraftThreadOptions,
  type CreateProjectBackedDraftThreadResult,
} from "./useCreateProjectBackedDraftThread";
import { useCreateProjectBackedDraftThread } from "./useCreateProjectBackedDraftThread";
import { useStartScratchThread } from "./useStartScratchThread";

export type SwitchDraftProjectOutcome = "unchanged" | "moved" | "stashed" | "failed";

export interface SwitchDraftProjectDeps {
  readonly createDraftThread: (
    projectId: ProjectId,
    options: CreateProjectBackedDraftThreadOptions,
  ) => Promise<CreateProjectBackedDraftThreadResult | null>;
  readonly startScratchThread: (
    options: CreateProjectBackedDraftThreadOptions,
  ) => Promise<CreateProjectBackedDraftThreadResult | null>;
  readonly navigateToThread: (threadId: ThreadId) => Promise<void>;
}

const projectById = (projectId: ProjectId): Project | undefined =>
  useStore.getState().projects.find((project) => project.id === projectId);

const projectLabel = (project: Project | undefined): string =>
  isScratchProject(project) ? "No project" : (project?.name ?? "the selected project");

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

/** Puts a stashed prompt back into the draft it came from after a failed move. */
async function returnStashToSource(stashId: string, sourceThreadId: ThreadId): Promise<void> {
  const store = useComposerDraftStore.getState();
  const sourceDraftThread = store.getDraftThread(sourceThreadId);
  if (!sourceDraftThread) return;
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
  if (result.status === "restored") useComposerDraftStore.getState().deletePromptStash(stashId);
}

/**
 * Moves an unsent draft to another project: its composer content goes through
 * the prompt stash into the target project's draft (created or reused), which
 * keeps the target's model defaults and drops paths outside its workspace.
 */
export async function switchDraftProject(
  sourceThreadId: ThreadId,
  target: ProjectPickerSelection,
  deps: SwitchDraftProjectDeps,
): Promise<SwitchDraftProjectOutcome> {
  const store = useComposerDraftStore.getState();
  const sourceDraftThread = store.getDraftThread(sourceThreadId);
  if (!sourceDraftThread) return "unchanged";
  const sourceProject = projectById(sourceDraftThread.projectId);
  const alreadyThere =
    target.kind === "none"
      ? isScratchProject(sourceProject)
      : target.projectId === sourceDraftThread.projectId;
  if (alreadyThere) return "unchanged";

  let stashId: string | null = null;
  const sourceDraft = store.draftsByThreadId[sourceThreadId];
  if (sourceDraft && hasSendableComposerDraftContent(sourceDraft)) {
    const stashed = await store.stashPromptDraft({
      threadId: sourceThreadId,
      projectId: sourceDraftThread.projectId,
      workspaceRoot: threadWorkspaceCwd(sourceDraftThread, sourceProject) ?? null,
    });
    if (stashed.status !== "stored") {
      toastManager.add({
        type: "error",
        title: "Could not change project",
        description: stashed.message,
      });
      return "failed";
    }
    stashId = stashed.stash.id;
  }

  const fail = async (description: string): Promise<SwitchDraftProjectOutcome> => {
    if (stashId) await returnStashToSource(stashId, sourceThreadId);
    toastManager.add({ type: "error", title: "Could not change project", description });
    return "failed";
  };

  let created: CreateProjectBackedDraftThreadResult | null;
  try {
    const options = { canNavigate: () => false };
    created =
      target.kind === "none"
        ? await deps.startScratchThread(options)
        : await deps.createDraftThread(target.projectId, options);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "An unexpected error occurred.");
  }
  if (!created) return fail("The project is no longer available.");
  if (created.threadId === sourceThreadId) return "unchanged";

  const targetProject = projectById(created.projectId);
  let outcome: SwitchDraftProjectOutcome = "moved";
  if (stashId) {
    const targetDraftThread = useComposerDraftStore.getState().getDraftThread(created.threadId);
    const restored = await useComposerDraftStore.getState().restorePromptStash({
      stashId,
      threadId: created.threadId,
      projectId: created.projectId,
      workspaceRoots: threadAttachmentWorkspaceRoots(
        { worktreePath: targetDraftThread?.worktreePath ?? null },
        targetProject,
      ),
      normalizeAbsolutePathForComparison,
      selection: targetSelection(created.threadId),
      dropInvalidTerminalContexts: true,
    });
    if (restored.status === "restored") {
      useComposerDraftStore.getState().deletePromptStash(stashId);
      // Re-authorizing paths for the new project is expected here; only report losses.
      const warnings = restored.warnings.filter((warning) => !warning.includes("re-authorized"));
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
      return fail(restored.message);
    }
  }

  requestComposerFocus(created.threadId);
  await deps.navigateToThread(created.threadId);
  // Clear after leaving the route so the source view never renders a missing draft.
  const after = useComposerDraftStore.getState();
  after.clearThreadDraft(sourceThreadId);
  after.clearDraftThread(sourceThreadId);
  return outcome;
}

export function useSwitchDraftProject() {
  const navigate = useNavigate();
  const createDraftThread = useCreateProjectBackedDraftThread();
  const startScratchThread = useStartScratchThread();
  const inFlight = useRef(false);
  return useCallback(
    async (
      sourceThreadId: ThreadId,
      target: ProjectPickerSelection,
    ): Promise<SwitchDraftProjectOutcome> => {
      if (inFlight.current) return "unchanged";
      inFlight.current = true;
      try {
        return await switchDraftProject(sourceThreadId, target, {
          createDraftThread,
          startScratchThread,
          navigateToThread: async (threadId) => {
            await navigate({ to: "/$threadId", params: { threadId } });
          },
        });
      } finally {
        inFlight.current = false;
      }
    },
    [createDraftThread, navigate, startScratchThread],
  );
}
