import { type ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

interface WorkflowCreateDialogStore {
  projectId: ProjectId | null;
  /**
   * Id of the most recently created workflow. The dialog lives in the chat
   * route; the sidebar subscribes to expand the new workflow's thread list.
   */
  lastCreatedWorkflowId: string | null;
  open: (projectId: ProjectId) => void;
  close: () => void;
  notifyCreated: (workflowId: string) => void;
}

export const useWorkflowCreateDialogStore = create<WorkflowCreateDialogStore>((set) => ({
  projectId: null,
  lastCreatedWorkflowId: null,
  open: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
  notifyCreated: (workflowId) => set({ lastCreatedWorkflowId: workflowId }),
}));
