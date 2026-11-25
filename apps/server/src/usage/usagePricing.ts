import { providerReportsCacheOutsideInput, type UsagePriceOverride } from "@t3tools/contracts";
import type { UsageAggregateRow } from "../persistence/Services/UsageFacts.ts";
import { lookupRate, parseRateTable, type RateTable, type TokenRates } from "./modelRateTable.ts";

export function emptyCostBreakdown() {
  return {
    byType: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 },
    bySpeed: { standard: 0, fast: 0, ultrafast: 0, unknown: 0 },
    speedPremiumUsd: 0,
  };
}

export function priceUsageAggregate<Row extends UsageAggregateRow>(
  row: Row,
  override: UsagePriceOverride | undefined,
  table?: RateTable,
): Row {
  const recorded = row.providerReportedCostUsd;
  const hasTokens =
    (row.nativeInferenceCount ?? 0) > 0 ||
    (row.turnCount > 0 &&
      (row.estimationEligibleTurnCount ?? row.reportedTokenTurnCount) === row.turnCount);
  const published = table && row.model !== null ? lookupRate(table, row.model) : null;
  const standard: TokenRates | null = override
    ? {
        inputCostPerToken: override.inputUsdPerMillion / 1_000_000,
        outputCostPerToken: override.outputUsdPerMillion / 1_000_000,
        cacheReadCostPerToken:
          (override.cacheReadUsdPerMillion ?? override.inputUsdPerMillion) / 1_000_000,
        cacheCreationCostPerToken:
          (override.cacheWriteUsdPerMillion ?? override.inputUsdPerMillion) / 1_000_000,
      }
    : published;
  const speed = row.speed ?? "unknown";
  const rates =
    !override && published && (speed === "fast" || speed === "ultrafast")
      ? (published[speed] ?? standard)
      : standard;
  const cacheOutside = row.cacheOutsideInput ?? providerReportsCacheOutsideInput(row.provider);
  const inputTokens = cacheOutside
    ? row.inputTokens
    : Math.max(0, row.inputTokens - row.cacheReadTokens);
  const cacheWriteTokens = cacheOutside ? row.cacheWriteTokens : 0;
  const costAt = (rate: TokenRates) => ({
    input: inputTokens * rate.inputCostPerToken,
    output: row.outputTokens * rate.outputCostPerToken,
    cacheRead: row.cacheReadTokens * rate.cacheReadCostPerToken,
    cacheWrite: cacheWriteTokens * rate.cacheCreationCostPerToken,
  });
  const sum = (cost: ReturnType<typeof costAt>) =>
    cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  const nominal = hasTokens && rates ? costAt(rates) : null;
  const nominalTotal = nominal ? sum(nominal) : null;
  const estimate = recorded === null && nominalTotal !== null && Number.isFinite(nominalTotal);
  const cost = estimate ? nominalTotal : recorded;
  if (cost === null) return row;
  const byType =
    nominal && nominalTotal && Number.isFinite(nominalTotal)
      ? {
          input: (nominal.input / nominalTotal) * cost,
          output: (nominal.output / nominalTotal) * cost,
          cacheRead: (nominal.cacheRead / nominalTotal) * cost,
          cacheWrite: (nominal.cacheWrite / nominalTotal) * cost,
          unattributed: 0,
        }
      : { ...emptyCostBreakdown().byType, unattributed: cost };
  return {
    ...row,
    ...(estimate
      ? {
          estimatedCostUsd: cost,
          pricedTurnCount: row.turnCount,
          unpricedTurnCount: 0,
          ...(row.nativeInferenceCount ? { unpricedNativeInferenceCount: 0 } : {}),
        }
      : {}),
    costBreakdown: {
      byType,
      bySpeed: { ...emptyCostBreakdown().bySpeed, [speed]: cost },
      speedPremiumUsd:
        standard && rates !== standard && nominalTotal && Number.isFinite(nominalTotal)
          ? Math.max(0, 1 - sum(costAt(standard)) / nominalTotal) * cost
          : 0,
    },
  };
}

const LIST_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MAX_RATE_BYTES = 8 * 1024 * 1024;

/** A shared refresh per server, with the last valid table retained across a failed refresh. */
export function makeListRateCache(request = fetch) {
  let table: RateTable = new Map();
  let refreshing = false;
  let refreshAt = 0;
  return (now: number): { table: RateTable; refreshing: boolean } => {
    if (refreshing || now < refreshAt) return { table, refreshing };
    refreshing = true;
    void (async () => {
      const response = await request(LIST_RATES_URL, {
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      if (!response.ok || !response.body) throw new Error("Model rates unavailable.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let document = "";
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RATE_BYTES) {
            await reader.cancel();
            throw new Error("Model rate table exceeds its size limit.");
          }
          document += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      const parsed = parseRateTable(JSON.parse(document + decoder.decode()));
      if (parsed.size === 0) throw new Error("Model rate table is empty.");
      table = parsed;
      refreshAt = now + 86_400_000;
    })()
      .catch(() => {
        refreshAt = now + 300_000;
      })
      .finally(() => {
        refreshing = false;
      });
    return { table, refreshing };
  };
}
