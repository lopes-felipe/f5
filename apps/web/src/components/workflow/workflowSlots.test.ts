import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createClaudeModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vitest";

import {
  getSingleProviderModelOptions,
  normalizeWorkflowSlotModelOptions,
  workflowModelOptionsByProvider,
  workflowPickerProviders,
  workflowSlotAppliesModelOptions,
} from "./workflowSlots";

function snapshot(driverName: string, instanceId?: string): ServerProvider {
  const driver = ProviderDriverKind.make(driverName);
  return {
    instanceId: instanceId
      ? ProviderInstanceId.make(instanceId)
      : defaultInstanceIdForDriver(driver),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("workflowPickerProviders", () => {
  it("keeps the default instance of each driver and drops other instances", () => {
    const codexWork = snapshot("codex", "codex_work");
    const codex = snapshot("codex");
    const claude = snapshot("claudeAgent");
    expect(workflowPickerProviders([codexWork, codex, claude])).toEqual([codex, claude]);
  });

  it("falls back to the first instance of a driver without a default instance", () => {
    const first = snapshot("antigravity", "antigravity_work");
    const second = snapshot("antigravity", "antigravity_home");
    expect(workflowPickerProviders([first, second])).toEqual([first]);
  });
});

describe("workflowModelOptionsByProvider", () => {
  it("reads each provider's options from the instance its slots run on", () => {
    const codex = snapshot("codex");
    const codexWork = snapshot("codex", "codex_work");
    const antigravity = snapshot("antigravity", "antigravity_work");
    const byInstance = new Map([
      [codex.instanceId, [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }]],
      [codexWork.instanceId, [{ slug: "work-model", name: "Work model" }]],
      [antigravity.instanceId, [{ slug: "gemini-4-neon", name: "Gemini 4 Neon" }]],
    ]);

    const options = workflowModelOptionsByProvider(byInstance, [codexWork, codex, antigravity]);

    expect(options.codex.map((option) => option.slug)).toEqual(["gpt-5-codex"]);
    expect(options.antigravity.map((option) => option.slug)).toEqual(["gemini-4-neon"]);
    expect(options.claudeAgent).toEqual([]);
    expect(options.pi).toEqual([]);
  });
});

describe("getSingleProviderModelOptions", () => {
  const modelOptions = {
    muse: { reasoningEffort: "high" },
    pi: { thinking: "medium" },
    opencode: { variant: "high", agent: "build" },
    antigravity: { thinking: "high" },
  } as const;

  it("keeps the options workflow dispatch applies", () => {
    expect(getSingleProviderModelOptions("pi", modelOptions)).toEqual({
      pi: { thinking: "medium" },
    });
    expect(getSingleProviderModelOptions("antigravity", modelOptions)).toEqual({
      antigravity: { thinking: "high" },
    });
  });

  it("drops OpenCode and Muse options, which workflow turns never apply", () => {
    for (const provider of ["opencode", "muse", "grok", "acp"] as const) {
      expect(workflowSlotAppliesModelOptions(provider)).toBe(false);
      expect(getSingleProviderModelOptions(provider, modelOptions)).toBeUndefined();
    }
  });
});

describe("normalizeWorkflowSlotModelOptions", () => {
  it("never stores Claude Ultracode, which workflow slots hide", () => {
    const capabilities = createClaudeModelCapabilities("claude-opus-4-7");
    expect(capabilities.optionDescriptors?.some((option) => option.id === "ultracode")).toBe(true);
    expect(
      normalizeWorkflowSlotModelOptions(
        "claudeAgent",
        "claude-opus-4-7",
        { claudeAgent: { effort: "max", ultracode: true } },
        capabilities,
      ),
    ).toEqual({ claudeAgent: { effort: "max" } });
    expect(
      normalizeWorkflowSlotModelOptions(
        "claudeAgent",
        "claude-opus-4-7",
        { claudeAgent: { ultracode: true } },
        capabilities,
      ),
    ).toBeUndefined();
  });
});
