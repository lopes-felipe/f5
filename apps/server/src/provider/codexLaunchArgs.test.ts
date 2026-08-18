import { describe, expect, it } from "vitest";

import {
  buildCodexAppServerCommand,
  CodexLaunchArgsError,
  filterReservedCodexLaunchArgs,
  resolveCodexLaunchArgv,
} from "./codexLaunchArgs.ts";

describe("Codex launch arguments", () => {
  it("combines F5 environment and instance arguments without a shell", () => {
    expect(
      resolveCodexLaunchArgv({
        environment: { F5_CODEX_LAUNCH_ARGS: "--strict-config" },
        providerLaunchArgs: ["--analytics-default-enabled"],
      }),
    ).toEqual({
      argv: ["--strict-config", "--analytics-default-enabled"],
      dropped: [],
    });
  });

  it("prefers the F5 environment variable and supports the legacy fallback", () => {
    expect(
      resolveCodexLaunchArgv({
        environment: {
          F5_CODEX_LAUNCH_ARGS: "--strict-config",
          T3CODE_CODEX_LAUNCH_ARGS: "--analytics-default-enabled",
        },
      }).argv,
    ).toEqual(["--strict-config"]);
    expect(
      resolveCodexLaunchArgv({
        environment: { T3CODE_CODEX_LAUNCH_ARGS: "--analytics-default-enabled" },
      }).argv,
    ).toEqual(["--analytics-default-enabled"]);
  });

  it("drops reserved flags, their values, and bare subcommands", () => {
    expect(
      filterReservedCodexLaunchArgs([
        "--model",
        "gpt-5",
        "--sandbox=danger-full-access",
        "exec",
        "--strict-config",
        "-c=config=true",
      ]),
    ).toEqual({
      argv: ["--strict-config"],
      dropped: ["--model", "gpt-5", "--sandbox=danger-full-access", "exec", "-c=config=true"],
    });
  });

  it("drops attached short config overrides and every app-server transport override", () => {
    expect(
      filterReservedCodexLaunchArgs([
        "-csandbox_mode=danger-full-access",
        "-capproval_policy=never",
        "-cshell_environment_policy.inherit=all",
        "--profile=yolo",
        "--full-auto",
        "--dangerously-bypass-approvals-and-sandbox",
        "--enable=remote_compaction",
        "--listen=ws://0.0.0.0:9999",
        "--code-mode-host",
        "ws://evil.example",
        "--ws-auth=capability-token",
      ]),
    ).toEqual({
      argv: [],
      dropped: [
        "-csandbox_mode=danger-full-access",
        "-capproval_policy=never",
        "-cshell_environment_policy.inherit=all",
        "--profile=yolo",
        "--full-auto",
        "--dangerously-bypass-approvals-and-sandbox",
        "--enable=remote_compaction",
        "--listen=ws://0.0.0.0:9999",
        "--code-mode-host",
        "ws://evil.example",
        "--ws-auth=capability-token",
      ],
    });
  });

  it("keeps a non-reserved flag and its separate value together", () => {
    expect(filterReservedCodexLaunchArgs(["--future-safe-option", "value"])).toEqual({
      argv: ["--future-safe-option", "value"],
      dropped: [],
    });
  });

  it("drops an argument terminator and everything after it", () => {
    const command = buildCodexAppServerCommand({
      providerLaunchArgs: ["--strict-config", "--", "-c", "sandbox_mode=danger-full-access"],
      environment: {},
    });

    expect(command.argv.slice(0, 2)).toEqual(["app-server", "--strict-config"]);
    expect(command.argv).not.toContain("--");
    expect(command.dropped).toEqual(["--", "-c", "sandbox_mode=danger-full-access"]);
  });

  it("rejects malformed environment arguments", () => {
    expect(() =>
      resolveCodexLaunchArgv({ environment: { F5_CODEX_LAUNCH_ARGS: "'unterminated" } }),
    ).toThrow(CodexLaunchArgsError);
  });

  it("places managed configuration after user arguments so managed values win", () => {
    const command = buildCodexAppServerCommand({
      providerLaunchArgs: ["--strict-config"],
      environment: {},
      mcpServers: {},
    });
    expect(command.argv.slice(0, 2)).toEqual(["app-server", "--strict-config"]);
    expect(command.argv).toContain("analytics.enabled=false");
    expect(command.argv.at(-1)).toBe("mcp_servers={}");
  });
});
