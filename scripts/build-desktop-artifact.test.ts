import { matchesGlob } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEVELOPMENT_ICON_OVERRIDES, PUBLISH_ICON_OVERRIDES } from "./lib/brand-assets";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { CODEX_PROTOCOL_BASELINE_VERSION } from "@t3tools/shared/codexProtocolManifest";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import {
  createBuildConfig,
  DESKTOP_ASAR_UNPACK,
  EXTRA_RESOURCE_EXCLUSIONS,
  resolveMacFileExclusions,
  stageProductionWebIcons,
} from "./build-desktop-artifact.ts";

it("stages production web icons when reusing a development server bundle", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const stage = await mkdtemp(join(tmpdir(), "f5-production-web-icons-"));
  try {
    await mkdir(join(stage, "dist/client"), { recursive: true });
    for (const icon of DEVELOPMENT_ICON_OVERRIDES)
      await copyFile(join(root, icon.sourceRelativePath), join(stage, icon.targetRelativePath));
    await Effect.runPromise(
      stageProductionWebIcons(root, stage).pipe(Effect.provide(NodeServices.layer)),
    );
    for (const icon of PUBLISH_ICON_OVERRIDES)
      expect(await readFile(join(stage, icon.targetRelativePath))).toEqual(
        await readFile(join(root, icon.sourceRelativePath)),
      );
    expect(await readFile(join(stage, "dist/client/favicon.ico"))).not.toEqual(
      await readFile(join(root, "assets/dev/blueprint-web-favicon.ico")),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

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
    expect(config.mac).toHaveProperty("files", [
      "**/*",
      ...EXTRA_RESOURCE_EXCLUSIONS,
      ...resolveMacFileExclusions(arch),
    ]);
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

it("keeps the native helper, Lima and the VM pin out of app.asar", async () => {
  const excluded = (file: string) =>
    EXTRA_RESOURCE_EXCLUSIONS.some((glob) => matchesGlob(file, glob.slice(1)));
  for (const file of [
    "apps/desktop/native-bin/f5-computer-helper",
    "apps/desktop/native-bin/f5-computer-helper.exe",
    "apps/desktop/native-bin/lima/bin/limactl",
    "apps/desktop/native-bin/lima/share/lima/templates/default.yaml",
    "apps/desktop/vm-bin/linux-arm64-backend.json",
  ])
    expect(excluded(file), file).toBe(true);
  expect(excluded("apps/desktop/dist-electron/main.js")).toBe(false);
  const win = await Effect.runPromise(createBuildConfig("win", "nsis", "F5", false, false, "x64"));
  expect(win.win).toHaveProperty("files", ["**/*", ...EXTRA_RESOURCE_EXCLUSIONS]);
});

it("signs limactl and carries the VM backend pin only in macOS arm64 builds", async () => {
  const arm64 = (await Effect.runPromise(
    createBuildConfig("mac", "dmg", "F5", false, false, "arm64", undefined, true),
  )) as { mac: { binaries: string[] }; extraResources: Array<{ from: string; to: string }> };
  expect(arm64.mac.binaries).toContain("Contents/Resources/native/lima/bin/limactl");
  expect(arm64.extraResources).toContainEqual({ from: "apps/desktop/vm-bin", to: "vm" });

  const withoutPin = (await Effect.runPromise(
    createBuildConfig("mac", "dmg", "F5", false, false, "arm64"),
  )) as { extraResources: Array<{ from: string }> };
  expect(withoutPin.extraResources.map((entry) => entry.from)).toEqual(["apps/desktop/native-bin"]);

  for (const arch of ["x64", "universal"] as const) {
    const config = (await Effect.runPromise(
      createBuildConfig("mac", "dmg", "F5", false, false, arch),
    )) as { mac: { binaries: string[] } };
    expect(config.mac.binaries).toEqual(["Contents/Resources/native/f5-computer-helper"]);
    await expect(
      Effect.runPromise(createBuildConfig("mac", "dmg", "F5", false, false, arch, undefined, true)),
    ).rejects.toThrow(/Only macOS arm64/);
  }
});

it("bundles the audited Codex version and unpacks its native platform packages", () => {
  expect(serverPackageJson.dependencies["@openai/codex"]).toBe(CODEX_PROTOCOL_BASELINE_VERSION);
  expect(DESKTOP_ASAR_UNPACK).toContain("node_modules/@openai/codex-*/**/*");
});

// One-way: a build without the fuse cannot read cookies a build with it wrote. Changing a row
// that is true to false destroys every affected user's cookies; changing false to true is a
// deliberate rollout that needs its own packaged upgrade test.
describe("cookie encryption fuse", () => {
  it.each([
    ["win", "nsis", true, true],
    ["win", "nsis", false, true],
    ["mac", "dmg", true, true],
    ["mac", "dmg", false, false],
    ["linux", "AppImage", true, false],
    ["linux", "deb", false, false],
  ] as const)("on %s %s (signed: %s) is %s", async (platform, target, signed, enabled) => {
    // Signed builds validate that their credentials are present; the values are never used.
    for (const name of [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
    ])
      vi.stubEnv(name, "test");
    try {
      const config = (await Effect.runPromise(
        createBuildConfig(platform, target, "F5", signed, false),
      )) as { electronFuses: { enableCookieEncryption: boolean } };
      expect(config.electronFuses.enableCookieEncryption).toBe(enabled);
    } finally {
      vi.unstubAllEnvs();
    }
  });
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
