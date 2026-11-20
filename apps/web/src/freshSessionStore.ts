import { create } from "zustand";
import type { ThreadId } from "@t3tools/contracts";
export const useFreshSessionStore = create<{
  arms: Readonly<Record<string, string>>;
  arm: (threadId: ThreadId) => void;
  consume: (threadId: ThreadId, token: string) => void;
}>((set) => ({
  arms: {},
  arm: (threadId) => set((state) => ({ arms: { ...state.arms, [threadId]: crypto.randomUUID() } })),
  consume: (threadId, token) =>
    set((state) => {
      if (state.arms[threadId] !== token) return state;
      const { [threadId]: _removed, ...arms } = state.arms;
      return { arms };
    }),
}));
