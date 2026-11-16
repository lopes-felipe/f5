import type { OrchestrationEvent, ProjectId, ThreadId } from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { projectQueryKeys } from "./projectQueryKeys";
import { providerQueryKeys } from "./providerQueryKeys";
import { isWorkspaceWatchReliable } from "./workspaceWatch";

/**
 * Query refreshes after an agent turn changed files. They are scoped to the
 * thread's workspace (and to the changed files when the turn diff lists them);
 * unknown workspaces fall back to refreshing every workspace query.
 */

export interface ThreadWorkspace {
  readonly cwd: string;
  readonly projectId: ProjectId;
}

type WorkspaceEffectEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-diff-completed" | "thread.reverted" }
>;

export function isWorkspaceEffectEvent(event: OrchestrationEvent): event is WorkspaceEffectEvent {
  return event.type === "thread.turn-diff-completed" || event.type === "thread.reverted";
}

/** Every workspace and provider query; for unknown effects and recovery gaps. */
export function invalidateAllWorkspaceQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
  void queryClient.invalidateQueries({ queryKey: providerQueryKeys.fileContentAll });
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
}

function invalidateWorkspaceListings(queryClient: QueryClient, workspace: ThreadWorkspace): void {
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.listDirectories(workspace.cwd) });
  void queryClient.invalidateQueries({ queryKey: ["projects", "list-entries", workspace.cwd] });
  void queryClient.invalidateQueries({ queryKey: ["projects", "search-entries", workspace.cwd] });
  void queryClient.invalidateQueries({
    queryKey: ["projects", "search-contents", workspace.projectId],
  });
  void queryClient.invalidateQueries({
    queryKey: ["projects", workspace.projectId, "checked-in-config"],
  });
}

/**
 * Refreshes what one turn-diff or revert event can have changed. Returns
 * "broad" when the workspace was unknown and everything was refreshed.
 */
export function invalidateWorkspaceForEvent(
  queryClient: QueryClient,
  event: WorkspaceEffectEvent,
  resolveWorkspace: (threadId: ThreadId) => ThreadWorkspace | null,
): "narrow" | "broad" {
  const { threadId } = event.payload;
  const workspace = resolveWorkspace(threadId);
  if (!workspace) {
    invalidateAllWorkspaceQueries(queryClient);
    return "broad";
  }

  void queryClient.invalidateQueries({
    queryKey: providerQueryKeys.checkpointDiffPrefix(threadId),
  });

  const listedFiles =
    event.type === "thread.turn-diff-completed" && event.payload.status === "ready"
      ? event.payload.files
      : null;
  if (!listedFiles) {
    // Reverts and incomplete checkpoints do not say which files changed.
    void queryClient.invalidateQueries({
      queryKey: [...providerQueryKeys.fileContentAll, workspace.cwd],
    });
    invalidateWorkspaceListings(queryClient, workspace);
    return "narrow";
  }

  // Listings refresh for the whole workspace: diffs report added and deleted
  // files as modified, and only observed listings refetch right away.
  invalidateWorkspaceListings(queryClient, workspace);
  if (!isWorkspaceWatchReliable(workspace.cwd)) {
    // Commands can also touch untracked or ignored files the diff omits;
    // without a reliable watch, every open file in the workspace refreshes.
    void queryClient.invalidateQueries({
      queryKey: [...providerQueryKeys.fileContentAll, workspace.cwd],
    });
    return "narrow";
  }
  for (const file of listedFiles) {
    void queryClient.invalidateQueries({
      queryKey: providerQueryKeys.fileContent({ cwd: workspace.cwd, relativePath: file.path }),
    });
  }
  return "narrow";
}
