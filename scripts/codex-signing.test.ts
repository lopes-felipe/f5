import { createRequire } from "node:module";
import { expect, it } from "vitest";
import {
  CODEX_WINDOWS_SIGNING_EXCLUSIONS,
  CODEX_WINDOWS_VENDOR_EXECUTABLES,
  assertCodexWindowsSigningCoverage,
} from "./lib/codex-signing.ts";

it("blocks packaging when Codex adds an executable without a signing exclusion", () => {
  expect(() => assertCodexWindowsSigningCoverage(CODEX_WINDOWS_VENDOR_EXECUTABLES)).not.toThrow();
  expect(() => assertCodexWindowsSigningCoverage(["codex-resources/new-helper.exe"])).toThrow(
    "has no Windows signing exclusion",
  );
});

// Exercise the actual pinned builder's filtering, including its .exe fallback.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
builderRequire("app-builder-lib");
const { WinPackager } = builderRequire("app-builder-lib/out/winPackager.js") as {
  WinPackager: { prototype: { shouldSignFile(file: string, fallback?: boolean): boolean } };
};
const shouldSign = (file: string) =>
  WinPackager.prototype.shouldSignFile.call(
    { platformSpecificBuildOptions: { signExts: CODEX_WINDOWS_SIGNING_EXCLUSIONS } },
    file,
  );
it.each([
  "/stage/resources/app.asar.unpacked/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  "/stage/resources/app.asar.unpacked/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/codex-resources/voice/bin/codex-voice-host.exe",
])("preserves Codex upstream signatures for either path separator: %s", (file) => {
  expect(shouldSign(file)).toBe(false);
  expect(shouldSign(file.replaceAll("/", "\\"))).toBe(false);
});
it("continues signing F5 and other providers' executables", () => {
  expect(shouldSign("/stage/F5.exe")).toBe(true);
  expect(shouldSign("/stage/resources/another-provider/rg.exe")).toBe(true);
  expect(shouldSign("/stage/resources/native/f5-computer-helper.exe")).toBe(true);
});
