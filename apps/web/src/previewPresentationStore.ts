import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export interface PreviewPresentation {
  readonly title: string;
  readonly url: string;
  readonly faviconDataUrl: string | null;
}

interface PreviewPresentationStoreState {
  readonly byThreadId: Record<string, PreviewPresentation | undefined>;
  readonly set: (threadId: ThreadId, presentation: PreviewPresentation) => void;
  readonly remove: (threadId: ThreadId) => void;
}

export const usePreviewPresentationStore = create<PreviewPresentationStoreState>()((set) => ({
  byThreadId: {},
  set: (threadId, presentation) =>
    set((state) => ({
      byThreadId: { ...state.byThreadId, [String(threadId)]: presentation },
    })),
  remove: (threadId) =>
    set((state) => {
      const key = String(threadId);
      if (!(key in state.byThreadId)) return state;
      const { [key]: _removed, ...byThreadId } = state.byThreadId;
      return { byThreadId };
    }),
}));
