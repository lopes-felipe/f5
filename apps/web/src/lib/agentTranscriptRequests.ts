/** Shared across hook mounts so settlement waits for an existing catch-up too. */
const requests = new Map<string, Promise<void>>();
export function forgetAgentTranscriptRequest(key: string): void {
  requests.delete(key);
}
export function runAgentTranscriptRequest(key: string, run: () => Promise<void>): Promise<void> {
  const existing = requests.get(key);
  if (existing) return existing;
  const pending = run().finally(() => {
    if (requests.get(key) === pending) requests.delete(key);
  });
  requests.set(key, pending);
  return pending;
}

/** Retry gaps begin after draining, and each retry waits for its predecessor. */
export function settleAgentTranscript(input: {
  drain: () => Promise<void>;
  refresh: () => Promise<void>;
  onSettled?: () => void;
}): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  void (async () => {
    await input.drain();
    if (cancelled) return;
    // drain may have joined a request that began before the agent settled.
    await input.refresh();
    for (const delay of [1000, 2000, 4000, 8000]) {
      if (cancelled) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, delay);
      });
      if (cancelled) return;
      await input.refresh();
    }
    if (!cancelled) input.onSettled?.();
  })();
  return () => {
    cancelled = true;
    clearTimeout(timer);
    wake?.();
  };
}
