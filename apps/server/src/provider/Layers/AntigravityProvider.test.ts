import { Effect, Schema } from "effect";
import { AntigravitySettings } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import { checkAntigravityProviderStatus } from "./AntigravityProvider.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";

describe("Antigravity status", () => {
  it("defaults off and never probes or installs a disabled instance", async () => {
    const resolve = vi.spyOn(AntigravityInstallation.prototype, "resolve");
    const install = vi.spyOn(AntigravityInstallation.prototype, "install");
    try {
      const settings = Schema.decodeSync(AntigravitySettings)({});
      const snapshot = await Effect.runPromise(
        checkAntigravityProviderStatus(settings, "/not-created", "a"),
      );
      expect(snapshot.enabled).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
      install.mockRestore();
    }
  });
  it("uses discovered account models while retaining explicit custom models", async () => {
    const initial = await Effect.runPromise(
      checkAntigravityProviderStatus(Schema.decodeSync(AntigravitySettings)({}), "/missing", "a"),
    );
    const builtIn = { ...initial.models[0]!, slug: "native-account-model", name: "Native Model" };
    const snapshot = await Effect.runPromise(
      checkAntigravityProviderStatus(
        Schema.decodeSync(AntigravitySettings)({ customModels: ["custom-model"] }),
        "/missing",
        "a",
        [builtIn],
      ),
    );
    expect(snapshot.models.map((model) => model.slug)).toEqual([
      "native-account-model",
      "custom-model",
    ]);
  });
});
