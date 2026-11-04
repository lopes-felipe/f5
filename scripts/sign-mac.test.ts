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
