import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import * as Path from "node:path";
import { isAsarExecutablePath, resolveAsarExecutablePath } from "../spawn/asarExecutable.ts";
import { CommandNotFoundError } from "../spawn/resolveCommand.ts";
import { isDefaultProviderBinary } from "@t3tools/shared/providerBinary";

export const CODEX_PACKAGE_MANAGER_ENV_NAMES = [
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_BY_BUN",
  "CODEX_MANAGED_BY_PNPM",
  "CODEX_MANAGED_PACKAGE_ROOT",
] as const;

export function stripCodexManagedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !(CODEX_PACKAGE_MANAGER_ENV_NAMES as readonly string[]).includes(key.toUpperCase()),
    ),
  );
}

const TARGETS: Readonly<Record<string, string>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};
let cachedBundledExecutable: string | undefined;

export function isDefaultCodexBinary(binaryPath: string | null | undefined): boolean {
  return isDefaultProviderBinary(binaryPath, "codex");
}

export function resolveBundledCodexExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  options: {
    readonly resolve?: (specifier: string) => string;
    readonly readFile?: (file: string) => string;
    readonly fileExists?: (file: string) => boolean;
    readonly electron?: boolean;
  } = {},
): string {
  const fileExists =
    options.fileExists ??
    ((file: string) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  const electron = options.electron ?? Boolean(process.versions.electron);
  const cacheable =
    platform === process.platform && arch === process.arch && Object.keys(options).length === 0;
  if (cacheable && cachedBundledExecutable && fileExists(cachedBundledExecutable))
    return cachedBundledExecutable;
  const target = TARGETS[platform + "-" + arch];
  if (!target)
    throw new CommandNotFoundError(
      "codex",
      "Command not found: codex. F5 has no bundled Codex for " +
        platform +
        "-" +
        arch +
        ". Set an absolute Binary path to your own Codex executable in Settings > Providers.",
    );
  try {
    // CJS bundlers rewrite import.meta.url using require("url"); do not shadow it.
    const moduleRequire = createRequire(import.meta.url);
    const resolve =
      options.resolve ?? createRequire(moduleRequire.resolve("@openai/codex/package.json")).resolve;
    const root = Path.dirname(resolve("@openai/codex-" + platform + "-" + arch + "/package.json"));
    const vendor = Path.join(root, "vendor", target);
    const manifest = JSON.parse(
      (options.readFile ?? ((file) => readFileSync(file, "utf8")))(
        Path.join(vendor, "codex-package.json"),
      ),
    ) as { layoutVersion?: unknown; target?: unknown; entrypoint?: unknown };
    if (
      manifest.layoutVersion !== 1 ||
      manifest.target !== target ||
      typeof manifest.entrypoint !== "string" ||
      !/^bin\/codex(?:\.exe)?$/.test(manifest.entrypoint)
    )
      throw new Error("Unsupported Codex package layout.");
    const executable = resolveAsarExecutablePath(Path.join(vendor, manifest.entrypoint), {
      electron,
      fileExists,
    });
    if ((!electron || !isAsarExecutablePath(executable)) && fileExists(executable)) {
      if (cacheable) cachedBundledExecutable = executable;
      return executable;
    }
  } catch {
    // Missing optional packages and unsupported layouts have the same recovery path.
  }
  throw new CommandNotFoundError(
    "codex",
    "Command not found: codex. Bundled Codex executable for " +
      platform +
      "-" +
      arch +
      " is unavailable or not unpacked. Reinstall F5 or dependencies with optional packages enabled, or set an absolute Binary path to your own Codex executable.",
  );
}

export function resolveCodexCommand(binaryPath?: string | null): string {
  return isDefaultCodexBinary(binaryPath) ? resolveBundledCodexExecutable() : binaryPath!.trim();
}
