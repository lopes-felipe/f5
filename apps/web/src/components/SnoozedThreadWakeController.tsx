import { useParams } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { isSnoozedThread } from "../lib/threadOrdering";
import { useStore } from "../store";
import { wakeThread } from "../threadPinSnooze";

export function SnoozedThreadWakeController() {
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const threads = useStore((state) => state.threads);
  const thread = useMemo(
    () => (routeThreadId ? threads.find((entry) => entry.id === routeThreadId) : undefined),
    [routeThreadId, threads],
  );
  const snoozedThreads = useMemo(
    () => threads.filter((entry) => entry.snoozedUntil != null),
    [threads],
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

  useEffect(() => {
    const deadlines = snoozedThreads.flatMap((entry) => {
      const deadline = Date.parse(entry.snoozedUntil ?? "");
      return Number.isFinite(deadline) ? [{ thread: entry, deadline }] : [];
    });
    if (deadlines.length === 0) return;
    const nextDeadline = Math.min(...deadlines.map((entry) => entry.deadline));
    let timer: number | null = null;
    const schedule = () => {
      const remaining = nextDeadline - Date.now();
      timer = window.setTimeout(
        () => {
          if (remaining > 2_147_000_000) {
            schedule();
            return;
          }
          const now = Date.now();
          for (const entry of deadlines) {
            if (entry.deadline <= now) void wakeThread(entry.thread).catch(() => undefined);
          }
        },
        Math.min(2_147_000_000, Math.max(0, remaining)),
      );
    };
    schedule();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [snoozedThreads]);

  return null;
}
