import { createHmac, randomBytes } from "node:crypto";

import type { ProviderDriverKind, ProviderInstanceEnvironment } from "@t3tools/contracts";
import { providerInstanceSecretField } from "@t3tools/shared/serverSettings";

// A process-local key keeps sensitive values useful for change detection while
// ensuring fingerprints persisted to SQLite or the provider-status cache
// cannot be used for offline dictionary attacks. A restart intentionally
// invalidates cached identities for instances with sensitive environment.
const sensitiveFingerprintKey = randomBytes(32);

function sensitiveValueFingerprint(
  value: string,
  key: Uint8Array = sensitiveFingerprintKey,
): string {
  return `hmac:${createHmac("sha256", key).update(value).digest("hex")}`;
}

export function fingerprintableProviderEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  key?: Uint8Array,
): ReadonlyArray<{ readonly name: string; readonly sensitive: boolean; readonly value: string }> {
  return [...(environment ?? [])]
    .map((variable) => ({
      name: variable.name,
      sensitive: variable.sensitive,
      value: variable.sensitive ? sensitiveValueFingerprint(variable.value, key) : variable.value,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function fingerprintableProviderConfig(
  driver: ProviderDriverKind,
  config: unknown,
  key?: Uint8Array,
): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  let record = config as Record<string, unknown>;
  // The Cursor harness pin writes `harness: "acp"`, the behavior every Cursor
  // instance had before the field existed. Leaving it out keeps fingerprints
  // stored before the pin (queued resumes, MCP account identities) matching.
  if (driver === "cursor" && record.harness === "acp") {
    const { harness: _pinned, ...rest } = record;
    record = rest;
  }
  const secret = providerInstanceSecretField(driver);
  if (!secret) return record === config ? config : record;
  const value = record[secret.field];
  return {
    ...record,
    ...(typeof value === "string" && value.length > 0
      ? { [secret.field]: sensitiveValueFingerprint(value, key) }
      : {}),
  };
}
