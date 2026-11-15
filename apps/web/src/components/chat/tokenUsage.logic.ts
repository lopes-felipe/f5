import { providerReportsCacheOutsideInput, type UsageThreadTurn } from "@t3tools/contracts";

const compactTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatUsageTokens(value: number): string {
  return compactTokens.format(value).replace(/K$/u, "k");
}

export function sumReportedTokens(values: ReadonlyArray<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => value != null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/** Normalize input to include cache for every provider. Reasoning is never added a second time. */
export function turnTokenUsage(turn: UsageThreadTurn) {
  const separateCache = providerReportsCacheOutsideInput(turn.provider);
  const fields = [
    turn.inputTokens,
    turn.outputTokens,
    ...(separateCache ? [turn.cacheReadTokens, turn.cacheWriteTokens] : []),
  ];
  return {
    input: separateCache
      ? sumReportedTokens([turn.inputTokens, turn.cacheReadTokens, turn.cacheWriteTokens])
      : turn.inputTokens,
    inputPartial:
      separateCache &&
      [turn.inputTokens, turn.cacheReadTokens, turn.cacheWriteTokens].some(
        (value) => value == null,
      ),
    output: turn.outputTokens,
    total: turn.totalTokens ?? sumReportedTokens(fields),
    partial:
      turn.totalTokens != null && turn.tokenProvenance === "provider-reported"
        ? false
        : fields.some((value) => value == null),
  };
}
