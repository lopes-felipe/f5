import { createHmac, randomBytes } from "node:crypto";

import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

// A process-local key keeps sensitive values useful for change detection while
// ensuring fingerprints persisted to SQLite or the provider-status cache
// cannot be used for offline dictionary attacks. A restart intentionally
// invalidates cached identities for instances with sensitive environment.
const sensitiveFingerprintKey = randomBytes(32);

export function fingerprintableProviderEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
): ReadonlyArray<{ readonly name: string; readonly sensitive: boolean; readonly value: string }> {
  return [...(environment ?? [])]
    .map((variable) => ({
      name: variable.name,
      sensitive: variable.sensitive,
      value: variable.sensitive
        ? `hmac:${createHmac("sha256", sensitiveFingerprintKey).update(variable.value).digest("hex")}`
        : variable.value,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}
