import type { McpHubServerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  hubStatusSources,
  observedStatusSource,
  summarizeMcpServerStatus,
} from "./mcpServerStatus";

const server = { type: "http" as const, url: "https://docs.test/mcp" };
const hub = (patch: Partial<McpHubServerStatus>): McpHubServerStatus => ({
  name: "docs",
  connectionScope: "shared",
  transport: "http",
  state: "ready",
  attempts: 0,
  attachedSessions: 1,
  projectIds: [],
  providers: ["cursor"],
  ...patch,
});

describe("summarizeMcpServerStatus", () => {
  it("reports Not connected with no source and Disabled for a disabled server", () => {
    expect(summarizeMcpServerStatus(server, [])).toEqual({
      tone: "outline",
      label: "Not connected",
    });
    expect(
      summarizeMcpServerStatus({ ...server, enabled: false }, hubStatusSources([hub({})])).label,
    ).toBe("Disabled");
  });

  it("shows the ready tool count from one source without naming it", () => {
    expect(summarizeMcpServerStatus(server, hubStatusSources([hub({ toolCount: 1 })]))).toEqual({
      tone: "success",
      label: "Ready",
      detail: "1 tool",
      source: undefined,
    });
  });

  it("puts a failure ahead of another provider's ready connection and names its source", () => {
    const observed = observedStatusSource("Codex", {
      name: "docs",
      state: "failed",
      authStatus: "unknown",
      toolCount: 0,
      resourceCount: 0,
      resourceTemplateCount: 0,
      message: "connection refused",
    });
    expect(
      summarizeMcpServerStatus(server, [...hubStatusSources([hub({ toolCount: 3 })]), observed]),
    ).toEqual({ tone: "error", label: "Failed", detail: "connection refused", source: "Codex" });
  });

  it("maps login-required and retrying states", () => {
    const login = observedStatusSource("Claude", {
      name: "docs",
      state: "login-required",
      authStatus: "unauthenticated",
      toolCount: 0,
      resourceCount: 0,
      resourceTemplateCount: 0,
    });
    expect(summarizeMcpServerStatus(server, [login]).label).toBe("Needs sign-in");
    expect(
      summarizeMcpServerStatus(server, hubStatusSources([hub({ state: "retrying" })])).label,
    ).toBe("Connecting");
    expect(
      summarizeMcpServerStatus(server, hubStatusSources([hub({ state: "stopped" })])).label,
    ).toBe("Not connected");
  });
});
