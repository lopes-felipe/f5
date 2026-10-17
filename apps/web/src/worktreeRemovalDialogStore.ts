import type { ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
export interface WorktreeRemovalRow {
  readonly projectId: ProjectId;
  readonly path: string;
}
interface Request {
  readonly id: number;
  readonly rows: ReadonlyArray<WorktreeRemovalRow>;
  readonly resolve: () => void;
}
interface Store {
  readonly requests: ReadonlyArray<Request>;
  request: (rows: ReadonlyArray<WorktreeRemovalRow>) => Promise<void>;
  close: () => void;
}
let sequence = 0;
export const useWorktreeRemovalDialogStore = create<Store>((set, get) => ({
  requests: [],
  request: (rows) =>
    rows.length === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          set((state) => ({ requests: [...state.requests, { id: ++sequence, rows, resolve }] }));
        }),
  close: () => {
    const [first, ...rest] = get().requests;
    set({ requests: rest });
    first?.resolve();
  },
}));
