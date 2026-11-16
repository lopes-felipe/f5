import { describe, expect, it } from "vitest";
import {
  findCodexServerStatusByName,
  mergeCodexMcpStartupStatuses,
  readCodexServerStatusPages,
} from "./codexMcpServerStatus.ts";
import type { CodexControlMcpServerStatus } from "./CodexControlClient.ts";
import type { CodexControlClient } from "./CodexControlClient.ts";

describe("Codex MCP name matching", () => {
  const status = (name: string): CodexControlMcpServerStatus => ({
    name,
    authStatus: "unsupported",
    tools: {},
    resources: [],
    resourceTemplates: [],
  });
  it("matches a unique trimmed case-insensitive provider name", () => {
    const github = status(" GitHub ");
    expect(findCodexServerStatusByName([github], "github")).toBe(github);
  });
  it("never assigns ambiguous provider names to a configured row", () => {
    expect(
      findCodexServerStatusByName([status("GitHub"), status("github")], "GitHub"),
    ).toBeUndefined();
  });
  it("merges a unique notification despite casing differences", () => {
    expect(
      mergeCodexMcpStartupStatuses(
        [status("github")],
        [{ name: "GitHub", startupStatus: "ready" }],
      ),
    ).toEqual([{ ...status("github"), startupStatus: "ready" }]);
  });
  it("preserves conflicting notification names even when one alias appears in the listing", () => {
    const notifications = [
      { name: "GitHub", startupStatus: "ready" as const },
      { name: "github", startupStatus: "failed" as const },
    ];
    const merged = mergeCodexMcpStartupStatuses([status("GitHub")], notifications);
    expect(merged.map((entry) => entry.name)).toEqual(["GitHub", "github"]);
    expect(merged[0]?.startupStatus).toBe("ready");
    expect(merged[1]?.startupStatus).toBe("failed");
    expect(findCodexServerStatusByName(merged, "github")).toBeUndefined();
  });
});

it("lets startup status in the listing supersede earlier notification errors", () => {
  expect(
    mergeCodexMcpStartupStatuses(
      [{ name: "docs", startupStatus: "ready", tools: {} }],
      [{ name: "docs", startupStatus: "failed", error: "Earlier startup failure" }],
    ),
  ).toEqual([{ name: "docs", startupStatus: "ready", tools: {} }]);
});
it("accepts a terminal MCP page without nextCursor and still merges startup evidence", async () => {
  const client = {
    listMcpServerStatus: async () => ({ data: [{ name: "docs", tools: {} }] }),
    getMcpStartupStatuses: () => [{ name: "docs", startupStatus: "ready" }],
  } as unknown as CodexControlClient;
  const result = await readCodexServerStatusPages(client);
  expect(result.complete).toBe(true);
  expect(result.entries[0]?.startupStatus).toBe("ready");
});
