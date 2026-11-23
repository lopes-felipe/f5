import { describe, expect, it, vi } from "vitest";

import { resolveProviderOptionsForDispatch } from "./providerOptionsForDispatch";

const baseSettings = {
  claudeBinaryPath: "/opt/claude",
  claudeLaunchArgs: '--debug --header="x y"',
  claudeProjectSettings: {
    "project-1": {
      subagentsEnabled: false,
      subagentModel: "claude-haiku-4-5",
    },
  },
  codexBinaryPath: "/opt/codex",
  codexHomePath: "/tmp/codex-home",
};

describe("resolveProviderOptionsForDispatch", () => {
  it("resolves Codex process paths", () => {
    expect(
      resolveProviderOptionsForDispatch({
        settings: baseSettings,
        provider: "codex",
        projectId: "project-1",
        availableModels: [],
      }),
    ).toEqual({
      codex: { binaryPath: "/opt/codex", homePath: "/tmp/codex-home" },
    });
  });

  it("resolves Claude project settings and launch arguments", () => {
    expect(
      resolveProviderOptionsForDispatch({
        settings: baseSettings,
        provider: "claudeAgent",
        projectId: "project-1",
        availableModels: [{ slug: "claude-haiku-4-5" }],
      }),
    ).toEqual({
      claudeAgent: {
        binaryPath: "/opt/claude",
        subagentsEnabled: false,
        subagentModel: "claude-haiku-4-5",
        launchArgs: { debug: null, header: "x y" },
      },
    });
  });

  it("excludes invalid launch args and warns once per resolution", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const options = resolveProviderOptionsForDispatch({
      settings: { ...baseSettings, claudeLaunchArgs: '"unterminated' },
      provider: "claudeAgent",
      projectId: "project-1",
      availableModels: [],
    });

    expect(options?.claudeAgent).not.toHaveProperty("launchArgs");
    expect(options?.claudeAgent?.subagentModel).toBe("inherit");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
