import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  getSingleProviderModelOptions,
  workflowModelOptionsByProvider,
  workflowPickerProviders,
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
  it("keeps Muse and Pi options so their traits survive submission", () => {
    const modelOptions = {
      muse: { reasoningEffort: "high" },
      pi: { thinking: "medium" },
    } as const;
    expect(getSingleProviderModelOptions("muse", modelOptions)).toEqual({
      muse: { reasoningEffort: "high" },
    });
    expect(getSingleProviderModelOptions("pi", modelOptions)).toEqual({
      pi: { thinking: "medium" },
    });
    expect(getSingleProviderModelOptions("grok", modelOptions)).toBeUndefined();
  });
});
