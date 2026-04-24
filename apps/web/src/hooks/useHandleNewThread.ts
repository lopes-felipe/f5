import { type ProjectId, ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import {
  seedDraftThreadFromModelPreferences,
  useCreateProjectBackedDraftThread,
} from "./useCreateProjectBackedDraftThread";
import { useStore } from "../store";

export { seedDraftThreadFromModelPreferences };

export function useHandleNewThread() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const createProjectBackedDraftThread = useCreateProjectBackedDraftThread();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );

  const activeThread = routeThreadId
    ? threads.find((thread) => thread.id === routeThreadId)
    : undefined;

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => createProjectBackedDraftThread(projectId, options).then(() => undefined),
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
