import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildProviderInstanceUpdatePatch,
  mergeLegacyProviderOverrides,
} from "./SettingsPanels.logic";

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("mergeLegacyProviderOverrides", () => {
  const codex = ProviderDriverKind.make("codex");

  it("copies legacy paths and models into an empty instance", () => {
    const result = mergeLegacyProviderOverrides(
      { driver: codex, enabled: true },
      { binaryPath: " /opt/codex ", homePath: "~/.codex-work", customModels: ["gpt-x", " "] },
    );
    expect(result.skipped).toEqual([]);
    expect(result.instance.config).toEqual({
      binaryPath: "/opt/codex",
      homePath: "~/.codex-work",
      customModels: ["gpt-x"],
    });
  });

  it("overwrites decoded driver defaults on a never-edited default instance", () => {
    for (const driver of ["codex", "claudeAgent"] as const) {
      const result = mergeLegacyProviderOverrides(
        {
          driver: ProviderDriverKind.make(driver),
          enabled: true,
          config: DEFAULT_SERVER_SETTINGS.providers[driver],
        },
        { binaryPath: "/opt/homebrew/bin/custom", launchArgs: "--chrome" },
      );
      expect(result.skipped, driver).toEqual([]);
      expect(result.instance.config, driver).toMatchObject({
        binaryPath: "/opt/homebrew/bin/custom",
        launchArgs: "--chrome",
      });
    }
  });

  it("keeps instance values that differ and merges custom models without duplicates", () => {
    const result = mergeLegacyProviderOverrides(
      {
        driver: codex,
        config: { binaryPath: "/usr/bin/codex", customModels: ["a", { slug: "b" }], extra: 1 },
      },
      { binaryPath: "/opt/codex", launchArgs: "--x", customModels: ["b", "c"] },
    );
    expect(result.skipped).toEqual(["binaryPath"]);
    expect(result.instance.config).toEqual({
      binaryPath: "/usr/bin/codex",
      launchArgs: "--x",
      customModels: ["a", { slug: "b" }, "c"],
      extra: 1,
    });
  });
});
