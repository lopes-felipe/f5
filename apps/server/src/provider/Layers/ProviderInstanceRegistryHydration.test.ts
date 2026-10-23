import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import {
  deriveProviderInstanceConfigMap,
  deriveRuntimeProviderInstanceConfigMap,
} from "./ProviderInstanceRegistryHydration.ts";

describe("project provider runtime hydration", () => {
  it("activates a globally disabled runtime for an explicit project while preserving global configuration", () => {
    const id = ProviderInstanceId.make("antigravity"),
      projectId = ProjectId.makeUnsafe("runtime-policy");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [id]: { enabled: true } } },
      },
    };
    const global = deriveProviderInstanceConfigMap(settings);
    const runtime = deriveRuntimeProviderInstanceConfigMap(settings);
    expect(global[id]?.config).toMatchObject({ enabled: false });
    expect(global[id]?.enabled).toBeUndefined();
    expect(runtime[id]?.enabled).toBe(true);
    expect(runtime[id]?.config).toEqual({
      ...DEFAULT_SERVER_SETTINGS.providers.antigravity,
      enabled: true,
    });
    const globallyOn = {
      ...settings,
      providers: {
        ...settings.providers,
        antigravity: { ...settings.providers.antigravity, enabled: true },
      },
    };
    expect(deriveRuntimeProviderInstanceConfigMap(globallyOn)[id]).toEqual(runtime[id]);
    expect(
      deriveRuntimeProviderInstanceConfigMap({ ...settings, projectSettingsOverrides: {} })[id]
        ?.enabled,
    ).toBe(false);
    expect(DEFAULT_SERVER_SETTINGS.providers.antigravity.enabled).toBe(false);
  });
});

it("creates Pi runtimes only for explicit instance settings", () => {
  expect(
    Object.values(deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS)).some(
      (entry) => entry.driver === "pi",
    ),
  ).toBe(false);
  const id = ProviderInstanceId.make("pi_work");
  const explicit = {
    driver: ProviderDriverKind.make("pi"),
    enabled: false,
    config: { binaryPath: "pi", launchArgs: "", customModels: [] },
  };
  expect(
    deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [id]: explicit },
    })[id],
  ).toEqual(explicit);
});
