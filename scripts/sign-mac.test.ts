import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { preserveCodexVendorSignature } = require("./sign-mac.cjs") as {
  preserveCodexVendorSignature(file: string): boolean;
};
it.each([
  "/F5.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
  "/F5.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/codex-path/rg",
  String.raw`C:\F5\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`,
])("preserves the upstream signature of Codex vendor files: %s", (file) => {
  expect(preserveCodexVendorSignature(file)).toBe(true);
});
it.each([
  "/F5.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
  "/F5.app/Contents/Resources/native/f5-computer-helper",
  "/F5.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/package.json",
  "/F5.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor-other/bin/codex",
])("keeps F5 signing enabled outside the Codex vendor directory: %s", (file) => {
  expect(preserveCodexVendorSignature(file)).toBe(false);
});
const { perFileOptions } = require("./sign-mac.cjs") as {
  perFileOptions(
    options: { optionsForFile(file: string): { entitlements: string } },
    file: string,
  ): { entitlements: string };
};
it("gives the Swift helper a minimal entitlement file while preserving Electron JIT entitlements", () => {
  const options = { optionsForFile: () => ({ entitlements: "electron-jit.plist" }) };
  const swift = perFileOptions(options, "/F5.app/Contents/Resources/native/f5-computer-helper");
  expect(readFileSync(swift.entitlements, "utf8")).not.toContain("<key>");
  expect(perFileOptions(options, "/F5.app/Contents/Frameworks/F5 Helper.app").entitlements).toBe(
    "electron-jit.plist",
  );
  const main = readFileSync(
    new URL("../apps/desktop/resources/entitlements.mac.plist", import.meta.url),
    "utf8",
  );
  expect(main).not.toContain("disable-library-validation");
  expect(main).not.toContain("allow-unsigned-executable-memory");
});
it("signs the bundled limactl with hardened runtime and only the virtualization entitlement", () => {
  const options = { optionsForFile: () => ({ entitlements: "electron-jit.plist" }) };
  const lima = perFileOptions(options, "/F5.app/Contents/Resources/native/lima/bin/limactl") as {
    entitlements: string;
    hardenedRuntime?: boolean;
  };
  expect(lima.hardenedRuntime).toBe(true);
  const keys = [...readFileSync(lima.entitlements, "utf8").matchAll(/<key>([^<]+)<\/key>/g)].map(
    (match) => match[1],
  );
  expect(keys).toEqual(["com.apple.security.virtualization"]);
  // Lima's other files (the Linux guest agent, templates) keep the app's defaults.
  expect(
    perFileOptions(
      options,
      "/F5.app/Contents/Resources/native/lima/share/lima/lima-guestagent.Linux-aarch64.gz",
    ).entitlements,
  ).toBe("electron-jit.plist");
});
const { signWithRetry } = require("./sign-mac.cjs") as {
  signWithRetry(
    sign: (options: object) => Promise<void>,
    options: object,
    delay: (ms: number) => Promise<void>,
  ): Promise<void>;
};
it("retries a missing timestamp once using the same application and signing options", async () => {
  const options = { app: "/fixture/F5.app", identity: "fixture", timestamp: true };
  const sign = vi
    .fn()
    .mockRejectedValueOnce(
      new Error(
        "codesign --timestamp --entitlements apps/desktop/resources/entitlements.electron-inherit.plist F5.app\nA timestamp was expected but was not found.",
      ),
    )
    .mockResolvedValueOnce(undefined);
  const delay = vi.fn().mockResolvedValue(undefined);
  await signWithRetry(sign, options, delay);
  expect(sign.mock.calls).toEqual([[options], [options]]);
  expect(delay).toHaveBeenCalledExactlyOnceWith(5000);
});
it.each(["certificate expired", "invalid signature", "entitlement invalid", "verification failed"])(
  "never retries %s",
  async (detail) => {
    const sign = vi.fn().mockRejectedValue(new Error(detail));
    const delay = vi.fn();
    await expect(signWithRetry(sign, {}, delay)).rejects.toThrow(detail);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  },
);
it("blocks a persistent timestamp failure after one retry", async () => {
  const sign = vi.fn().mockRejectedValue(new Error("A timestamp was expected but was not found."));
  await expect(signWithRetry(sign, {}, async () => {})).rejects.toThrow("timestamp");
  expect(sign).toHaveBeenCalledTimes(2);
});
it.each([
  "The timestamp service is not available.",
  "timestamp server unavailable",
  "timestamp service timed out",
  "timestamp server ECONNRESET",
  "timestamp service HTTP 503",
])("retries the recognized timestamp failure once: %s", async (detail) => {
  const options = { app: "/fixture/F5.app", timestamp: true };
  const sign = vi.fn().mockRejectedValueOnce(new Error(detail)).mockResolvedValueOnce(undefined);
  const delay = vi.fn().mockResolvedValue(undefined);
  await signWithRetry(sign, options, delay);
  expect(sign.mock.calls).toEqual([[options], [options]]);
  expect(delay).toHaveBeenCalledExactlyOnceWith(5000);
});

const { signingIgnore } = require("./sign-mac.cjs") as {
  signingIgnore(options: { ignore?: unknown }): (file: string) => boolean;
};
const app = "/out/mac-arm64/F5.app";
const dockTile = `${app}/Contents/PlugIns/F5DockTile.docktileplugin`;
// electron-builder 26's default rule (MacTargetHelper.js): skip all of Contents/PlugIns.
const electronBuilderIgnore = (file: string) =>
  file.endsWith(".kext") || file.startsWith("/Contents/PlugIns", app.length);

it("signs the Dock tile plug-in's executable despite electron-builder skipping PlugIns", () => {
  const ignore = signingIgnore({ ignore: electronBuilderIgnore });
  expect(ignore(`${dockTile}/Contents/MacOS/F5DockTile`)).toBe(false);
  // The bundle signature seals the plug-in's images; other plug-ins stay skipped.
  expect(ignore(`${dockTile}/Contents/Resources/classic.png`)).toBe(true);
  expect(ignore(`${app}/Contents/PlugIns/Other.appex/Contents/MacOS/Other`)).toBe(true);
  expect(ignore(`${app}/Contents/Resources/driver.kext`)).toBe(true);
  expect(ignore(`${app}/Contents/MacOS/F5`)).toBe(false);
  expect(
    ignore(
      `${app}/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`,
    ),
  ).toBe(true);
});

it("keeps applying an ignore list given as patterns", () => {
  const ignore = signingIgnore({ ignore: [/\.kext$/, (file: string) => file.includes("/skip/")] });
  expect(ignore(`${app}/Contents/Resources/driver.kext`)).toBe(true);
  expect(ignore(`${app}/Contents/skip/tool`)).toBe(true);
  expect(ignore(`${app}/Contents/MacOS/F5`)).toBe(false);
  expect(signingIgnore({})(`${app}/Contents/MacOS/F5`)).toBe(false);
});

it("signs the Dock tile plug-in with hardened runtime and no entitlements", () => {
  const options = { optionsForFile: () => ({ entitlements: "electron-jit.plist" }) };
  const plugIn = perFileOptions(options, `${dockTile}/Contents/MacOS/F5DockTile`) as {
    entitlements: string;
    hardenedRuntime?: boolean;
  };
  expect(plugIn.hardenedRuntime).toBe(true);
  expect(readFileSync(plugIn.entitlements, "utf8")).not.toContain("<key>");
});
