import { Effect } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it, vi } from "vitest";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
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
  });
});
