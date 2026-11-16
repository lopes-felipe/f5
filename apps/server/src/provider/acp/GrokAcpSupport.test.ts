import { Effect } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it, vi } from "vitest";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  currentGrokModelIdFromSessionSetup,
  offeredAcpModelIds,
  resolveGrokAcpBaseModelId,
} from "./GrokAcpSupport.ts";

describe("GrokAcpSupport", () => {
  it("builds the Grok ACP stdio command with the OAuth referrer", () => {
    expect(
      buildGrokAcpSpawnInput({ binaryPath: "/opt/bin/grok" }, "/repo", {
        PATH: "/bin",
      }),
    ).toEqual({
      command: "/opt/bin/grok",
      args: ["agent", "stdio"],
      cwd: "/repo",
      env: {
        PATH: "/bin",
        GROK_OAUTH2_REFERRER: "t3code",
      },
    });
  });

  it("puts Supervised on the Grok argv so a config always-approve cannot skip prompts", () => {
    expect(buildGrokAcpSpawnInput(null, "/repo", undefined, "approval-required").args).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "stdio",
    ]);
    // The adapter answers full-access requests itself so computer use still reaches the user.
    expect(buildGrokAcpSpawnInput(null, "/repo", undefined, "full-access").args).toEqual([
      "agent",
      "stdio",
    ]);
  });

  it("falls back to the default Grok binary", () => {
    expect(buildGrokAcpSpawnInput(null, "/repo").command).toBe("grok");
  });

  it("normalizes ACP model ids with a Grok default", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId(" grok-build ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("xai/grok-custom")).toBe("xai/grok-custom");
  });

  it("sets the session model only when the requested model changes", async () => {
    const setSessionModel = vi.fn((_model: string) =>
      Effect.succeed({} satisfies EffectAcpSchema.SetSessionModelResponse),
    );

    await Effect.runPromise(
      applyGrokAcpModelSelection({
        runtime: { setSessionModel },
        currentModelId: "grok-build",
        requestedModelId: "grok-heavy",
        mapError: (error) => new Error(String(error)),
      }),
    );
    expect(setSessionModel).toHaveBeenCalledWith("grok-heavy");

    setSessionModel.mockClear();
    await Effect.runPromise(
      applyGrokAcpModelSelection({
        runtime: { setSessionModel },
        currentModelId: "grok-heavy",
        requestedModelId: "grok-heavy",
        mapError: (error) => new Error(String(error)),
      }),
    );
    expect(setSessionModel).not.toHaveBeenCalled();
    expect(
      await Effect.runPromise(
        applyGrokAcpModelSelection({
          runtime: { setSessionModel },
          currentModelId: "grok-heavy",
          requestedModelId: "grok-build",
          mapError: (error) => error,
        }),
      ),
    ).toBe("grok-heavy");
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  const conflictingSetup = {
    sessionId: "session-1",
    models: {
      currentModelId: "state-b",
      availableModels: [
        { modelId: "state-a", name: "A" },
        { modelId: "state-b", name: "B" },
      ],
    },
    configOptions: [
      {
        id: "llm",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "option-a",
        options: [
          { group: "main", name: "Main", options: [{ value: "option-a", name: "A" }] },
          { group: "more", name: "More", options: [{ value: "option-b", name: "B" }] },
        ],
      },
    ],
  } satisfies EffectAcpSchema.NewSessionResponse;

  it("reads the current model from the selector the runtime writes", () => {
    expect(currentGrokModelIdFromSessionSetup(conflictingSetup)).toBe("state-b");
    expect(currentGrokModelIdFromSessionSetup(conflictingSetup, "config-option")).toBe("option-a");
    expect(
      currentGrokModelIdFromSessionSetup(
        { ...conflictingSetup, configOptions: [] },
        "config-option",
      ),
    ).toBe("state-b");
    expect(offeredAcpModelIds(conflictingSetup)).toEqual(["option-a", "option-b"]);
    expect(offeredAcpModelIds({ ...conflictingSetup, configOptions: [] })).toEqual([
      "state-a",
      "state-b",
    ]);
    expect(offeredAcpModelIds({ sessionId: "session-1" })).toBeUndefined();
  });

  it("skips a startup model the agent no longer offers unless it is a custom model", async () => {
    const setSessionModel = vi.fn((_model: string) =>
      Effect.succeed({} satisfies EffectAcpSchema.SetSessionModelResponse),
    );
    const select = (requestedModelId: string, offered: ReadonlyArray<string> | undefined) =>
      Effect.runPromise(
        applyGrokAcpModelSelection({
          runtime: { setSessionModel },
          defaultModelId: "acp-default",
          currentModelId: "option-a",
          requestedModelId,
          availableModels: { offered, custom: ["my-custom"] },
          mapError: (error) => error,
        }),
      );
    expect(await select("expired", ["option-a", "option-b"])).toBe("option-a");
    expect(setSessionModel).not.toHaveBeenCalled();
    expect(await select("option-b", ["option-a", "option-b"])).toBe("option-b");
    expect(await select("my-custom", ["option-a"])).toBe("my-custom");
    expect(await select("unlisted", undefined)).toBe("unlisted");
    expect(setSessionModel.mock.calls.map(([model]) => model)).toEqual([
      "option-b",
      "my-custom",
      "unlisted",
    ]);
  });
});
