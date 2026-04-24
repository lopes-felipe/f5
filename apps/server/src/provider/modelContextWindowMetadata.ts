import type { ProviderKind } from "@t3tools/contracts";
import { estimateModelContextWindowTokens, normalizeModelSlug } from "@t3tools/shared/model";

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

const MODEL_CONTEXT_WINDOW_TOKEN_KEYS = [
  "contextWindowTokens",
  "context_window_tokens",
  "modelContextWindowTokens",
  "model_context_window_tokens",
  "maxContextWindowTokens",
  "max_context_window_tokens",
  "maxInputTokens",
  "max_input_tokens",
  "inputTokenLimit",
  "input_token_limit",
] as const;

const NESTED_METADATA_KEYS = [
  "limits",
  "contextWindow",
  "context_window",
  "metadata",
  "capabilities",
  "tokenLimits",
  "token_limits",
] as const;

const MODEL_IDENTIFIER_KEYS = ["id", "model", "value", "slug"] as const;

const anthropicModelCatalogCache = new Map<string, Promise<ReadonlyMap<string, number>>>();

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function findModelContextWindowTokens(
  value: unknown,
  visited: ReadonlySet<unknown> = new Set(),
): number | undefined {
  const record = asRecord(value);
  if (!record || visited.has(record)) {
    return undefined;
  }

  const nextVisited = new Set(visited);
  nextVisited.add(record);

  for (const key of MODEL_CONTEXT_WINDOW_TOKEN_KEYS) {
    const tokens = asNonNegativeInt(record[key]);
    if (tokens !== undefined) {
      return tokens;
    }
  }

  for (const key of NESTED_METADATA_KEYS) {
    const tokens = findModelContextWindowTokens(record[key], nextVisited);
    if (tokens !== undefined) {
      return tokens;
    }
  }

  return undefined;
}

export function readConfiguredModelContextWindowTokens(
  config: Record<string, unknown>,
): number | undefined {
  return findModelContextWindowTokens(config);
}

function readProviderModelEntries(response: unknown): ReadonlyArray<Record<string, unknown>> {
  const directEntries = asArray(response);
  if (directEntries) {
    return directEntries.flatMap((entry) => {
      const record = asRecord(entry);
      return record ? [record] : [];
    });
  }

  const record = asRecord(response);
  const nestedEntries = asArray(record?.data) ?? asArray(record?.models);
  if (!nestedEntries) {
    return [];
  }

  return nestedEntries.flatMap((entry) => {
    const nestedRecord = asRecord(entry);
    return nestedRecord ? [nestedRecord] : [];
  });
}

function buildProviderModelContextWindowCatalog(
  provider: ProviderKind,
  entries: ReadonlyArray<Record<string, unknown>>,
): ReadonlyMap<string, number> {
  if (entries.length === 0) {
    return new Map();
  }

  const catalog = new Map<string, number>();
  for (const entry of entries) {
    const tokens = findModelContextWindowTokens(entry);
    if (tokens === undefined) {
      continue;
    }

    for (const key of MODEL_IDENTIFIER_KEYS) {
      const identifier = entry[key];
      if (typeof identifier !== "string" || identifier.trim().length === 0) {
        continue;
      }
      const trimmedIdentifier = identifier.trim();
      const normalizedIdentifier = normalizeModelSlug(trimmedIdentifier, provider);
      catalog.set(trimmedIdentifier, tokens);
      if (normalizedIdentifier) {
        catalog.set(normalizedIdentifier, tokens);
      }
    }
  }

  return catalog;
}

export function readClaudeModelContextWindowCatalog(
  response: unknown,
): ReadonlyMap<string, number> {
  return buildProviderModelContextWindowCatalog("claudeAgent", readProviderModelEntries(response));
}

export function readCodexModelContextWindowCatalog(response: unknown): ReadonlyMap<string, number> {
  return buildProviderModelContextWindowCatalog("codex", readProviderModelEntries(response));
}

export function lookupModelContextWindowTokens(input: {
  readonly provider: ProviderKind;
  readonly model: string | null | undefined;
  readonly catalog?: ReadonlyMap<string, number> | null | undefined;
}): number | undefined {
  if (!input.catalog || input.catalog.size === 0 || typeof input.model !== "string") {
    return undefined;
  }

  const trimmedModel = input.model.trim();
  if (trimmedModel.length === 0) {
    return undefined;
  }

  const normalizedModel = normalizeModelSlug(trimmedModel, input.provider);
  return (
    input.catalog.get(trimmedModel) ??
    (normalizedModel ? input.catalog.get(normalizedModel) : undefined)
  );
}

function normalizeAnthropicApiBaseUrl(baseUrl: string | null | undefined): string {
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  return trimmed.length > 0 ? trimmed.replace(/\/+$/u, "") : DEFAULT_ANTHROPIC_API_BASE_URL;
}

export function clearAnthropicModelContextWindowCatalogCacheForTest(): void {
  anthropicModelCatalogCache.clear();
}

export async function fetchAnthropicModelContextWindowCatalog(input: {
  readonly apiKey?: string | null | undefined;
  readonly authToken?: string | null | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}): Promise<ReadonlyMap<string, number>> {
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const authToken = typeof input.authToken === "string" ? input.authToken.trim() : "";
  if (apiKey.length === 0 && authToken.length === 0) {
    return new Map();
  }

  const baseUrl = normalizeAnthropicApiBaseUrl(input.baseUrl);
  const credentialCacheKey = apiKey.length > 0 ? `api:${apiKey}` : `oauth:${authToken}`;
  const cacheKey = `${baseUrl}\n${credentialCacheKey}`;
  const cached = anthropicModelCatalogCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const loadCatalog = (async () => {
    const response = await (input.fetchImpl ?? fetch)(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "anthropic-version": ANTHROPIC_API_VERSION,
        ...(apiKey.length > 0 ? { "x-api-key": apiKey } : {}),
        ...(apiKey.length === 0 && authToken.length > 0
          ? { authorization: `Bearer ${authToken}` }
          : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Anthropic models API request failed with status ${response.status}.`);
    }

    return readClaudeModelContextWindowCatalog(await response.json());
  })();

  anthropicModelCatalogCache.set(cacheKey, loadCatalog);

  try {
    return await loadCatalog;
  } catch (error) {
    anthropicModelCatalogCache.delete(cacheKey);
    throw error;
  }
}

export function resolveModelContextWindowTokens(input: {
  readonly provider: ProviderKind;
  readonly model: string | null | undefined;
  readonly reportedModelContextWindowTokens?: number | null | undefined;
}): number {
  return (
    input.reportedModelContextWindowTokens ??
    estimateModelContextWindowTokens(input.model, input.provider)
  );
}
