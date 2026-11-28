import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect } from "react";
import { useWorktreeRemovalDialogStore } from "../worktreeRemovalDialogStore";

const WorktreeRemovalDialog = lazy(() =>
  import("./WorktreeRemovalDialog").then((module) => ({ default: module.WorktreeRemovalDialog })),
);

/** Load the inspection/removal UI only when a request is queued. */
export function WorktreeRemovalDialogHost() {
  const request = useWorktreeRemovalDialogStore((state) => state.requests[0]);
  const close = useWorktreeRemovalDialogStore((state) => state.close);
  const silentRemovals = useWorktreeRemovalDialogStore((state) => state.silentRemovals);
  const queryClient = useQueryClient();
  // Worktrees removed without the dialog change the same lists the dialog refreshes.
  useEffect(() => {
    if (silentRemovals === 0) return;
    void queryClient.invalidateQueries({ queryKey: ["git"] });
    void queryClient.invalidateQueries({ queryKey: ["worktrees"] });
  }, [queryClient, silentRemovals]);
  return request ? (
    <Suspense fallback={null}>
      <WorktreeRemovalDialog key={request.id} rows={request.rows} onClose={close} />
    </Suspense>
  ) : null;
}
