import type { ProviderModelOptions, ThreadId } from "@t3tools/contracts";

/** The thread selection the composer last reconciled its draft with. */
export interface ThreadModelOptionsSeedRecord {
  readonly key: string;
  /** The thread's options while the draft still holds them; null once the user diverged. */
  readonly options: ProviderModelOptions | null;
}

const MAX_SEEDED_THREADS = 256;
const seedsByThread = new Map<string, ThreadModelOptionsSeedRecord>();

export function getThreadModelOptionsSeed(
  threadId: ThreadId,
): ThreadModelOptionsSeedRecord | undefined {
  return seedsByThread.get(threadId);
}

export function recordThreadModelOptionsSeed(
  threadId: ThreadId,
  record: ThreadModelOptionsSeedRecord,
): void {
  seedsByThread.delete(threadId);
  seedsByThread.set(threadId, record);
  while (seedsByThread.size > MAX_SEEDED_THREADS) {
    const oldestThreadId = seedsByThread.keys().next().value;
    if (typeof oldestThreadId !== "string") break;
    seedsByThread.delete(oldestThreadId);
  }
}

export function resetThreadModelOptionsSeedsForTests(): void {
  seedsByThread.clear();
}
