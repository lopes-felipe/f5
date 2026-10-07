import { createHash } from "node:crypto";
import { Effect, Option } from "effect";
import { ServerSecretStore, SecretStoreError } from "../auth/Services/ServerSecretStore.ts";
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
export function executionProviderFingerprint(
  entry: ProviderInstanceConfig,
  key?: Uint8Array,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableFingerprintValue({
          version: 1,
          driver: entry.driver,
          enabled: entry.enabled ?? null,
          environment: fingerprintableProviderEnvironment(entry.environment, key),
          config: fingerprintableProviderConfig(entry.driver, entry.config, key),
        }),
      ),
    )
    .digest("hex");
}

/** Durable execution identity for persisted recovery; sensitive inputs require protected storage. */
export const executionProviderFingerprintFor = (entry: ProviderInstanceConfig) =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(ServerSecretStore);
    if (Option.isSome(store)) {
      const key = yield* store.value.getOrCreateRandom("usage-resume-fingerprint-key", 32);
      return executionProviderFingerprint(entry, key);
    }
    const hasSensitiveValues =
      entry.environment?.some((variable) => variable.sensitive) ||
      (entry.driver === "opencode" &&
        entry.config &&
        typeof entry.config === "object" &&
        "serverPassword" in entry.config &&
        typeof entry.config.serverPassword === "string" &&
        entry.config.serverPassword.length > 0);
    if (hasSensitiveValues)
      return yield* Effect.fail(
        new SecretStoreError({
          message:
            "Protected secret storage is required for a durable provider recovery fingerprint.",
        }),
      );
    return executionProviderFingerprint(entry);
  });
