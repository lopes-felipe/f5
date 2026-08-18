import { useEffect, useRef } from "react";

import { clearLegacyPinnedThreads, getPinnedThreadIds } from "../pinnedThreadsStore";
import { useStore } from "../store";
import { importLegacyPinnedThreads, orderedPinnedThreadIds } from "../threadPinSnooze";
import { toastManager } from "./ui/toast";

export function LegacyPinnedThreadsMigrationController() {
  const threads = useStore((state) => state.threads);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const pinRevision = useStore((state) => state.pinRevision ?? 0);
  const attemptedImport = useRef<string | null>(null);

  useEffect(() => {
    if (!threadsHydrated) return;
    const legacyIds = getPinnedThreadIds();
    if (legacyIds.length === 0) return;

    const signature = `${pinRevision}:${legacyIds.join(",")}`;
    if (attemptedImport.current === signature) return;
    attemptedImport.current = signature;

    const activeIds = new Set(
      threads.filter((thread) => thread.archivedAt === null).map((thread) => thread.id),
    );
    const serverIds = orderedPinnedThreadIds(threads);
    const anchorThreadId = serverIds[0] ?? legacyIds.find((threadId) => activeIds.has(threadId));
    if (anchorThreadId === undefined) {
      clearLegacyPinnedThreads();
      return;
    }
    void importLegacyPinnedThreads({
      anchorThreadId,
      legacyThreadIds: legacyIds,
      expectedRevision: pinRevision,
    })
      .then(() => clearLegacyPinnedThreads())
      .catch((error) => {
        // Retain the local pins. A later snapshot or reload retries the import.
        toastManager.add({
          type: "error",
          title: "Could not import pinned threads",
          description: error instanceof Error ? error.message : "The server rejected the import.",
        });
      });
  }, [pinRevision, threads, threadsHydrated]);

  return null;
}
