import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createBuildConfig } from "./build-desktop-artifact.ts";

describe("desktop afterPack configuration", () => {
  it.each([
    ["linux", "AppImage", "linux-after-pack.cjs"],
    ["linux", "deb", "linux-after-pack.cjs"],
    ["win", "nsis", "verify-claude-runtime.cjs"],
    ["mac", "dmg", undefined],
  ] as const)("selects the hook for %s %s", async (platform, target, hook) => {
    const config = await Effect.runPromise(createBuildConfig(platform, target, "F5", false, false));
    if (hook === undefined) {
      expect(config).not.toHaveProperty("afterPack");
    } else {
      expect(config.afterPack).toBe(hook);
    }
  });
});
