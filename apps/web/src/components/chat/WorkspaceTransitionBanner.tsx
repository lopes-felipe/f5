import type { ThreadId, WorkspaceTransitionSnapshot } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ensureNativeApi } from "../../nativeApi";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import {
  describeWorkspaceSwitch,
  workspaceSwitchIsRunning,
} from "./WorkspaceTransitionBanner.logic";

/** One line for a switch that is running; nothing once it has ended. */
export function WorkspaceTransitionSummary({
  transition,
}: {
  transition: WorkspaceTransitionSnapshot;
}) {
  if (!workspaceSwitchIsRunning(transition)) return null;
  return <p className="text-xs">{describeWorkspaceSwitch(transition)}</p>;
}

/**
 * Shown only while a workspace switch runs. A switch that fails, is cancelled
 * or is cut off settles itself on the server: its caller gets the reason and the
 * timeline gets a note, so there is nothing to inspect or resolve here.
 */
export function WorkspaceTransitionBanner({ threadId }: { threadId: ThreadId }) {
  const revision = useNextTurnQueueStore((state) => state.byThreadId[threadId]?.snapshot?.revision);
  const transition = useQuery({
    queryKey: ["worktrees", "transition", threadId, revision],
    queryFn: () => ensureNativeApi().worktrees.getTransition({ threadId }),
    staleTime: 0,
  });
  const pushed = useNextTurnQueueStore(
    (state) => state.byThreadId[threadId]?.snapshot?.workspaceTransition,
  );
  const record =
    pushed && (!transition.data || pushed.updatedAt >= transition.data.updatedAt)
      ? pushed
      : transition.data;
  if (!workspaceSwitchIsRunning(record)) return null;
  return (
    <div role="status" className="rounded border p-3 text-sm text-muted-foreground">
      {describeWorkspaceSwitch(record)} Messages wait until it finishes.
    </div>
  );
}
