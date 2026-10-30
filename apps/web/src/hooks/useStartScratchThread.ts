import { useCallback, useRef } from "react";
import type { ProjectId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { useStore } from "../store";

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
  // Share only in-flight work. Project identity always comes from the current store.
  const pending = useRef<Promise<ProjectId> | null>(null);
  return useCallback(
    async (options?: CreateProjectBackedDraftThreadOptions) => {
      try {
        const existing = useStore.getState().projects.find(isScratchProject);
        if (!existing && !pending.current) {
          pending.current = (async () => {
            const { projectId } = await ensureNativeApi().projects.ensureScratch();
            await waitForProjectInStore(projectId);
            return projectId;
          })().finally(() => {
            pending.current = null;
          });
        }
        const projectId = existing?.id ?? (await pending.current!);
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
