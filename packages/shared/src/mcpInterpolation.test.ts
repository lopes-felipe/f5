import type { McpProjectServersConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  convertBareEnvReferences,
  describeMcpInterpolationSkip,
  hasUnknownMcpReference,
  interpolateMcpServers,
  interpolateMcpValue,
  readMcpEnvironmentIssues,
} from "./mcpInterpolation";

describe("interpolateMcpValue", () => {
  it("expands set variables, applies defaults, and reports unset ones", () => {
    const env = { TOKEN: "abc", EMPTY: "" };
    expect(interpolateMcpValue("Bearer ${env:TOKEN}", env)).toEqual({
      value: "Bearer abc",
      missing: [],
    });
    expect(interpolateMcpValue("${env:EMPTY:-fallback}/${env:NONE:-}", env)).toEqual({
      value: "fallback/",
      missing: [],
    });
    expect(interpolateMcpValue("${env:NONE}-${env:NONE}-${env:OTHER}", env).missing).toEqual([
      "NONE",
      "OTHER",
    ]);
    expect(interpolateMcpValue("${HOME} ${f5-secret:abc} $env:X", env).value).toBe(
      "${HOME} ${f5-secret:abc} $env:X",
    );
  });
});

describe("interpolateMcpServers", () => {
  const servers = {
    local: {
      type: "stdio",
      command: "${env:BIN:-node}",
      args: ["--root", "${env:ROOT}"],
      env: { KEY: "${env:KEY}" },
      cwd: "${env:ROOT}/sub",
    },
    remote: {
      type: "http",
      url: "https://${env:HOST}/mcp",
      headers: { Authorization: "Bearer ${env:TOKEN}" },
    },
    off: { type: "http", url: "https://${env:UNSET}/mcp", enabled: false },
    plain: { type: "http", url: "https://plain.example/mcp" },
  } as unknown as McpProjectServersConfig;

  it("resolves every interpolated field and keeps servers without references", () => {
    const result = interpolateMcpServers(servers, {
      ROOT: "/work",
      KEY: "k",
      HOST: "h.example",
      TOKEN: "t",
    });
    expect(result.skipped).toEqual([]);
    expect(result.servers.local).toEqual({
      type: "stdio",
      command: "node",
      args: ["--root", "/work"],
      env: { KEY: "k" },
      cwd: "/work/sub",
    });
    expect(result.servers.remote).toEqual({
      type: "http",
      url: "https://h.example/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(result.servers.plain).toBe(servers.plain);
    // Disabled servers never start, so their unset variables are not reported.
    expect(result.servers.off).toBeDefined();
  });

  it("leaves out a server with an unset variable and names the variables", () => {
    const result = interpolateMcpServers(servers, { ROOT: "/work", HOST: "h.example" });
    expect(Object.keys(result.servers).toSorted()).toEqual(["off", "plain"]);
    expect(result.skipped).toEqual([
      { name: "local", variables: ["KEY"] },
      { name: "remote", variables: ["TOKEN"] },
    ]);
    expect(describeMcpInterpolationSkip(result.skipped[0]!)).toBe(
      "needs the environment variable KEY, which is not set",
    );
    expect(describeMcpInterpolationSkip({ name: "x", variables: ["A", "B"] })).toBe(
      "needs the environment variables A, B, which are not set",
    );
  });
});

describe("readMcpEnvironmentIssues", () => {
  it("warns about servers whose variables F5's environment does not set", () => {
    const servers = {
      a: { type: "http", url: "https://${env:A_HOST}/mcp" },
      b: { type: "stdio", command: "x", env: { K: "${env:K1}", L: "${env:K2}" } },
      ok: { type: "http", url: "https://${env:SET}/mcp" },
    } as unknown as McpProjectServersConfig;
    expect(readMcpEnvironmentIssues(servers, { SET: "s" })).toEqual([
      {
        kind: "compatibility",
        serverName: "a",
        message:
          "a needs the environment variable A_HOST, which is not set in F5's environment. It starts only for provider accounts that set it.",
      },
      {
        kind: "compatibility",
        serverName: "b",
        message:
          "b needs the environment variables K1, K2, which are not set in F5's environment. It starts only for provider accounts that set them.",
      },
    ]);
  });
});

describe("import helpers", () => {
  it("converts bare references and leaves F5 placeholders alone", () => {
    expect(convertBareEnvReferences("${A} ${B:-x} ${env:C} ${f5-secret:id} ${input:x}")).toBe(
      "${env:A} ${env:B:-x} ${env:C} ${f5-secret:id} ${input:x}",
    );
  });

  it("flags references F5 does not expand", () => {
    expect(hasUnknownMcpReference("${workspaceFolder}")).toBe(true);
    expect(hasUnknownMcpReference("${input:token}")).toBe(true);
    expect(hasUnknownMcpReference("${env:A} ${env:B:-c} ${f5-secret:id}")).toBe(false);
  });
});
