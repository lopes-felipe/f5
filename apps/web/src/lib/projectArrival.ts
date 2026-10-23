import type { ProjectId } from "@t3tools/contracts";

import { useStore } from "../store";

const PROJECT_ARRIVAL_TIMEOUT_MS = 10_000;

/**
 * Resolves once a project the server just created has reached the store. Its creation event
 * can land after the reply that named it.
 */
export function waitForProjectInStore(projectId: ProjectId): Promise<void> {
  const present = () => useStore.getState().projects.some((project) => project.id === projectId);
  if (present()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("The new project did not load. Reload the window and try again."));
    }, PROJECT_ARRIVAL_TIMEOUT_MS);
    const unsubscribe = useStore.subscribe(() => {
      if (!present()) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}
