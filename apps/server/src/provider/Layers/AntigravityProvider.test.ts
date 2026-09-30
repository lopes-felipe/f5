import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityProfileDirectory } from "../acp/AntigravityAcpSupport.ts";
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

it("checks the custom instance's account instead of the default instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-agy-custom-status-"));
  const resolve = vi.spyOn(AntigravityInstallation.prototype, "resolve").mockResolvedValue({
    executablePath: "/synthetic/agent",
    harnessPath: "/synthetic/harness",
    version: "1.1.1",
  });
  try {
    const account = join(antigravityProfileDirectory(root, "custom-account"), "antigravity-acp");
    await mkdir(account, { recursive: true });
    await writeFile(join(account, "acp_token.json"), '{"token":"synthetic"}');
    const settings = Schema.decodeSync(AntigravitySettings)({ enabled: true });
    const custom = await Effect.runPromise(
      checkAntigravityProviderStatus(settings, root, "custom-account"),
    );
    const defaultAccount = await Effect.runPromise(
      checkAntigravityProviderStatus(settings, root, "antigravity"),
    );
    expect(custom.auth.status).toBe("authenticated");
    expect(defaultAccount.auth.status).toBe("unauthenticated");
  } finally {
    resolve.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
