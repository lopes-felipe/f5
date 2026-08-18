import { createHmac, randomBytes } from "node:crypto";

import type { ProviderDriverKind, ProviderInstanceEnvironment } from "@t3tools/contracts";

// A process-local key keeps sensitive values useful for change detection while
// ensuring fingerprints persisted to SQLite or the provider-status cache
// cannot be used for offline dictionary attacks. A restart intentionally
// invalidates cached identities for instances with sensitive environment.
const sensitiveFingerprintKey = randomBytes(32);

function sensitiveValueFingerprint(value: string): string {
  return `hmac:${createHmac("sha256", sensitiveFingerprintKey).update(value).digest("hex")}`;
}

export function fingerprintableProviderEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
): ReadonlyArray<{ readonly name: string; readonly sensitive: boolean; readonly value: string }> {
  return [...(environment ?? [])]
    .map((variable) => ({
      name: variable.name,
      sensitive: variable.sensitive,
      value: variable.sensitive ? sensitiveValueFingerprint(variable.value) : variable.value,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function fingerprintableProviderConfig(
  driver: ProviderDriverKind,
  config: unknown,
): unknown {
  if (driver !== "opencode" || !config || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }
  const record = config as Record<string, unknown>;
  const serverPassword = record.serverPassword;
  return {
    ...record,
    ...(typeof serverPassword === "string" && serverPassword.length > 0
      ? { serverPassword: sensitiveValueFingerprint(serverPassword) }
      : {}),
  };
}
