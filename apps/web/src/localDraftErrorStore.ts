import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Errors for drafts the server does not know yet (the main store drops those).
 * Kept outside ChatView because a failed first send can rekey the draft, and
 * the route remounts ChatView for the new id: component state would lose the
 * error and with it any recovery action it offers.
 */
interface LocalDraftErrorStore {
  readonly errorsByThreadId: Readonly<Record<ThreadId, string>>;
  setError: (threadId: ThreadId, error: string | null) => void;
  reset: () => void;
}

export const useLocalDraftErrorStore = create<LocalDraftErrorStore>((set) => ({
  errorsByThreadId: {},
  setError: (threadId, error) =>
    set((state) => {
      if ((state.errorsByThreadId[threadId] ?? null) === error) return state;
      const next = { ...state.errorsByThreadId };
      if (error === null) delete next[threadId];
      else next[threadId] = error;
      return { errorsByThreadId: next };
    }),
  reset: () => set({ errorsByThreadId: {} }),
}));
