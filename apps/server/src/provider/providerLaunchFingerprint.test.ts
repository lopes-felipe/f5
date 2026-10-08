import { describe, expect, it } from "vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { computeProviderLaunchFingerprint } from "./providerLaunchFingerprint.ts";

const base = {
  provider: "codex" as const,
  providerInstanceId: ProviderInstanceId.make("codex-work"),
  runtimeMode: "auto-accept-edits" as const,
  cwd: "/workspace",
  instanceLaunchIdentity: "instance-config-a",
};

describe("computeProviderLaunchFingerprint", () => {
  it("is stable for the same launch identity", () => {
    expect(computeProviderLaunchFingerprint(base)).toBe(computeProviderLaunchFingerprint(base));
  });

  it.each([
    [{ runtimeMode: "full-access" as const }],
    [{ cwd: "/other" }],
    [{ instanceLaunchIdentity: "instance-config-b" }],
    [{ providerOptions: { codex: { launchArgs: ["--enable=one"] } } }],
    [{ mcpEffectiveConfigVersion: "mcp-v2" }],
    [{ workflowExecutionProfile: "unattended-readonly" as const }],
  ])("changes when a launch dimension changes (%o)", (change) => {
    expect(computeProviderLaunchFingerprint({ ...base, ...change })).not.toBe(
      computeProviderLaunchFingerprint(base),
    );
  });

  it("keeps the golden fingerprint for unchanged legacy Claude thinking input", () => {
    // Produced by the pre-Release-1 implementation; must never drift, or every
    // session using maxThinkingTokens would restart.
    expect(
      computeProviderLaunchFingerprint({
        provider: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        runtimeMode: "full-access",
        cwd: "/workspace",
        providerOptions: {
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            permissionMode: "plan",
            maxThinkingTokens: 2048,
          },
        },
      }),
    ).toBe("023c66fcc326944c378ddada7b13047d709254e6a713ff8d0c5ac8a4ff004802");
  });

  it("adds typed thinking as an extra launch component", () => {
    const claude = {
      provider: "claudeAgent" as const,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      runtimeMode: "full-access" as const,
    };
    expect(
      computeProviderLaunchFingerprint({
        ...claude,
        providerOptions: { claudeAgent: { thinking: { type: "adaptive" } } },
      }),
    ).not.toBe(computeProviderLaunchFingerprint(claude));
  });
});
