import type { ThreadId } from "@t3tools/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { toastManager } from "../components/ui/toast";
import { useStore } from "../store";

/** Remove a local new-thread draft and retain its contents for the undo notice. */
export function discardComposerDraft(threadId: ThreadId): boolean {
  const store = useComposerDraftStore.getState();
  const thread = store.getDraftThread(threadId);
  if (
    !thread ||
    thread.promoting ||
    (store.imageImportsByThreadId[threadId]?.pendingCount ?? 0) > 0 ||
    useStore.getState().threads.some(({ id }) => id === threadId)
  ) {
    return false;
  }
  const draft = store.draftsByThreadId[threadId];
  const projectKeys = Object.keys(store.projectDraftThreadIdByProjectId).filter(
    (key) => store.projectDraftThreadIdByProjectId[key] === threadId,
  );
  store.clearThreadDraft(threadId);
  toastManager.add({
    title: "Draft discarded",
    type: "info",
    data: {
      actions: [
        {
          label: "Undo",
          onClick: () => {
            const current = useComposerDraftStore.getState();
            if (
              current.getDraftThread(threadId) ||
              current.draftsByThreadId[threadId] ||
              useStore.getState().threads.some(({ id }) => id === threadId)
            ) {
              toastManager.add({ type: "error", title: "Could not restore draft" });
              return;
            }
            const projectMappings = { ...current.projectDraftThreadIdByProjectId };
            for (const key of projectKeys) projectMappings[key] ??= threadId;
            useComposerDraftStore.setState({
              draftThreadsByThreadId: { ...current.draftThreadsByThreadId, [threadId]: thread },
              projectDraftThreadIdByProjectId: projectMappings,
              ...(draft
                ? {
                    draftsByThreadId: {
                      ...current.draftsByThreadId,
                      [threadId]: {
                        ...draft,
                        images: draft.images.map((image) =>
                          image.previewUrl.startsWith("blob:")
                            ? { ...image, previewUrl: URL.createObjectURL(image.file) }
                            : image,
                        ),
                      },
                    },
                  }
                : {}),
            });
          },
        },
      ],
    },
  });
  return true;
}
