import { mcpInspectServerQueryOptions } from "./mcpInspectionReactQuery";
import { describe, expect, it } from "vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { isMcpQueryAffected, mcpQueryKeys, shouldPollMcpRuntime } from "./mcpReactQuery";

describe("MCP status event scoping", () => {
  it("invalidates only the named account when an instance is stamped", () => {
    const project = ProjectId.makeUnsafe("project");
    const work = ProviderInstanceId.make("work");
    const event = {
      scope: "project" as const,
      projectId: project,
      instanceId: work,
      reason: "applied" as const,
    };
    expect(
      isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, work, null), event),
    ).toBe(true);
    expect(
      isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, "personal", null), event),
    ).toBe(false);
    expect(isMcpQueryAffected(mcpQueryKeys.codexStatus(project, work, null), event)).toBe(true);
    expect(isMcpQueryAffected(mcpQueryKeys.oauthStatus(project, "docs", work, null), event)).toBe(
      true,
    );
    expect(
      isMcpQueryAffected(mcpQueryKeys.loginStatus("codex", project, "docs", work, null), event),
    ).toBe(true);
    expect(
      isMcpQueryAffected(mcpQueryKeys.loginStatus("codex", project, work, "personal", null), event),
    ).toBe(false);
    expect(
      isMcpQueryAffected(mcpQueryKeys.loginStatus("codex", project, "docs", work, null), {
        ...event,
        projectId: ProjectId.makeUnsafe("other"),
      }),
    ).toBe(false);
    expect(isMcpQueryAffected(mcpQueryKeys.commonConfig(), event)).toBe(false);
    expect(
      isMcpQueryAffected(
        mcpQueryKeys.serverStatuses("codex", ProjectId.makeUnsafe("other"), work, null),
        event,
      ),
    ).toBe(false);
    const { instanceId: _, ...unscoped } = event;
    expect(
      isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, "personal", null), unscoped),
    ).toBe(true);
  });
});

it("does not share inspector reads across two threads on generation one", () => {
  const base = {
    provider: "codex" as const,
    projectId: ProjectId.make("project"),
    instanceId: ProviderInstanceId.make("work"),
    serverName: "docs",
    observation: {
      provider: "codex" as const,
      projectId: ProjectId.make("project"),
      support: "supported" as const,
      statuses: [],
      source: "conversation" as const,
      generation: 1,
      desiredVersion: "saved",
      appliedVersion: "applied",
      fingerprint: "execution",
    },
  };
  const first = mcpInspectServerQueryOptions({ ...base, threadId: ThreadId.make("one") });
  const second = mcpInspectServerQueryOptions({ ...base, threadId: ThreadId.make("two") });
  expect(first.queryKey).not.toEqual(second.queryKey);
  expect(first.queryKey).toEqual(
    expect.arrayContaining(["conversation", "execution", "one", 1, "saved", "applied"]),
  );
});
it("stops startup polling after thirty seconds and while WebSocket is disconnected", async () => {
  const { noteWsConnectionOpened } = await import("../wsConnectionState");
  const data = {
    provider: "codex" as const,
    projectId: ProjectId.make("project"),
    support: "supported" as const,
    statuses: [
      {
        name: "docs",
        state: "starting" as const,
        authStatus: "unknown" as const,
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
      },
    ],
  };
  expect(shouldPollMcpRuntime(data, 0, 100)).toBe(false);
  noteWsConnectionOpened();
  expect(shouldPollMcpRuntime(data, 100, 200)).toBe(true);
  expect(shouldPollMcpRuntime(data, 100, 30_100)).toBe(false);
  expect(shouldPollMcpRuntime({ ...data, statuses: [] }, 100, 200)).toBe(false);
});
