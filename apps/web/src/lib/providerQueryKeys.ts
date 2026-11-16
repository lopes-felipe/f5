import type { ThreadId } from "@t3tools/contracts";

// Invalidation runs at startup; diff decoding belongs to the lazily loaded panes.
export interface CheckpointDiffQueryInput {
  threadId: ThreadId | null;
  fromTurnCount: number | null;
  toTurnCount: number | null;
  cacheScope?: string | null;
  ignoreWhitespace?: boolean;
  enabled?: boolean;
  retryMode?: "panel" | "inline";
}

export const providerQueryKeys = {
  all: ["providers"] as const,
  checkpointDiffPrefix: (threadId: ThreadId | null) =>
    ["providers", "checkpointDiff", threadId] as const,
  checkpointDiff: (input: CheckpointDiffQueryInput) =>
    [
      "providers",
      "checkpointDiff",
      input.threadId,
      input.fromTurnCount,
      input.toTurnCount,
      input.cacheScope ?? null,
      input.ignoreWhitespace ?? false,
    ] as const,
  fileContentAll: ["fileContent"] as const,
  fileContent: (input: { cwd: string | undefined; relativePath: string | undefined }) =>
    ["fileContent", input.cwd, input.relativePath] as const,
};
