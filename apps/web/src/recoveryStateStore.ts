import { create } from "zustand";

interface RecoveryStateStore {
  recoveryEpoch: number;
  lastCompletedAt: string | null;
  markRecoveryComplete: () => void;
}

export const useRecoveryStateStore = create<RecoveryStateStore>((set) => ({
  recoveryEpoch: 0,
  lastCompletedAt: null,
  markRecoveryComplete: () =>
    set((state) => ({
      recoveryEpoch: state.recoveryEpoch + 1,
      lastCompletedAt: new Date().toISOString(),
    })),
}));
