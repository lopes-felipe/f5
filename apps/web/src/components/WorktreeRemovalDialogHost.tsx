import { lazy, Suspense } from "react";
import { useWorktreeRemovalDialogStore } from "../worktreeRemovalDialogStore";

const WorktreeRemovalDialog = lazy(() =>
  import("./WorktreeRemovalDialog").then((module) => ({ default: module.WorktreeRemovalDialog })),
);

/** Load the inspection/removal UI only when a request is queued. */
export function WorktreeRemovalDialogHost() {
  const request = useWorktreeRemovalDialogStore((state) => state.requests[0]);
  const close = useWorktreeRemovalDialogStore((state) => state.close);
  return request ? (
    <Suspense fallback={null}>
      <WorktreeRemovalDialog key={request.id} rows={request.rows} onClose={close} />
    </Suspense>
  ) : null;
}
