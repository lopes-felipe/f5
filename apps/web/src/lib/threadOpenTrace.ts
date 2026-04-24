import type { ThreadId } from "@t3tools/contracts";

type ThreadOpenTraceContext = Record<string, unknown>;

interface ThreadOpenTrace {
  readonly startedAtMs: number;
  readonly source: string;
}

const threadOpenTraces = new Map<ThreadId, ThreadOpenTrace>();

function isThreadOpenTraceEnabled(): boolean {
  return import.meta.env.DEV;
}

function elapsedSince(trace: ThreadOpenTrace): number {
  return Math.round(performance.now() - trace.startedAtMs);
}

export function startThreadOpenTrace(
  threadId: ThreadId,
  source: string,
  context?: ThreadOpenTraceContext,
): void {
  if (!isThreadOpenTraceEnabled()) {
    return;
  }

  threadOpenTraces.set(threadId, {
    startedAtMs: performance.now(),
    source,
  });
  console.info("thread open trace started", {
    threadId,
    source,
    ...context,
  });
}

export function ensureThreadOpenTrace(
  threadId: ThreadId,
  source: string,
  context?: ThreadOpenTraceContext,
): void {
  if (threadOpenTraces.has(threadId)) {
    return;
  }
  startThreadOpenTrace(threadId, source, context);
}

export function noteThreadOpenTraceStep(
  threadId: ThreadId,
  step: string,
  context?: ThreadOpenTraceContext,
): void {
  if (!isThreadOpenTraceEnabled()) {
    return;
  }

  const trace = threadOpenTraces.get(threadId);
  if (!trace) {
    return;
  }

  console.info("thread open trace", {
    threadId,
    source: trace.source,
    step,
    elapsedMs: elapsedSince(trace),
    ...context,
  });
}

export function finishThreadOpenTrace(
  threadId: ThreadId,
  outcome: string,
  context?: ThreadOpenTraceContext,
): void {
  if (!isThreadOpenTraceEnabled()) {
    return;
  }

  const trace = threadOpenTraces.get(threadId);
  if (!trace) {
    return;
  }

  console.info("thread open trace finished", {
    threadId,
    source: trace.source,
    outcome,
    elapsedMs: elapsedSince(trace),
    ...context,
  });
  threadOpenTraces.delete(threadId);
}
