import { describe, expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  READ_ONLY_WORKFLOW_UNCERTIFIED_ANTIGRAVITY_MESSAGE,
  driverSupportsReadOnlyWorkflowTurns,
  providerSupportsReadOnlyWorkflow,
  readOnlyWorkflowUnsupportedReason,
  type WorkflowProviderSnapshot,
} from "./workflowProviders";

const antigravity = (readOnlyWorkflowTurns: boolean | undefined): WorkflowProviderSnapshot =>
  ({
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    ...(readOnlyWorkflowTurns === undefined
      ? {}
      : { runtimeCapabilities: { readOnlyWorkflowTurns } }),
  }) as WorkflowProviderSnapshot;

describe("read-only workflow providers", () => {
  it("never certifies Grok or Muse, and certifies no Antigravity version yet", () => {
    expect(driverSupportsReadOnlyWorkflowTurns("grok", "1.0.0", "darwin")).toBe(false);
    expect(driverSupportsReadOnlyWorkflowTurns("muse", "1.0.0", "darwin")).toBe(false);
    expect(driverSupportsReadOnlyWorkflowTurns("antigravity", "1.5.15", "darwin")).toBe(false);
    expect(driverSupportsReadOnlyWorkflowTurns("antigravity", null, "darwin")).toBe(false);
    expect(driverSupportsReadOnlyWorkflowTurns("codex", null, undefined)).toBe(true);
  });

  it("follows the Antigravity instance's reported capability", () => {
    expect(providerSupportsReadOnlyWorkflow("antigravity", [antigravity(true)])).toBe(true);
    expect(providerSupportsReadOnlyWorkflow("antigravity", [antigravity(false)])).toBe(false);
    expect(providerSupportsReadOnlyWorkflow("antigravity", [antigravity(undefined)])).toBe(false);
    expect(providerSupportsReadOnlyWorkflow("antigravity", [])).toBe(false);
    expect(providerSupportsReadOnlyWorkflow("codex", [])).toBe(true);
    expect(providerSupportsReadOnlyWorkflow("grok", [])).toBe(false);
  });

  it("explains why a provider is unavailable", () => {
    expect(readOnlyWorkflowUnsupportedReason("antigravity", [antigravity(false)])).toBe(
      READ_ONLY_WORKFLOW_UNCERTIFIED_ANTIGRAVITY_MESSAGE,
    );
    expect(readOnlyWorkflowUnsupportedReason("muse", [])).toBe(
      "This provider cannot enforce read-only workflow turns.",
    );
    expect(readOnlyWorkflowUnsupportedReason("claudeAgent", [])).toBeNull();
  });
});
