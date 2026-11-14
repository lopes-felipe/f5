import type { Thread } from "../types";

export function isThreadRunning(thread: Pick<Thread, "session" | "latestTurn">): boolean {
  return (
    thread.session?.orchestrationStatus === "starting" ||
    thread.session?.orchestrationStatus === "running" ||
    thread.latestTurn?.state === "running"
  );
}
