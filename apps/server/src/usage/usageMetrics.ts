import type {
  ProviderKind,
  ProviderRuntimeEvent,
  UsageCostProvenance,
  UsageTokenProvenance,
} from "@t3tools/contracts";

type UnknownRecord = Record<string, unknown>;

export interface NormalizedTurnUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly totalTokens: number | null;
  readonly providerReportedCostUsd: number | null;
  readonly tokenProvenance: UsageTokenProvenance;
  readonly costProvenance: UsageCostProvenance;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstInteger(
  records: ReadonlyArray<UnknownRecord | undefined>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = asNonNegativeInteger(record?.[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function sumModelUsageField(
  modelUsage: UnknownRecord | undefined,
  keys: ReadonlyArray<string>,
): number | undefined {
  if (!modelUsage) return undefined;
  let found = false;
  let total = 0;
  for (const value of Object.values(modelUsage)) {
    const record = asRecord(value);
    const field = firstInteger([record], keys);
    if (field === undefined) continue;
    found = true;
    total += field;
  }
  return found && Number.isSafeInteger(total) ? total : undefined;
}

function readMetric(
  records: ReadonlyArray<UnknownRecord | undefined>,
  modelUsage: UnknownRecord | undefined,
  keys: ReadonlyArray<string>,
): number | undefined {
  return firstInteger(records, keys) ?? sumModelUsageField(modelUsage, keys);
}

export function normalizeTurnUsage(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
): NormalizedTurnUsage {
  // Some legacy adapters/tests still provide lifecycle fields at the event
  // root. Treat a missing payload as an unreported fact instead of allowing
  // observability persistence to interrupt lifecycle ingestion.
  const payload = event.payload as
    | (typeof event.payload & { readonly totalCostUsd?: unknown })
    | undefined;
  const usage = asRecord(payload?.usage);
  const nestedUsage = asRecord(usage?.usage);
  const tokenUsage = asRecord(usage?.tokenUsage);
  const lastUsage = asRecord(tokenUsage?.last);
  const records = [usage, nestedUsage, lastUsage] as const;
  const modelUsage = asRecord(payload?.modelUsage);

  const inputTokens = readMetric(records, modelUsage, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
  ]);
  const outputTokens = readMetric(records, modelUsage, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
  ]);
  const cacheReadTokens = readMetric(records, modelUsage, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cached_input_tokens",
    "cachedInputTokens",
  ]);
  const cacheWriteTokens = readMetric(records, modelUsage, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
  ]);
  const reportedTotalTokens = readMetric(records, modelUsage, ["total_tokens", "totalTokens"]);
  const hasTokenMetric =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cacheReadTokens !== undefined ||
    cacheWriteTokens !== undefined ||
    reportedTotalTokens !== undefined;
  const derivedTotalTokens = deriveTotalTokens(event.provider, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
  const providerReportedCostUsd = asNonNegativeNumber(payload?.totalCostUsd);

  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    cacheReadTokens: cacheReadTokens ?? null,
    cacheWriteTokens: cacheWriteTokens ?? null,
    totalTokens: reportedTotalTokens ?? derivedTotalTokens ?? null,
    providerReportedCostUsd: providerReportedCostUsd ?? null,
    tokenProvenance:
      reportedTotalTokens !== undefined
        ? "provider-reported"
        : hasTokenMetric
          ? "derived-from-provider-fields"
          : "unreported",
    costProvenance: providerReportedCostUsd === undefined ? "unreported" : "provider-reported",
  };
}

function deriveTotalTokens(
  provider: ProviderKind,
  metrics: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
    readonly cacheReadTokens: number | undefined;
    readonly cacheWriteTokens: number | undefined;
  },
): number | undefined {
  const values = [metrics.inputTokens, metrics.outputTokens];
  // Claude reports cache reads/writes outside input_tokens. OpenAI-compatible
  // providers report cached input as a subset of input tokens, so adding it
  // there would double count consumption.
  if (provider === "claudeAgent") {
    values.push(metrics.cacheReadTokens, metrics.cacheWriteTokens);
  }
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) return undefined;
  const total = present.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}
