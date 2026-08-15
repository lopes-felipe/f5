import { create } from "zustand";

interface CommandPaletteOpenIntent {
  kind: "add-project";
  requestId: number;
}

export type CommandPaletteSurfaceMode = "command" | "files" | "content";

interface CommandPaletteStore {
  open: boolean;
  mode: CommandPaletteSurfaceMode;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  toggleMode: (mode: CommandPaletteSurfaceMode) => void;
  setMode: (mode: CommandPaletteSurfaceMode) => void;
  openAddProject: () => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  mode: "command",
  openIntent: null,
  setOpen: (open) => set({ open, ...(open ? {} : { mode: "command", openIntent: null }) }),
  toggleOpen: () =>
    set((state) => ({
      open: !state.open,
      mode: "command",
      ...(state.open ? { openIntent: null } : {}),
    })),
  toggleMode: (mode) =>
    set((state) =>
      state.open && state.mode === mode
        ? { open: false, mode: "command", openIntent: null }
        : { open: true, mode, openIntent: null },
    ),
  setMode: (mode) => set({ mode }),
  openAddProject: () =>
    set((state) => ({
      open: true,
      mode: "command",
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));
