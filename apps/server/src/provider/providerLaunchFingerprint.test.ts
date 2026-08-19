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
});
