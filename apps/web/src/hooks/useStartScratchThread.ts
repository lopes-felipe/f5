import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { waitForProjectInStore } from "../lib/projectArrival";
import { ensureNativeApi } from "../nativeApi";
import {
  type CreateProjectBackedDraftThreadOptions,
  useCreateProjectBackedDraftThread,
} from "./useCreateProjectBackedDraftThread";

/**
 * Opens a new thread without a project. The server owns the scratch project; it is created on
 * first use, and the thread's own folder is allocated when its first message is sent.
 */
export function useStartScratchThread() {
  const createDraftThread = useCreateProjectBackedDraftThread();
  return useCallback(
    async (options?: CreateProjectBackedDraftThreadOptions) => {
      try {
        const { projectId } = await ensureNativeApi().projects.ensureScratch();
        await waitForProjectInStore(projectId);
        return await createDraftThread(projectId, options);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not start a thread without a project",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
        return null;
      }
    },
    [createDraftThread],
  );
}
