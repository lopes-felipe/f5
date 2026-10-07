import { createHash } from "node:crypto";
import type { ProviderInstanceConfig } from "@t3tools/contracts";
import {
  fingerprintableProviderConfig,
  fingerprintableProviderEnvironment,
} from "./sensitiveFingerprint.ts";

export function stableFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFingerprintValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableFingerprintValue(nested)]),
    );
  return value;
}

/** Execution identity deliberately excludes the display name and accent color. */
export function executionProviderFingerprint(entry: ProviderInstanceConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableFingerprintValue({
          version: 1,
          driver: entry.driver,
          enabled: entry.enabled ?? null,
          environment: fingerprintableProviderEnvironment(entry.environment),
          config: fingerprintableProviderConfig(entry.driver, entry.config),
        }),
      ),
    )
    .digest("hex");
}
