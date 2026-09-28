import { useMemo } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { useComposerThreadDraft, useComposerDraftStore } from "~/composerDraftStore";
import { deriveComposerSendState } from "~/components/ChatView.logic";

/** Thread-scoped draft subscriptions and actions; persistence stays in the draft store. */
export function useComposerDraft(threadId: ThreadId) {
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerFilePaths = composerDraft.filePaths;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        filePathCount: composerFilePaths.length,
        terminalContexts: composerTerminalContexts,
      }),
    [composerFilePaths.length, composerImages.length, composerTerminalContexts, prompt],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftFilePaths = useComposerDraftStore((store) => store.setFilePaths);
  const setComposerDraftProvider = useComposerDraftStore((store) => store.setProvider);
  const setComposerDraftProviderInstance = useComposerDraftStore(
    (store) => store.setProviderInstance,
  );
  const setComposerDraftModel = useComposerDraftStore((store) => store.setModel);
  const setComposerDraftModelOptions = useComposerDraftStore((store) => store.setModelOptions);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const importComposerDraftImages = useComposerDraftStore((store) => store.importImages);
  const pendingComposerImageImportCount = useComposerDraftStore(
    (store) => store.imageImportsByThreadId[threadId]?.pendingCount ?? 0,
  );
  const addComposerDraftFilePaths = useComposerDraftStore((store) => store.addFilePaths);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const removeComposerDraftFilePath = useComposerDraftStore((store) => store.removeFilePath);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  return {
    composerDraft,
    prompt,
    composerImages,
    composerFilePaths,
    composerTerminalContexts,
    composerSendState,
    nonPersistedComposerImageIds,
    setComposerDraftPrompt,
    setComposerDraftFilePaths,
    setComposerDraftProvider,
    setComposerDraftProviderInstance,
    setComposerDraftModel,
    setComposerDraftModelOptions,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    addComposerDraftImages,
    importComposerDraftImages,
    pendingComposerImageImportCount,
    addComposerDraftFilePaths,
    removeComposerDraftImage,
    removeComposerDraftFilePath,
    insertComposerDraftTerminalContext,
    removeComposerDraftTerminalContext,
    setComposerDraftTerminalContexts,
    clearComposerDraftPersistedAttachments,
    syncComposerDraftPersistedAttachments,
    clearComposerDraftContent,
    setDraftThreadContext,
    getDraftThreadByProjectId,
    getDraftThread,
    setProjectDraftThreadId,
    draftThread,
  };
}
