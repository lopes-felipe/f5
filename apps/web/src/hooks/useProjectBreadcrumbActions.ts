import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { toastManager } from "~/components/ui/toast";
import type { Project, Thread } from "~/types";

import { useCreateProjectBackedDraftThread } from "./useCreateProjectBackedDraftThread";

export function useProjectBreadcrumbActions(input: {
  readonly project: Project | null | undefined;
  readonly thread: Thread | null | undefined;
}) {
  const createProjectBackedDraftThread = useCreateProjectBackedDraftThread();
  const navigate = useNavigate();

  const createThread = useCallback(() => {
    if (!input.project || !input.thread) return;
    void createProjectBackedDraftThread(input.project.id, {
      branch: input.thread.branch,
      worktreePath: input.thread.worktreePath,
    }).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Could not create thread",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    });
  }, [createProjectBackedDraftThread, input.project, input.thread]);

  const openSettings = useCallback(() => {
    if (!input.project) return;
    void navigate({
      to: "/settings",
      search: { category: "projects", projectId: input.project.id },
    });
  }, [input.project, navigate]);

  return { createThread, openSettings } as const;
}
