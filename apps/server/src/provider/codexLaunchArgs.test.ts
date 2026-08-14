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
        environment: { F5_CODEX_LAUNCH_ARGS: "--enable=env-feature" },
        providerLaunchArgs: ["--disable=instance-feature"],
      }),
    ).toEqual({
      argv: ["--enable=env-feature", "--disable=instance-feature"],
      dropped: [],
    });
  });

  it("prefers the F5 environment variable and supports the legacy fallback", () => {
    expect(
      resolveCodexLaunchArgv({
        environment: {
          F5_CODEX_LAUNCH_ARGS: "--enable=f5",
          T3CODE_CODEX_LAUNCH_ARGS: "--enable=legacy",
        },
      }).argv,
    ).toEqual(["--enable=f5"]);
    expect(
      resolveCodexLaunchArgv({
        environment: { T3CODE_CODEX_LAUNCH_ARGS: "--enable=legacy" },
      }).argv,
    ).toEqual(["--enable=legacy"]);
  });

  it("drops reserved flags, their values, and bare subcommands", () => {
    expect(
      filterReservedCodexLaunchArgs([
        "--model",
        "gpt-5",
        "--sandbox=danger-full-access",
        "exec",
        "--enable=allowed",
        "-c=config=true",
      ]),
    ).toEqual({
      argv: ["--enable=allowed"],
      dropped: ["--model", "gpt-5", "--sandbox=danger-full-access", "exec", "-c=config=true"],
    });
  });

  it("rejects malformed environment arguments", () => {
    expect(() =>
      resolveCodexLaunchArgv({ environment: { F5_CODEX_LAUNCH_ARGS: "'unterminated" } }),
    ).toThrow(CodexLaunchArgsError);
  });

  it("places managed configuration after user arguments so managed values win", () => {
    const command = buildCodexAppServerCommand({
      providerLaunchArgs: ["--enable=feature"],
      environment: {},
      mcpServers: {},
    });
    expect(command.argv.slice(0, 2)).toEqual(["app-server", "--enable=feature"]);
    expect(command.argv).toContain("analytics.enabled=false");
    expect(command.argv.at(-1)).toBe("mcp_servers={}");
  });
});
