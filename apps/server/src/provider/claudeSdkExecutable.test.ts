import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { CommandNotFoundError } from "../spawn/resolveCommand.ts";
import {
  resolveBundledClaudeExecutable,
  resolveClaudeCliInvocation,
  resolveClaudeSdkExecutableOptions,
} from "./claudeSdkExecutable.ts";

describe("Claude SDK executable resolution", () => {
  it("omits the executable override for the default provider setting", () => {
    expect(resolveClaudeSdkExecutableOptions(undefined)).toEqual({});
    expect(resolveClaudeSdkExecutableOptions("claude")).toEqual({});
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
      resolveClaudeSdkExecutableOptions("claude", { PATH: directory, PATHEXT: ".CMD" }, "win32"),
    ).not.toThrow();
    expect(() =>
      resolveClaudeSdkExecutableOptions(
        "custom-claude",
        { PATH: directory, PATHEXT: ".CMD" },
        "win32",
      ),
    ).toThrow(CommandNotFoundError);
  });
});
