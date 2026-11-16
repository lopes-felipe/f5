import { type ProjectId, ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  seedDraftThreadFromModelPreferences,
  useCreateProjectBackedDraftThread,
} from "./useCreateProjectBackedDraftThread";
import { useStore } from "../store";
import { useThreadSummary } from "../threadSelectors";

export { seedDraftThreadFromModelPreferences };

export function useHandleNewThread() {
  const projects = useStore((store) => store.projects);
  const createProjectBackedDraftThread = useCreateProjectBackedDraftThread();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );

  const activeThread = useThreadSummary(routeThreadId);

  const handleNewThread = useCallback(
    (projectId: ProjectId, options?: Parameters<typeof createProjectBackedDraftThread>[1]) =>
      createProjectBackedDraftThread(projectId, options),
    [createProjectBackedDraftThread],
  );

  return {
    activeDraftThread,
    activeThread,
    handleNewThread,
    projects,
    routeThreadId,
  };
}
