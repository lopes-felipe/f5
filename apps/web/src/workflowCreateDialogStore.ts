import { type ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

interface WorkflowCreateDialogStore {
  projectId: ProjectId | null;
  open: (projectId: ProjectId) => void;
  close: () => void;
}

export const useWorkflowCreateDialogStore = create<WorkflowCreateDialogStore>((set) => ({
  projectId: null,
  open: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
}));
