import type { WebContents } from "electron";

type WakeTarget = Pick<
  WebContents,
  "getBackgroundThrottling" | "setBackgroundThrottling" | "isDestroyed"
>;

const wakeLeases = new WeakMap<WakeTarget, { count: number; restoreThrottling: boolean }>();

export function acquirePreviewWake(guest: WakeTarget): () => void {
  let entry = wakeLeases.get(guest);
  if (!entry) {
    const restoreThrottling = guest.getBackgroundThrottling();
    if (restoreThrottling) guest.setBackgroundThrottling(false);
    entry = { count: 0, restoreThrottling };
    wakeLeases.set(guest, entry);
  }
  entry.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.count !== 0) return;
    wakeLeases.delete(guest);
    if (entry.restoreThrottling && !guest.isDestroyed()) guest.setBackgroundThrottling(true);
  };
}

export async function withPreviewWake<T>(guest: WakeTarget, run: () => Promise<T>): Promise<T> {
  const release = acquirePreviewWake(guest);
  try {
    return await run();
  } finally {
    release();
  }
}
