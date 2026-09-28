import { MAX_PINNED_THREADS, type ThreadId } from "@t3tools/contracts";
import { dispatchThreadArchive } from "./archiveActions";
import { isSnoozedThread } from "./lib/threadOrdering";
import { useStore } from "./store";
import { orderedPinnedThreadIds, replacePinnedThreads, snoozeThread } from "./threadPinSnooze";
import { recordThreadUndo } from "./threadUndo";

export async function applyBulkThreadAction(
  ids: readonly ThreadId[],
  action: "pin" | "unpin" | "archive" | "snooze",
  until?: string,
) {
  const selected = new Set(ids);
  const state = useStore.getState();
  const threads = state.threads.filter((thread) => selected.has(thread.id));
  if (action === "pin" || action === "unpin") {
    const current = orderedPinnedThreadIds(state.threads);
    const eligible = threads
      .filter((thread) => thread.archivedAt === null && !isSnoozedThread(thread))
      .map((thread) => thread.id);
    const next =
      action === "unpin"
        ? current.filter((id) => !selected.has(id))
        : [...new Set([...current, ...eligible])];
    if (next.length > MAX_PINNED_THREADS)
      throw new Error(
        `You can pin at most ${MAX_PINNED_THREADS} threads. Unpin some threads first.`,
      );
    const anchorThreadId = threads[0]?.id;
    if (anchorThreadId && next.join() !== current.join()) {
      await replacePinnedThreads({
        anchorThreadId,
        pinnedThreadIds: next,
        expectedRevision: state.pinRevision ?? 0,
      });
      if (action === "unpin")
        recordThreadUndo("Threads unpinned", async () => {
          const live = useStore.getState();
          const restored = [...orderedPinnedThreadIds(live.threads)];
          const existing = new Set(
            live.threads
              .filter((thread) => thread.archivedAt === null && !isSnoozedThread(thread))
              .map((thread) => thread.id),
          );
          for (const [index, id] of current.entries()) {
            if (selected.has(id) && existing.has(id) && !restored.includes(id))
              restored.splice(Math.min(index, restored.length), 0, id);
          }
          if (restored.length > MAX_PINNED_THREADS)
            throw new Error("Unpin other threads before restoring these pins.");
          await replacePinnedThreads({
            anchorThreadId,
            pinnedThreadIds: restored,
            expectedRevision: live.pinRevision ?? 0,
          });
        });
    }
    return {
      succeeded: action === "pin" ? eligible : threads.map((thread) => thread.id),
      failures:
        action === "pin"
          ? ids
              .filter((id) => !eligible.includes(id))
              .map((id) => ({
                id,
                error: new Error("Archived, snoozed, or unavailable threads cannot be pinned."),
              }))
          : [],
    };
  }
  const succeeded: ThreadId[] = [];
  const failures: { id: ThreadId; error: unknown }[] = [];
  for (const thread of threads) {
    try {
      if (action === "snooze") {
        if (!until) throw new Error("Choose when to wake these threads.");
        await snoozeThread(thread.id, until);
      } else {
        await dispatchThreadArchive({ threadId: thread.id, archived: true });
      }
      succeeded.push(thread.id);
    } catch (error) {
      failures.push({ id: thread.id, error });
    }
  }
  return { succeeded, failures };
}
