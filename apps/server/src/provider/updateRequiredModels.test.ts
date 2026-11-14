import { describe, expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { withUpdateRequiredModels } from "./updateRequiredModels.ts";

const snapshot = (driver: string, version: string | null): ServerProvider => ({
  instanceId: ProviderInstanceId.makeUnsafe(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-12T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

describe("model update notices", () => {
  it("requires a known older CLI version and clears notices after updating", () => {
    expect(
      withUpdateRequiredModels(snapshot("codex", "0.152.0")).updateRequiredModels,
    ).toContainEqual({ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", minVersion: "0.153.0" });
    expect(withUpdateRequiredModels(snapshot("codex", "0.155.0")).updateRequiredModels).toEqual([]);
    expect(withUpdateRequiredModels(snapshot("codex", null)).updateRequiredModels).toEqual([]);
    expect(
      withUpdateRequiredModels(snapshot("claudeAgent", "2.1.1")).updateRequiredModels?.length,
    ).toBeGreaterThan(0);
  });
  it("trusts discovered models and does not gate other providers", () => {
    const provider = snapshot("codex", "0.152.0");
    const result = withUpdateRequiredModels({
      ...provider,
      models: [
        {
          slug: "openai.gpt-6.1-sol",
          name: "Sol",
          isCustom: false,
          capabilities: { source: "reported", optionDescriptors: [] },
        },
      ],
    });
    expect(result.updateRequiredModels?.some((model) => model.slug === "gpt-6.1-sol")).toBe(false);
    const fallback = withUpdateRequiredModels({
      ...provider,
      models: [{ slug: "gpt-6.1-sol", name: "Sol", isCustom: false, capabilities: null }],
    });
    expect(fallback.updateRequiredModels?.some((model) => model.slug === "gpt-6.1-sol")).toBe(true);
    expect(fallback.models[0]?.isUnlisted).toBe(true);
    expect(withUpdateRequiredModels(snapshot("cursor", "0.1.0")).updateRequiredModels).toEqual([]);
  });
});
