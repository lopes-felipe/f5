import { describe, expect, it } from "vitest";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./launch.ts";
import {
  F5_PI_READ_ONLY_ENV,
  F5_PI_MCP_URL_ENV,
  F5_PI_MCP_BEARER_ENV,
  F5_PI_RUNTIME_MODE_ENV,
  F5_PI_MCP_EXTENSION_PATH_ENV,
  F5_PI_MCP_SERVERS_ENV,
} from "./PiEnvironment.ts";

describe("Pi launch admission", () => {
  it.each([
    "--mode=print",
    "--mode rpc",
    "--session /private",
    "--resume latest",
    "--continue",
    "-p",
    "--",
    "@secret.txt",
    "hello",
    "--model",
    "--model=",
    "--model --no-tools",
    "--provider anthropic",
    "--unknown-short -x",
    "--model 'unclosed",
  ])("rejects owned transport/session options and malformed input: %s", (input) => {
    expect(resolvePiLaunchArgs(input).ok).toBe(false);
  });
  it("normalizes known equals arguments and preserves literal extension flags without shell evaluation", () => {
    expect(
      resolvePiLaunchArgs(
        '--provider=vendor --model="model with space" --extension ./local.ts --feature=literal --custom "$(private)"',
      ),
    ).toEqual({
      ok: true,
      args: [
        "--provider",
        "vendor",
        "--model",
        "model with space",
        "--extension",
        "./local.ts",
        "--feature=literal",
        "--custom",
        "$(private)",
      ],
    });
  });
  it("keeps current credentials in the child environment only and clears inherited session ownership", () => {
    const environment = {
      PATH: "/bin",
      [F5_PI_READ_ONLY_ENV]: "1",
      [F5_PI_MCP_URL_ENV]: "old-url",
      [F5_PI_MCP_BEARER_ENV]: "old-secret",
      [F5_PI_RUNTIME_MODE_ENV]: "full-access",
      [F5_PI_MCP_EXTENSION_PATH_ENV]: "/old.ts",
    };
    const base = { launchArgs: [], environment, mcpSession: undefined, extensionPath: undefined };
    expect(buildPiRpcLaunch(base).env).toEqual({ PATH: "/bin" });
    const launch = buildPiRpcLaunch({
      ...base,
      extensionPath: "/f5.ts",
      runtimeMode: "auto",
      mcpSession: {
        endpoint: "http://127.0.0.1/private",
        authorizationHeader: "Bearer new-secret",
      },
    });
    expect(launch.hasF5Mcp).toBe(true);
    expect(launch.args).toEqual(["--mode", "rpc", "--extension", "/f5.ts"]);
    expect(launch.env).toEqual({
      PATH: "/bin",
      [F5_PI_MCP_URL_ENV]: "http://127.0.0.1/private",
      [F5_PI_MCP_BEARER_ENV]: "new-secret",
      [F5_PI_MCP_EXTENSION_PATH_ENV]: "/f5.ts",
      [F5_PI_RUNTIME_MODE_ENV]: "approval-required",
    });
    expect(environment[F5_PI_MCP_BEARER_ENV]).toBe("old-secret");
  });

  it("hands hub servers to the F5 extension and never inherits them", () => {
    const userMcpServers = [
      { name: "docs", url: "http://127.0.0.1/mcp/user/a", token: "t", timeoutMs: 600_000 },
    ];
    const base = {
      launchArgs: [],
      environment: { PATH: "/bin", [F5_PI_MCP_SERVERS_ENV]: "[]" },
      mcpSession: undefined,
      userMcpServers,
    };
    expect(buildPiRpcLaunch({ ...base, extensionPath: undefined }).env).toEqual({
      PATH: "/bin",
    });
    expect(
      JSON.parse(
        buildPiRpcLaunch({ ...base, extensionPath: "/f5.ts" }).env[F5_PI_MCP_SERVERS_ENV]!,
      ),
    ).toEqual(userMcpServers);
    expect(
      buildPiRpcLaunch({ ...base, extensionPath: "/f5.ts", userMcpServers: [] }).env[
        F5_PI_MCP_SERVERS_ENV
      ],
    ).toBeUndefined();
  });
  it("removes explicit extensions and tool selectors before appending unattended restrictions", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--extension",
        "/user.ts",
        "-e",
        "/other.ts",
        "--tools",
        "bash",
        "--exclude-tools=read",
        "--model",
        "vendor/model",
      ],
      environment: { [F5_PI_RUNTIME_MODE_ENV]: "full-access" },
      extensionPath: "/f5.ts",
      mcpSession: { endpoint: "secret-url", authorizationHeader: "secret-token" },
      disableExtensions: true,
      disableTools: true,
      ephemeral: true,
    });
    expect(launch).toEqual({
      args: [
        "--mode",
        "rpc",
        "--no-session",
        "--model",
        "vendor/model",
        "--no-extensions",
        "--no-tools",
      ],
      env: {},
      hasF5Mcp: false,
    });
  });
  it("does not add a second explicit bridge extension", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: ["-e", "C:\\f5\\extension.ts"],
      environment: {},
      mcpSession: undefined,
      extensionPath: "C:/f5/extension.ts",
    });
    expect(launch.args).toEqual(["--mode", "rpc", "-e", "C:\\f5\\extension.ts"]);
  });
});

it("owns the read-only policy independently of runtime mode", () => {
  const launch = buildPiRpcLaunch({
    launchArgs: [],
    environment: {},
    extensionPath: "/f5.ts",
    mcpSession: undefined,
    readOnly: true,
    runtimeMode: "full-access",
  });
  expect(launch.env[F5_PI_READ_ONLY_ENV]).toBe("1");
  expect(launch.env[F5_PI_RUNTIME_MODE_ENV]).toBe("full-access");
});
