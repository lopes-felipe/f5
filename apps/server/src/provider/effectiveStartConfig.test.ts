import { describe, expect, it } from "vitest";

import { resolveEffectiveStartConfig } from "./effectiveStartConfig.ts";
import { readPersistedStartConfig } from "./runtimePayload.ts";

describe("resolveEffectiveStartConfig", () => {
  it("uses command, memory, persisted, then none precedence per dimension", () => {
    const persisted = readPersistedStartConfig({
      startConfig: {
        providerOptions: { claudeAgent: { permissionMode: "persisted" } },
        modelOptions: { claudeAgent: { effort: "high" } },
        model: "persisted-model",
      },
    });

    expect(
      resolveEffectiveStartConfig({
        command: { model: "command-model" },
        memory: {
          providerOptions: { claudeAgent: { permissionMode: "memory" } },
        },
        persisted,
      }),
    ).toEqual({
      providerOptions: { claudeAgent: { permissionMode: "memory" } },
      modelOptions: { claudeAgent: { effort: "high" } },
      model: "command-model",
      providerOptionsSource: "memory",
      modelOptionsSource: "persisted",
      modelSource: "command",
    });
  });

  it("treats persisted null as known-empty instead of falling through", () => {
    const persisted = readPersistedStartConfig({
      startConfig: {
        providerOptions: null,
        modelOptions: null,
        model: null,
      },
    });

    expect(resolveEffectiveStartConfig({ persisted })).toEqual({
      providerOptions: undefined,
      modelOptions: undefined,
      model: undefined,
      providerOptionsSource: "persisted",
      modelOptionsSource: "persisted",
      modelSource: "persisted",
    });
  });

  it("reports absent dimensions as none without inventing values", () => {
    expect(resolveEffectiveStartConfig({})).toEqual({
      providerOptions: undefined,
      modelOptions: undefined,
      model: undefined,
      providerOptionsSource: "none",
      modelOptionsSource: "none",
      modelSource: "none",
    });
  });

  it("reads legacy top-level provider options and model", () => {
    const persisted = readPersistedStartConfig({
      providerOptions: { claudeAgent: { subagentsEnabled: false } },
      model: "legacy-model",
    });

    expect(resolveEffectiveStartConfig({ persisted })).toMatchObject({
      providerOptions: { claudeAgent: { subagentsEnabled: false } },
      model: "legacy-model",
      providerOptionsSource: "persisted",
      modelSource: "persisted",
    });
  });
});
