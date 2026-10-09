/** Persist a native task's opaque run identity without changing legacy task IDs. */
export function nativeTaskWorkItemId(taskId: string, runId?: string): string {
  return runId ? `${taskId}::run:${encodeURIComponent(runId)}` : taskId;
}

/** Decode a persisted task row for native inspection/cancellation. */
export function readNativeTaskIdentity(workItemId: string): { taskId: string; runId?: string } {
  const identity = workItemId.replace(/^subagent:/, "");
  const boundary = identity.indexOf("::run:");
  if (boundary < 0) return { taskId: identity };
  try {
    return {
      taskId: identity.slice(0, boundary),
      runId: decodeURIComponent(identity.slice(boundary + 6)),
    };
  } catch {
    // Leave malformed stored identities uninterpreted; native ownership checks
    // refuse them instead of accidentally targeting the latest task run.
    return { taskId: identity };
  }
}
