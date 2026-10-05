import { type ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

interface WorkflowCreateDialogStore {
  projectId: ProjectId | null;
  /**
   * Id of the most recently created workflow, until the sidebar consumes it.
   * The dialog lives in the chat route; the sidebar expands the new
   * workflow's thread list once and then clears this, so a later remount does
   * not re-expand a workflow the user has since collapsed.
   */
  lastCreatedWorkflowId: string | null;
  open: (projectId: ProjectId) => void;
  close: () => void;
  notifyCreated: (workflowId: string) => void;
  clearCreated: (workflowId: string) => void;
}

export const useWorkflowCreateDialogStore = create<WorkflowCreateDialogStore>((set) => ({
  projectId: null,
  lastCreatedWorkflowId: null,
  open: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
  notifyCreated: (workflowId) => set({ lastCreatedWorkflowId: workflowId }),
  clearCreated: (workflowId) =>
    set((state) =>
      state.lastCreatedWorkflowId === workflowId ? { lastCreatedWorkflowId: null } : state,
    ),
}));
