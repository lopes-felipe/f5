import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { AppSettingsSchema } from "../appSettings";
import { mergeSettings, splitSettingsPatch } from "./useSettings";

describe("settings routing", () => {
  it("round-trips every AppSettingsSchema field through split and merge", () => {
    const appSettings = AppSettingsSchema.makeUnsafe({});
    const completeAppSettings = { ...appSettings, textGenerationModel: "test-model" };
    const appKeys = Object.keys(AppSettingsSchema.fields).sort();

    const { appPatch } = splitSettingsPatch(completeAppSettings);
    const merged = mergeSettings({ ...appSettings, ...appPatch }, DEFAULT_SERVER_SETTINGS);

    expect(Object.keys(appPatch).sort()).toEqual(appKeys);
    for (const key of appKeys) {
      expect(merged[key as keyof typeof merged]).toEqual(
        completeAppSettings[key as keyof typeof completeAppSettings],
      );
    }
  });

  it("routes legacy overlapping keys only to the authoritative app-settings store", () => {
    const patch = {
      addProjectBaseDirectory: "/workspace",
      defaultThreadEnvMode: "worktree" as const,
      enableAssistantStreaming: true,
    };
    expect(splitSettingsPatch(patch)).toEqual({ serverPatch: {}, appPatch: patch });
  });
});
