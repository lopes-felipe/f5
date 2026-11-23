import { ThreadId } from "@t3tools/contracts";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useRightPanelStore } from "../rightPanelStore";

const pending = new Map<string, Promise<ThreadId>>();
/** One explicit fork per click; keep a pending request shared across composer entry points. */
export function openNewSideChat(parentId: ThreadId): Promise<ThreadId> {
  const existing = pending.get(parentId);
  if (existing) return existing;
  const promise = (async () => {
    const parent = useStore.getState().threads.find((thread) => thread.id === parentId);
    const capabilities = parent?.session?.capabilities;
    if (!parent || parent.sideChatOf || !capabilities)
      throw new Error("Start a provider session in the main thread before opening a side chat.");
    const api = ensureNativeApi();
    if (!api.nativeOperations) throw new Error("Native forks are unavailable.");
    const operationId = crypto.randomUUID();
    const target = ThreadId.makeUnsafe("fork-" + operationId);
    const record = await api.nativeOperations.fork({
      threadId: parentId,
      operationId,
      generation: capabilities.generation,
      sideChat: true,
    });
    if (!["requested", "dispatched", "running", "completed"].includes(record.state))
      throw new Error(record.error ?? "The side chat could not be forked.");
    for (let attempt = 0; attempt < 600; attempt++) {
      const child = useStore.getState().threads.find((thread) => thread.id === target);
      if (child) {
        useRightPanelStore.getState().openSideChat(parentId, target, "Side chat");
        return target;
      }
      if (attempt % 4 === 0) {
        const records = await api.nativeOperations.list({ threadId: parentId });
        const operation = records.find((entry) => entry.operationId === operationId);
        if (
          operation &&
          !["requested", "dispatched", "running", "completed"].includes(operation.state)
        )
          throw new Error(operation.error ?? "The fork needs reconciliation in the main thread.");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      "The side chat is still being created. Its tab can be reopened from Add when it is ready.",
    );
  })();
  pending.set(parentId, promise);
  void promise
    .finally(() => {
      if (pending.get(parentId) === promise) pending.delete(parentId);
    })
    .catch(() => {});
  return promise;
}
