import { matchesGlob } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { CODEX_PROTOCOL_BASELINE_VERSION } from "@t3tools/shared/codexProtocolManifest";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import {
  createBuildConfig,
  DESKTOP_ASAR_UNPACK,
  resolveMacFileExclusions,
} from "./build-desktop-artifact.ts";

it("builds Debian and AppImage installers together without changing other targets", async () => {
  const config = await Effect.runPromise(
    createBuildConfig("linux", "AppImage", "F5", false, false),
  );
  expect(config.linux).toMatchObject({ target: ["AppImage", "deb"], maintainer: "Felipe Lopes" });
  expect(config.deb).toHaveProperty("depends", expect.arrayContaining(["libnss3", "xdg-utils"]));
  const deb = await Effect.runPromise(createBuildConfig("linux", "deb", "F5", false, false));
  expect(deb.linux).toHaveProperty("target", ["deb"]);
});

it("excludes unused Darwin natives across all packages, preserving universal builds", async () => {
  for (const arch of ["arm64", "x64", "universal"] as const) {
    const config = await Effect.runPromise(
      createBuildConfig("mac", "dmg", "F5", false, false, arch),
    );
    expect(config.mac).toHaveProperty("files", ["**/*", ...resolveMacFileExclusions(arch)]);
    for (const pkg of ["node-pty", "objc-js"]) {
      for (const nativeArch of ["arm64", "x64"]) {
        const file = `node_modules/${pkg}/prebuilds/darwin-${nativeArch}/binary.node`;
        expect(
          resolveMacFileExclusions(arch).some((glob) => matchesGlob(file, glob.slice(1))),
        ).toBe(arch !== "universal" && arch !== nativeArch);
      }
    }
  }
});

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
