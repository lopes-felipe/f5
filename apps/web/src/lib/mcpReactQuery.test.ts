import { mcpInspectServerQueryOptions } from "./mcpInspectionReactQuery";
import { describe, expect, it } from "vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  isMcpConfigQuery,
  isMcpQueryAffected,
  mcpQueryKeys,
  shouldPollMcpRuntime,
} from "./mcpReactQuery";

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
    const personal = ProviderInstanceId.make("personal");
    expect(isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, work), event)).toBe(
      true,
    );
    expect(isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, personal), event)).toBe(
      false,
    );
    expect(
      isMcpQueryAffected(mcpQueryKeys.loginStatus("codex", project, "docs", work), event),
    ).toBe(true);
    expect(
      isMcpQueryAffected(mcpQueryKeys.loginStatus("codex", project, "docs", personal), event),
    ).toBe(false);
    expect(
      isMcpQueryAffected(mcpQueryKeys.loginStatus("codex", project, "docs", work), {
        ...event,
        projectId: ProjectId.makeUnsafe("other"),
      }),
    ).toBe(false);
    expect(isMcpQueryAffected(mcpQueryKeys.commonConfig(), event)).toBe(false);
    expect(
      isMcpQueryAffected(
        mcpQueryKeys.serverStatuses("codex", ProjectId.makeUnsafe("other"), work),
        event,
      ),
    ).toBe(false);
    const { instanceId: _, ...unscoped } = event;
    expect(
      isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, personal), unscoped),
    ).toBe(true);
  });

  it("keeps hub connection changes apart from provider observations", () => {
    const project = ProjectId.makeUnsafe("project");
    const work = ProviderInstanceId.make("work");
    const hub = { scope: "common" as const, reason: "hub" as const, serverName: "docs" };
    expect(isMcpQueryAffected(mcpQueryKeys.hubStatus(project), hub)).toBe(true);
    expect(isMcpQueryAffected(mcpQueryKeys.hubStatus(null), hub)).toBe(true);
    expect(isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, work), hub)).toBe(
      false,
    );
    expect(isMcpQueryAffected(mcpQueryKeys.projectConfig(project), hub)).toBe(false);
    const applied = { scope: "project" as const, projectId: project, reason: "applied" as const };
    expect(isMcpQueryAffected(mcpQueryKeys.hubStatus(project), applied)).toBe(true);
    const saved = { scope: "project" as const, projectId: project, reason: "updated" as const };
    expect(isMcpQueryAffected(mcpQueryKeys.hubStatus(project), saved)).toBe(false);
  });

  it("refreshes hub sign-in state on saves and hub events but not provider-account events", () => {
    const project = ProjectId.makeUnsafe("project");
    const hub = { scope: "common" as const, reason: "hub" as const, serverName: "docs" };
    const saved = { scope: "project" as const, projectId: project, reason: "updated" as const };
    expect(isMcpQueryAffected(mcpQueryKeys.hubAuth(null), hub)).toBe(true);
    expect(isMcpQueryAffected(mcpQueryKeys.hubAuth(project), saved)).toBe(true);
    const account = {
      ...saved,
      reason: "runtime" as const,
      instanceId: ProviderInstanceId.make("work"),
    };
    expect(isMcpQueryAffected(mcpQueryKeys.hubAuth(project), account)).toBe(false);
  });

  it("refreshes only configuration queries when a save is announced", () => {
    const project = ProjectId.makeUnsafe("project");
    const work = ProviderInstanceId.make("work");
    const saved = { scope: "project" as const, projectId: project, reason: "updated" as const };
    expect(isMcpQueryAffected(mcpQueryKeys.projectConfig(project), saved)).toBe(true);
    expect(isMcpQueryAffected(mcpQueryKeys.effectiveConfig(project), saved)).toBe(true);
    expect(isMcpQueryAffected(mcpQueryKeys.commonConfig(), saved)).toBe(true);
    expect(isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, work), saved)).toBe(
      false,
    );
    expect(isMcpQueryAffected(mcpQueryKeys.providerStatus("codex", project, work), saved)).toBe(
      false,
    );
    expect(isMcpConfigQuery(mcpQueryKeys.loginStatus("codex", project, "docs", work))).toBe(false);
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
  expect(first.queryKey).toEqual([
    "mcp",
    "inspectServer",
    {
      provider: "codex",
      projectId: "project",
      instanceId: "work",
      serverName: "docs",
      threadId: "one",
    },
    {
      source: "conversation",
      fingerprint: "execution",
      generation: 1,
      desiredVersion: "saved",
      appliedVersion: "applied",
      ownership: "managed",
    },
  ]);
  // Account events reach the inspector through the named scope.
  const event = {
    scope: "project" as const,
    projectId: ProjectId.make("project"),
    instanceId: ProviderInstanceId.make("work"),
    reason: "runtime" as const,
  };
  expect(isMcpQueryAffected(first.queryKey, event)).toBe(true);
  expect(
    isMcpQueryAffected(first.queryKey, { ...event, instanceId: ProviderInstanceId.make("other") }),
  ).toBe(false);
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
