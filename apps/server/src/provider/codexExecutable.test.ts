import { describe, expect, it } from "vitest";
import * as Path from "node:path";
import { CommandNotFoundError } from "../spawn/resolveCommand.ts";
import {
  isDefaultCodexBinary,
  resolveBundledCodexExecutable,
  resolveCodexCommand,
} from "./codexExecutable.ts";

describe("bundled Codex", () => {
  it.each([undefined, null, "", " ", "codex", " codex "])("uses bundled for %s", (value) => {
    expect(isDefaultCodexBinary(value)).toBe(true);
    expect(resolveCodexCommand(value)).toBe(resolveBundledCodexExecutable());
  });
  it("preserves a trimmed custom command", () => {
    expect(isDefaultCodexBinary("/custom/codex")).toBe(false);
    expect(resolveCodexCommand(" /custom/codex ")).toBe("/custom/codex");
  });
  it.each([
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["linux", "arm64", "aarch64-unknown-linux-musl"],
    ["linux", "x64", "x86_64-unknown-linux-musl"],
    ["win32", "arm64", "aarch64-pc-windows-msvc"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
  ] as const)("resolves %s-%s using its package manifest", (platform, arch, target) => {
    const executable = platform === "win32" ? "codex.exe" : "codex";
    const root = Path.join("/bundled", "@openai", "codex-" + platform + "-" + arch);
    expect(
      resolveBundledCodexExecutable(platform, arch, {
        resolve: (name) => {
          expect(name).toBe("@openai/codex-" + platform + "-" + arch + "/package.json");
          return Path.join(root, "package.json");
        },
        readFile: (file) => {
          expect(file).toBe(Path.join(root, "vendor", target, "codex-package.json"));
          return JSON.stringify({ layoutVersion: 1, target, entrypoint: "bin/" + executable });
        },
        fileExists: () => true,
        electron: false,
      }),
    ).toBe(Path.join(root, "vendor", target, "bin", executable));
  });
  it("requires an unpacked native executable in Electron", () => {
    const options = {
      resolve: () => Path.join("/F5", "app.asar", "node_modules", "codex", "package.json"),
      readFile: () =>
        JSON.stringify({
          layoutVersion: 1,
          target: "aarch64-apple-darwin",
          entrypoint: "bin/codex",
        }),
      electron: true,
    };
    expect(
      resolveBundledCodexExecutable("darwin", "arm64", {
        ...options,
        fileExists: (file) => file.includes("app.asar.unpacked"),
      }),
    ).toContain("app.asar.unpacked");
    expect(() =>
      resolveBundledCodexExecutable("darwin", "arm64", {
        ...options,
        fileExists: (file) => !file.includes("app.asar.unpacked"),
      }),
    ).toThrow(CommandNotFoundError);
  });
  it("reports missing dependencies and unsupported layouts with recovery instructions", () => {
    expect(() =>
      resolveBundledCodexExecutable("darwin", "arm64", {
        resolve: () => {
          throw new Error("missing");
        },
      }),
    ).toThrow("Reinstall F5");
    expect(() => resolveBundledCodexExecutable("linux", "ia32")).toThrow(
      "Set an absolute Binary path",
    );
    expect(() =>
      resolveBundledCodexExecutable("darwin", "arm64", {
        resolve: () => "/package.json",
        readFile: () => JSON.stringify({ layoutVersion: 2, entrypoint: "../codex" }),
      }),
    ).toThrow("Reinstall F5");
  });
});
