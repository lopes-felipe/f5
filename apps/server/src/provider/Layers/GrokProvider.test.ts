import * as NodeServices from "@effect/platform-node/NodeServices";
import { GrokSettings } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { checkGrokProviderStatus, parseGrokModelsCliOutput } from "./GrokProvider.ts";

describe("checkGrokProviderStatus", () => {
  it("reads native login and models output without assuming exit zero means authenticated", () => {
    expect(parseGrokModelsCliOutput("You are not logged in.\nRun grok login").authenticated).toBe(
      false,
    );
    expect(parseGrokModelsCliOutput("Available models:\n - grok-4.6").authenticated).toBe(null);
    const result = parseGrokModelsCliOutput(
      "You are logged in with grok.com.\nDefault model: grok-4.6\nAvailable models:\n * grok-4.6 (default)\n - grok-4.5\n - grok-4.6\n - arbitrary help text",
    );
    expect(result.authenticated).toBe(true);
    expect(result.models.map((model) => model.slug)).toEqual(["grok-4.6", "grok-4.5"]);
  });
  it("does not probe a disabled provider", async () => {
    const settings = Schema.decodeSync(GrokSettings)({
      enabled: false,
      binaryPath: "/definitely/missing/f5-grok",
    });
    const provider = await Effect.runPromise(
      checkGrokProviderStatus(settings, {}).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(provider.enabled).toBe(false);
    expect(provider.status).toBe("disabled");
  });
  it("reports a missing binary as unavailable", async () => {
    const settings = Schema.decodeSync(GrokSettings)({
      enabled: true,
      binaryPath: "/definitely/missing/f5-grok",
      customModels: [],
    });
    const provider = await Effect.runPromise(
      checkGrokProviderStatus(settings, { PATH: "" }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(provider.status).toBe("error");
    expect(provider.installed).toBe(false);
    expect(provider.message).toBe("Grok CLI (`grok`) is not installed or not on PATH.");
  });
});
