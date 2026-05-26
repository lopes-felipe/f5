import type { ThreadId, TurnId } from "@t3tools/contracts";

export function buildInlineFileChangeCheckpointDiffQueryInput(input: {
  readonly threadId: ThreadId | null;
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number | undefined;
  readonly diffUnavailable: boolean;
}) {
  return {
    threadId: input.threadId,
    fromTurnCount:
      typeof input.checkpointTurnCount === "number"
        ? Math.max(0, input.checkpointTurnCount - 1)
        : null,
    toTurnCount: input.checkpointTurnCount ?? null,
    cacheScope: `turn:${input.turnId}`,
    // Inline summaries use counts computed without whitespace ignoring; keep
    // this fallback diff on the same basis so file stats stay aligned.
    ignoreWhitespace: false,
    enabled: !input.diffUnavailable,
    retryMode: "inline" as const,
  };
}
