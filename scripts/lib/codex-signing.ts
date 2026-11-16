// electron-builder signs unpacked .exe files even with Azure Trusted Signing.
// Its signExts exclusions are literal suffixes, not globs. Scope these to the
// pinned Codex platform packages so other providers and F5 are still signed.
export const CODEX_WINDOWS_VENDOR_EXECUTABLES = [
  "bin/codex.exe",
  "bin/codex-code-mode-host.exe",
  "codex-path/rg.exe",
  "codex-resources/codex-command-runner.exe",
  "codex-resources/codex-windows-sandbox-setup.exe",
  "codex-resources/voice/bin/codex-voice-host.exe",
] as const;

/** Fail afterPack before Azure can re-sign any newly added vendor executable. */
export function assertCodexWindowsSigningCoverage(files: readonly string[]): void {
  const covered = new Set<string>(CODEX_WINDOWS_VENDOR_EXECUTABLES);
  for (const file of files) {
    const relative = file.replaceAll("\\", "/");
    if (/\.exe$/i.test(relative) && !covered.has(relative))
      throw new Error("Codex vendor executable has no Windows signing exclusion: " + relative);
  }
}

export const CODEX_WINDOWS_SIGNING_EXCLUSIONS = (
  [
    ["x64", "x86_64"],
    ["arm64", "aarch64"],
  ] as const
).flatMap(([arch, tripleArch]) =>
  CODEX_WINDOWS_VENDOR_EXECUTABLES.flatMap((file) => {
    const suffix =
      "/node_modules/@openai/codex-win32-" +
      arch +
      "/vendor/" +
      tripleArch +
      "-pc-windows-msvc/" +
      file;
    return ["!" + suffix, "!" + suffix.replaceAll("/", "\\")];
  }),
);
