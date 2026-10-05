import { create } from "zustand";

interface ShortcutsDialogStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
}

export const useShortcutsDialogStore = create<ShortcutsDialogStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((state) => ({ open: !state.open })),
}));
