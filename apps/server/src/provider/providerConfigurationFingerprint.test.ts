import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { executionProviderFingerprint } from "./providerConfigurationFingerprint.ts";
describe("scheduled recovery execution identity", () => {
  it("ignores cosmetic settings and object field order", () => {
    const base = {
      driver: ProviderDriverKind.make("codex"),
      config: { binaryPath: "/bin/codex", home: "/tmp/account" },
    };
    expect(executionProviderFingerprint(base)).toBe(
      executionProviderFingerprint({
        ...base,
        displayName: "New label",
        accentColor: "blue",
        config: { home: "/tmp/account", binaryPath: "/bin/codex" },
      }),
    );
    expect(executionProviderFingerprint(base)).not.toBe(
      executionProviderFingerprint({ ...base, config: { home: "/tmp/other-account" } }),
    );
  });
  it("detects credential changes without persisting raw sensitive values", () => {
    const base = {
      driver: ProviderDriverKind.make("codex"),
      environment: [{ name: "SECRET", value: "original-secret", sensitive: true }],
    };
    const fingerprint = executionProviderFingerprint(base);
    expect(fingerprint).not.toContain("original-secret");
    expect(fingerprint).toBe(executionProviderFingerprint(base));
    expect(fingerprint).not.toBe(
      executionProviderFingerprint({
        ...base,
        environment: [{ name: "SECRET", value: "changed-secret", sensitive: true }],
      }),
    );
  });
});
