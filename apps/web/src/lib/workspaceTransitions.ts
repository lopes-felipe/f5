import { WsRequestError } from "../wsTransport";
import type { ThreadId, WorktreesSwitchWorkspaceInput } from "@t3tools/contracts";
import { ensureNativeApi } from "../nativeApi";
import { selectThreadById } from "../threadSelectors";
import { useStore } from "../store";

export async function switchConversationWorkspace(
  threadId: ThreadId,
  target: Pick<
    WorktreesSwitchWorkspaceInput,
    "intent" | "branch" | "targetPath" | "sharedFilesystemConfirmed"
  >,
) {
  const thread = selectThreadById(useStore.getState(), threadId);
  if (!thread) throw new Error("The conversation is unavailable.");
  const result = await ensureNativeApi().worktrees.switchWorkspace({
    operationId: crypto.randomUUID(),
    threadId,
    ...target,
    expected: {
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      sessionUpdatedAt: thread.session?.updatedAt ?? null,
    },
  });
  if (result.phase === "failed" && result.checkoutConflict)
    throw new WsRequestError(
      result.error ?? "Local changes block switching branches.",
      "GitCheckoutConflict",
      result.checkoutConflict,
    );
  if (result.phase !== "completed" && result.errorCode)
    throw new WsRequestError(result.error ?? "Create a new worktree instead.", result.errorCode);
  if (result.phase !== "completed")
    throw new Error(result.error ?? "Inspect and resolve the interrupted workspace switch.");
  return result;
}
