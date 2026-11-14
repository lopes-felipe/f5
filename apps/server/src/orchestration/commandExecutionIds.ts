import { OrchestrationCommandExecutionId, type ThreadId } from "@t3tools/contracts";

/** The command-execution projection row of a provider command item. */
export function commandExecutionIdForRuntimeItem(
  threadId: ThreadId,
  itemId: string,
): OrchestrationCommandExecutionId {
  return OrchestrationCommandExecutionId.makeUnsafe(`cmdexec:${threadId}:${itemId}`);
}
