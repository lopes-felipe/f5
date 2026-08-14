import { useParams } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { isSnoozedThread } from "../lib/threadOrdering";
import { useStore } from "../store";
import { wakeThread } from "../threadPinSnooze";

export function SnoozedThreadWakeController() {
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const thread = useStore((state) =>
    routeThreadId ? state.threads.find((entry) => entry.id === routeThreadId) : undefined,
  );
  const attemptedSnooze = useRef<string | null>(null);

  useEffect(() => {
    if (!thread || !isSnoozedThread(thread) || thread.snoozedUntil == null) return;
    const signature = `${thread.id}:${thread.snoozedUntil}`;
    if (attemptedSnooze.current === signature) return;
    attemptedSnooze.current = signature;
    void wakeThread(thread).catch(() => {
      attemptedSnooze.current = null;
    });
  }, [thread]);

  return null;
}
