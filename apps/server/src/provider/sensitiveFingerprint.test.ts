import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  fingerprintableProviderConfig,
  fingerprintableProviderEnvironment,
} from "./sensitiveFingerprint.ts";

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

describe("fingerprintableProviderConfig", () => {
  it("uses a keyed fingerprint for OpenCode server passwords", () => {
    const fingerprinted = fingerprintableProviderConfig(ProviderDriverKind.makeUnsafe("opencode"), {
      serverUrl: "https://example.test",
      serverPassword: "guessable-password",
    }) as Record<string, unknown>;

    expect(fingerprinted.serverPassword).not.toBe("guessable-password");
    expect(fingerprinted.serverPassword).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(
      fingerprintableProviderConfig(ProviderDriverKind.makeUnsafe("codex"), {
        token: "public-shape",
      }),
    ).toEqual({
      token: "public-shape",
    });
  });
});
