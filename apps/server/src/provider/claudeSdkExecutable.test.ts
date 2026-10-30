import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CommandNotFoundError } from "../spawn/resolveCommand.ts";
import {
  resolveBundledClaudeExecutable,
  resolveClaudeCliInvocation,
  resolveClaudeSdkExecutableOptions,
} from "./claudeSdkExecutable.ts";

describe("Claude SDK executable resolution", () => {
  it.each([undefined, null, "", " ", "claude", " claude "])(
    "uses the bundled executable for the default SDK setting %s",
    (setting) => {
      expect(resolveClaudeSdkExecutableOptions(setting)).toEqual({
        pathToClaudeCodeExecutable: resolveBundledClaudeExecutable(),
      });
    },
  );

  it("uses the same executable for SDK sessions and CLI probes", () => {
    expect(resolveClaudeSdkExecutableOptions(undefined).pathToClaudeCodeExecutable).toBe(
      resolveClaudeCliInvocation(undefined, ["--version"], { PATH: "" }).file,
    );
  });

  it("preserves explicit native ASAR-named directories outside Electron", () => {
    expect(
      resolveClaudeSdkExecutableOptions(
        "/F5.app/Contents/Resources/app.asar/bin/claude",
        {},
        "darwin",
      ),
    ).toEqual({
      pathToClaudeCodeExecutable: "/F5.app/Contents/Resources/app.asar/bin/claude",
    });
  });

  it("resolves an unpacked Windows executable using a real filesystem fixture", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "f5-claude-sdk-"));
    const executable = path.join(directory, "app.asar.unpacked", "bin", "claude.exe");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "");
    expect(resolveClaudeSdkExecutableOptions(executable, {}, "win32")).toEqual({
      pathToClaudeCodeExecutable: executable,
    });
  });

  it.each([true, false])("matches SDK Linux candidate order (preferMusl=%s)", (preferMusl) => {
    const resolve = vi.fn((specifier: string) => `/bundled/${specifier}`);
    const executable = resolveBundledClaudeExecutable("linux", "x64", {
      preferMusl,
      resolve,
      fileExists: () => true,
      electron: false,
    });
    expect(executable).toBe(
      `/bundled/@anthropic-ai/claude-agent-sdk-linux-x64${preferMusl ? "-musl" : ""}/claude`,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("falls back to the other Linux variant (preferMusl=%s)", (preferMusl) => {
    const resolve = vi.fn((specifier: string) => `/bundled/${specifier}`);
    const executable = resolveBundledClaudeExecutable("linux", "arm64", {
      preferMusl,
      resolve,
      fileExists: (file) => file.includes("-musl/") !== preferMusl,
      electron: false,
    });
    expect(executable).toBe(
      `/bundled/@anthropic-ai/claude-agent-sdk-linux-arm64${preferMusl ? "" : "-musl"}/claude`,
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("requires the bundled Electron executable to exist outside ASAR", () => {
    const executable = "/F5.app/Contents/Resources/app.asar/bin/claude";
    const unpacked = executable.replace("app.asar/", "app.asar.unpacked/");
    const options = {
      resolve: () => executable,
      electron: true,
      fileExists: (file: string) => file === unpacked,
    };
    expect(resolveBundledClaudeExecutable("darwin", "arm64", options)).toBe(unpacked);
    expect(() =>
      resolveBundledClaudeExecutable("darwin", "arm64", {
        ...options,
        fileExists: (file) => file === executable,
      }),
    ).toThrow(CommandNotFoundError);
  });

  it("ignores PATH-installed Windows shims for the default setting on every host", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "f5-claude-sdk-"));
    writeFileSync(path.join(directory, "claude.CMD"), "@echo off\r\n");
    expect(
      resolveClaudeSdkExecutableOptions("claude", { PATH: directory, PATHEXT: ".CMD" }),
    ).toEqual({ pathToClaudeCodeExecutable: resolveBundledClaudeExecutable() });
  });

  it("resolves the installed SDK platform binary", () => {
    expect(resolveBundledClaudeExecutable()).toMatch(/claude(?:\.exe)?$/);
  });

  it("uses the bundled executable for default CLI probes without a PATH-installed claude", () => {
    const invocation = resolveClaudeCliInvocation(undefined, ["--version"], { PATH: "" });
    expect(invocation.file).toBe(resolveBundledClaudeExecutable());
    expect(invocation.args).toEqual(["--version"]);
    expect(invocation.kind).toBe("native");
  });

  it("uses Node for an explicit JavaScript entry", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "f5-claude-sdk-"));
    const script = path.join(directory, "cli.js");
    writeFileSync(script, "console.log('claude')\n");
    chmodSync(script, 0o755);
    expect(resolveClaudeSdkExecutableOptions(script)).toEqual({
      pathToClaudeCodeExecutable: script,
      executable: "node",
    });
  });

  it("rejects Windows cmd shims with a typed, actionable error", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "f5-claude-sdk-"));
    writeFileSync(path.join(directory, "custom-claude.CMD"), "@echo off\r\n");
    expect(() =>
      resolveClaudeSdkExecutableOptions(
        "custom-claude",
        { PATH: directory, PATHEXT: ".CMD" },
        "win32",
      ),
    ).toThrow(CommandNotFoundError);
  });
});
