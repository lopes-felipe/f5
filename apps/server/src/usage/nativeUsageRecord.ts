export interface NativeUsageTotals {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export type ExternalHistoryProvider = "opencode" | "antigravity" | "cursor";

export interface NativeUsageRecord {
  readonly provider: ExternalHistoryProvider;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: NativeUsageTotals;
  readonly reportedCostUsd: number | null;
  readonly dedupeKey: string | null;
}

export function totalTokens(totals: NativeUsageTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}
