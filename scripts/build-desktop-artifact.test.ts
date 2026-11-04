import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { CODEX_PROTOCOL_BASELINE_VERSION } from "@t3tools/shared/codexProtocolManifest";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import { createBuildConfig, DESKTOP_ASAR_UNPACK } from "./build-desktop-artifact.ts";

it("bundles the audited Codex version and unpacks its native platform packages", () => {
  expect(serverPackageJson.dependencies["@openai/codex"]).toBe(CODEX_PROTOCOL_BASELINE_VERSION);
  expect(DESKTOP_ASAR_UNPACK).toContain("node_modules/@openai/codex-*/**/*");
});

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
