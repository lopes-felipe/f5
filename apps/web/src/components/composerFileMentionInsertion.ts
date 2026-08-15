import type { ThreadId } from "@t3tools/contracts";

type FileMentionInserter = (relativePath: string) => boolean;

const inserters = new Map<string, FileMentionInserter>();

export function registerComposerFileMentionInserter(
  threadId: ThreadId,
  inserter: FileMentionInserter,
): () => void {
  inserters.set(threadId, inserter);
  return () => {
    if (inserters.get(threadId) === inserter) inserters.delete(threadId);
  };
}

export function insertFileMentionIntoComposer(threadId: ThreadId, relativePath: string): boolean {
  return inserters.get(threadId)?.(relativePath) ?? false;
}
