import { describe, expect, it } from "vitest";

import { fingerprintableProviderEnvironment } from "./sensitiveFingerprint.ts";

describe("fingerprintableProviderEnvironment", () => {
  it("keeps sensitive values change-sensitive without persisting plaintext", () => {
    const first = fingerprintableProviderEnvironment([
      { name: "API_TOKEN", value: "low-entropy-secret", sensitive: true },
    ]);
    const repeated = fingerprintableProviderEnvironment([
      { name: "API_TOKEN", value: "low-entropy-secret", sensitive: true },
    ]);
    const changed = fingerprintableProviderEnvironment([
      { name: "API_TOKEN", value: "different-secret", sensitive: true },
    ]);

    expect(first).toEqual(repeated);
    expect(first).not.toEqual(changed);
    expect(JSON.stringify(first)).not.toContain("low-entropy-secret");
  });
});
