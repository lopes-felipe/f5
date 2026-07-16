import * as NodeServices from "@effect/platform-node/NodeServices";
import { GrokSettings } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { checkGrokProviderStatus } from "./GrokProvider.ts";

describe("checkGrokProviderStatus", () => {
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
