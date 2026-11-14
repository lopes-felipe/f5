import { create } from "zustand";

interface HomeSelectionState {
  /** The selected queue item's id (`homeThreadItemId` / `homeWorkflowItemId`), or null. */
  selectedId: string | null;
  /**
   * The queue's item ids when the selection was last reconciled. When the selected item
   * has left the queue, its place in this list says which item followed it.
   */
  itemIds: ReadonlyArray<string>;
  setSelectedId: (selectedId: string | null) => void;
  /** Records the queue the selection now belongs to. */
  reconcile: (itemIds: ReadonlyArray<string>, selectedId: string | null) => void;
}

/**
 * Home's queue selection. It lives outside the component so opening a thread and coming
 * back lands on the same item, or on the one after it when that thread left the queue
 * meanwhile. It is not persisted across reloads.
 */
export const useHomeSelectionStore = create<HomeSelectionState>((set) => ({
  selectedId: null,
  itemIds: [],
  setSelectedId: (selectedId) =>
    set((state) => (state.selectedId === selectedId ? state : { selectedId })),
  reconcile: (itemIds, selectedId) =>
    set((state) =>
      state.itemIds === itemIds && state.selectedId === selectedId
        ? state
        : { itemIds, selectedId },
    ),
}));
