import {
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { type PromptStashDraftSelection, useComposerDraftStore } from "~/composerDraftStore";
import { resolvePromptStashSelection } from "~/components/chat/promptStash.logic";
import { toastManager } from "~/components/ui/toast";
import { shortcutLabelForCommand } from "~/keybindings";
import { readNativeApi } from "~/nativeApi";
import type { Project, Thread } from "~/types";

export function usePromptStashController(input: {
  readonly activeThread: Thread | null | undefined;
  readonly activeProject: Project | null | undefined;
  readonly disabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelOptionsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<{ readonly slug: string }>
  >;
  readonly fallbackSelection: PromptStashDraftSelection;
  readonly onStashed: () => void;
  readonly onRestored: (prompt: string) => void;
}) {
  const {
    activeProject,
    activeThread,
    disabled,
    fallbackSelection,
    keybindings,
    modelOptionsByInstance,
    onRestored,
    onStashed,
    providers,
  } = input;
  const stashes = useComposerDraftStore((state) => state.promptStashes);
  const stashPromptDraft = useComposerDraftStore((state) => state.stashPromptDraft);
  const restorePromptStash = useComposerDraftStore((state) => state.restorePromptStash);
  const deletePromptStash = useComposerDraftStore((state) => state.deletePromptStash);
  const shortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "composer.stash"),
    [keybindings],
  );
  const modelSlugsByInstance = useMemo(
    () =>
      new Map(
        [...modelOptionsByInstance].map(([instanceId, options]) => [
          instanceId,
          new Set(options.map((option) => option.slug)),
        ]),
      ),
    [modelOptionsByInstance],
  );

  const stash = useCallback(async () => {
    if (!activeThread || !activeProject || disabled) return;
    const result = await stashPromptDraft({
      threadId: activeThread.id,
      projectId: activeProject.id,
      workspaceRoot: activeThread.worktreePath ?? activeProject.cwd,
    });
    if (result.status === "stored") {
      onStashed();
      toastManager.add({ type: "success", title: "Prompt stashed" });
      return;
    }
    toastManager.add({
      type: result.status === "failed" ? "error" : "warning",
      title: result.status === "failed" ? "Failed to stash prompt" : "Prompt not stashed",
      description: result.message,
    });
  }, [activeProject, activeThread, disabled, onStashed, stashPromptDraft]);

  const restore = useCallback(
    async (stashId: string) => {
      if (!activeThread || !activeProject || disabled) return;
      const selectedStash = stashes.find((entry) => entry.id === stashId);
      if (!selectedStash) return;
      const resolvedSelection = resolvePromptStashSelection({
        stash: selectedStash,
        providers,
        modelSlugsByInstance,
        fallback: fallbackSelection,
      });
      let replaceNonEmpty = false;
      let dropInvalidTerminalContexts = false;
      for (;;) {
        const result = await restorePromptStash({
          stashId,
          threadId: activeThread.id,
          projectId: activeProject.id,
          workspaceRoots: [activeThread.worktreePath, activeProject.cwd],
          normalizeAbsolutePathForComparison:
            window.desktopBridge?.resolveRealPath ?? ((pathValue) => pathValue),
          selection: resolvedSelection.selection,
          replaceNonEmpty,
          dropInvalidTerminalContexts,
          warnings: resolvedSelection.warnings,
        });
        if (result.status === "needs-replace-confirmation") {
          const confirmed = await readNativeApi()?.dialogs.confirm(
            `${result.message}\n\nThe saved prompt will remain available.`,
          );
          if (!confirmed) return;
          replaceNonEmpty = true;
          continue;
        }
        if (result.status === "needs-terminal-confirmation") {
          const confirmed = await readNativeApi()?.dialogs.confirm(
            `${result.message}\n\nRestore without ${result.invalidTerminalContextCount} terminal context${result.invalidTerminalContextCount === 1 ? "" : "s"}?`,
          );
          if (!confirmed) return;
          dropInvalidTerminalContexts = true;
          continue;
        }
        if (result.status === "restored") {
          const restoredPrompt =
            useComposerDraftStore.getState().draftsByThreadId[activeThread.id]?.prompt ?? "";
          onRestored(restoredPrompt);
          toastManager.add({
            type: result.warnings.length > 0 ? "warning" : "success",
            title: "Prompt restored",
            ...(result.warnings.length > 0 ? { description: result.warnings.join(" ") } : {}),
          });
          return;
        }
        toastManager.add({
          type: result.status === "failed" ? "error" : "warning",
          title: result.status === "failed" ? "Failed to restore prompt" : "Prompt unavailable",
          description: result.message,
        });
        return;
      }
    },
    [
      activeProject,
      activeThread,
      disabled,
      fallbackSelection,
      modelSlugsByInstance,
      onRestored,
      providers,
      restorePromptStash,
      stashes,
    ],
  );

  const remove = useCallback(
    (stashId: string) => {
      deletePromptStash(stashId);
      toastManager.add({ type: "success", title: "Saved prompt deleted" });
    },
    [deletePromptStash],
  );

  return { remove, restore, shortcutLabel, stash, stashes } as const;
}
