import { describe, expect, it } from "vitest";

import {
  areProviderStartOptionsEqual,
  getProviderEnvironmentKey,
  getProviderSessionRestartOptions,
  normalizeProviderStartOptions,
} from "./providerOptions";

describe("normalizeProviderStartOptions (claudeAgent launchArgs)", () => {
  it("drops empty launchArgs records", () => {
    const normalized = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: {} },
    });
    expect(normalized).toBeUndefined();
  });

  it("sorts launchArgs keys so equal sets compare equal", () => {
    const left = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: {
        launchArgs: { verbose: null, model: "opus" },
      },
    });
    const right = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: {
        launchArgs: { model: "opus", verbose: null },
      },
    });
    expect(left).toEqual(right);
    expect(Object.keys(left?.claudeAgent?.launchArgs ?? {})).toEqual(["model", "verbose"]);
  });

  it("keeps launchArgs alongside other claudeAgent options", () => {
    const normalized = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: {
        binaryPath: "/usr/local/bin/claude",
        launchArgs: { model: "opus" },
      },
    });
    expect(normalized?.claudeAgent?.binaryPath).toBe("/usr/local/bin/claude");
    expect(normalized?.claudeAgent?.launchArgs).toEqual({ model: "opus" });
  });
});

describe("getProviderSessionRestartOptions", () => {
  it("canonicalizes behaviorally neutral Claude defaults to omission", () => {
    expect(
      getProviderSessionRestartOptions("claudeAgent", {
        claudeAgent: {
          subagentsEnabled: true,
          subagentModel: "inherit",
        },
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ subagentsEnabled: false }],
    [{ subagentModel: "claude-haiku-4-5" }],
    [{ binaryPath: "/tmp/claude" }],
    [{ launchArgs: { debug: null } }],
  ])("keeps behavior-changing Claude options distinct (%o)", (claudeAgent) => {
    expect(getProviderSessionRestartOptions("claudeAgent", { claudeAgent })).toEqual({
      claudeAgent,
    });
  });

  it("can ignore MCP servers and collapses an MCP-only object", () => {
    const mcpServers = {
      filesystem: { type: "stdio" as const, command: "node" },
    };
    expect(
      getProviderSessionRestartOptions("claudeAgent", { mcpServers }, { ignoreMcpServers: true }),
    ).toBeUndefined();
    expect(
      getProviderSessionRestartOptions(
        "claudeAgent",
        { mcpServers, claudeAgent: { permissionMode: "plan" } },
        { ignoreMcpServers: true },
      ),
    ).toEqual({ claudeAgent: { permissionMode: "plan" } });
  });

  it("keeps MCP changes in the default projection", () => {
    const options = {
      mcpServers: {
        filesystem: { type: "stdio" as const, command: "node" },
      },
    };
    expect(getProviderSessionRestartOptions("codex", options)).toEqual(options);
  });
});

describe("normalizeProviderStartOptions (MCP OAuth fields)", () => {
  it("preserves static OAuth client fields for MCP servers", () => {
    const normalized = normalizeProviderStartOptions("codex", {
      mcpServers: {
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauthClientId: "  client-1  ",
          oauthCallbackPort: 3118,
          oauthCallbackUrl: "  http://127.0.0.1:3118/callback  ",
        },
      },
    });

    expect(normalized?.mcpServers?.slack).toMatchObject({
      type: "http",
      url: "https://mcp.slack.com/mcp",
      oauthClientId: "client-1",
      oauthCallbackPort: 3118,
      oauthCallbackUrl: "http://127.0.0.1:3118/callback",
    });
  });
});

describe("getProviderEnvironmentKey includes launchArgs", () => {
  it("canonicalizes behaviorally neutral Claude defaults", () => {
    expect(
      getProviderEnvironmentKey("claudeAgent", {
        claudeAgent: { subagentsEnabled: true, subagentModel: "inherit" },
      }),
    ).toBe(getProviderEnvironmentKey("claudeAgent", undefined));
  });

  it("distinguishes bindings whose launchArgs differ", () => {
    const withoutArgs = getProviderEnvironmentKey("claudeAgent", undefined);
    const withFlag = getProviderEnvironmentKey("claudeAgent", {
      claudeAgent: { launchArgs: { verbose: null } },
    });
    const withDifferentFlag = getProviderEnvironmentKey("claudeAgent", {
      claudeAgent: { launchArgs: { debug: null } },
    });
    expect(withoutArgs).not.toEqual(withFlag);
    expect(withFlag).not.toEqual(withDifferentFlag);
  });

  it("is stable across equivalent launchArgs key orderings", () => {
    const a = getProviderEnvironmentKey("claudeAgent", {
      claudeAgent: { launchArgs: { verbose: null, model: "opus" } },
    });
    const b = getProviderEnvironmentKey("claudeAgent", {
      claudeAgent: { launchArgs: { model: "opus", verbose: null } },
    });
    expect(a).toBe(b);
  });
});

describe("areProviderStartOptionsEqual with launchArgs", () => {
  it("treats differently-ordered launchArgs as equal after normalization", () => {
    const left = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: { verbose: null, model: "opus" } },
    });
    const right = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: { model: "opus", verbose: null } },
    });
    expect(areProviderStartOptionsEqual(left, right)).toBe(true);
  });

  it("detects differing launchArgs values", () => {
    const left = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: { model: "opus" } },
    });
    const right = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: { model: "sonnet" } },
    });
    expect(areProviderStartOptionsEqual(left, right)).toBe(false);
  });
});
