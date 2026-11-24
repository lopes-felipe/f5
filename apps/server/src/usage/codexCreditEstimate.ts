import { normalizeModelSlug } from "@t3tools/shared/model";

// Codex Standard credit rates per million tokens, published November 2026.
// https://learn.chatgpt.com/docs/pricing#token-rates
const standardRates: ReadonlyMap<string, readonly [input: number, cached: number, output: number]> =
  new Map([
    ["gpt-6.2-astra", [200, 10, 1000]],
    ["gpt-6.2-sol", [50, 2.5, 250]],
    ["gpt-6-astra", [250, 25, 1250]],
    ["gpt-6.1-sol", [50, 2.5, 250]],
    ["gpt-6.1-terra", [25, 1.25, 125]],
    ["gpt-6-sol", [50, 5, 250]],
    ["gpt-6-luna", [2.5, 0.25, 12.5]],
    ["gpt-5.6-sol", [100, 10, 500]],
    ["gpt-5.6-terra", [50, 5, 300]],
    ["gpt-5.6-luna", [5, 0.5, 30]],
  ]);

export function estimateCodexStandardCredits(
  model: string | null,
  input: number | null,
  cacheRead: number | null,
  output: number | null,
) {
  if (input === null || cacheRead === null || output === null) {
    return undefined;
  }
  const rates = standardRates.get(normalizeModelSlug(model) ?? "");
  if (!rates || cacheRead > input) return undefined;
  const [inputRate, cachedRate, outputRate] = rates;
  return (
    ((input - cacheRead) * inputRate + cacheRead * cachedRate + output * outputRate) / 1_000_000
  );
}
