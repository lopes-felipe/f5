import "../../index.css";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadActivity,
  type ProviderKind,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { McpSignInTray } from "./McpSignInTray";
import { NativeRuntimePanel } from "./NativeRuntimePanel";

const mocks = vi.hoisted(() => ({
  startLogin: vi.fn(),
  getLoginStatus: vi.fn(
    async (input: { provider: string; projectId: string; serverName: string }) => ({
      ...input,
      target: "server",
      mode: "oauth",
      status: "idle",
    }),
  ),
  openExternal: vi.fn(async (_url: string) => undefined),
}));
vi.mock("../../nativeApi", () => {
  const api = {
    mcp: { startLogin: mocks.startLogin, getLoginStatus: mocks.getLoginStatus },
    shell: { openExternal: mocks.openExternal },
    nativeOperations: { list: async () => [] },
    agents: { getSnapshot: async () => ({ entries: [] }) },
  };
  return { ensureNativeApi: () => api, readNativeApi: () => api };
});

const threadId = ThreadId.makeUnsafe("thread-1");
const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const at = "2026-10-19T10:00:00.000Z";

function mcpStatus(
  name: string,
  status: string,
  sessionGeneration = 2,
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(`mcp-${name}-${status}-${sessionGeneration}`),
    kind: "mcp.status.updated",
    tone: "info",
    summary: `MCP server ${name}: ${status}`,
    turnId: null,
    payload: { name, status, providerInstanceId: instanceId, sessionGeneration },
    createdAt: at,
  };
}

const activities = [
  mcpStatus("old-generation", "needs-auth", 1),
  mcpStatus("Glean", "needs-auth"),
  mcpStatus("docs", "ready"),
  mcpStatus("slack", "starting"),
  mcpStatus("slack", "needs-auth"),
];

function withQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("MCP sign-in in conversations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startLogin.mockImplementation(async (input: { serverName: string }) => ({
      target: "server",
      mode: "oauth",
      provider: "claudeAgent",
      projectId,
      serverName: input.serverName,
      status: "pending",
      authorizationUrl: `https://auth.example.test/${input.serverName}`,
    }));
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers sign-in from the composer tray for the latest needs-auth servers", async () => {
    const screen = await render(
      withQueryClient(
        <McpSignInTray
          provider="claudeAgent"
          sessionStatus="running"
          sessionGeneration={2}
          projectId={projectId}
          threadId={threadId}
          activities={activities}
        />,
      ),
    );
    try {
      await expect
        .element(page.getByText("2 MCP servers need sign-in", { exact: false }))
        .toBeVisible();
      expect(document.body.textContent).not.toContain("old-generation");
      await page.getByRole("button", { name: "Sign in…" }).click();
      await page.getByRole("button", { name: "Sign in to slack" }).click();
      await vi.waitFor(() =>
        expect(mocks.startLogin).toHaveBeenCalledWith({
          provider: "claudeAgent",
          instanceId,
          projectId,
          serverName: "slack",
          threadId,
        }),
      );
      await vi.waitFor(() =>
        expect(mocks.openExternal).toHaveBeenCalledWith("https://auth.example.test/slack"),
      );
      expect(document.querySelector('[aria-label="Sign in to docs"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["claudeAgent", "closed", 2, false],
    ["claudeAgent", "error", 2, false],
    ["claudeAgent", undefined, 2, false],
    ["codex", "ready", 2, true],
    // A stopped Codex session keeps its last reports, which nothing clears after sign-in.
    ["codex", "closed", 2, false],
    ["codex", undefined, 2, false],
    ["cursor", "running", 2, false],
    // Unknown generation: fall back to the latest reported one.
    ["claudeAgent", "running", undefined, true],
    // A relaunched session that has not reported any MCP status yet.
    ["claudeAgent", "running", 3, false],
    ["codex", "ready", 3, false],
  ] as Array<
    [
      ProviderKind,
      "closed" | "error" | undefined | "running" | "ready",
      number | undefined,
      boolean,
    ]
  >)(
    "shows the tray for %s with session %s generation %s: %s",
    async (provider, sessionStatus, sessionGeneration, shown) => {
      const screen = await render(
        withQueryClient(
          <McpSignInTray
            provider={provider}
            sessionStatus={sessionStatus}
            sessionGeneration={sessionGeneration}
            projectId={projectId}
            threadId={threadId}
            activities={activities}
          />,
        ),
      );
      try {
        expect(document.querySelector('[data-slot="mcp-sign-in-tray"]') !== null).toBe(shown);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("lists needs-auth servers with Sign in in Runtime details instead of notices", async () => {
    const screen = await render(
      withQueryClient(
        <NativeRuntimePanel
          provider="claudeAgent"
          sessionStatus="ready"
          projectId={projectId}
          threadId={threadId}
          capabilities={null}
          activities={[...activities, mcpStatus("docs", "failed")]}
          runtime={null}
          requestedModel="claude-opus-5-5"
        />,
      ),
    );
    try {
      await page.getByRole("button", { name: "Runtime details" }).click();
      const section = page.getByRole("region", { name: "MCP sign-in" });
      await expect.element(section).toBeVisible();
      await page.getByRole("button", { name: "Sign in to Glean" }).click();
      await vi.waitFor(() =>
        expect(mocks.startLogin).toHaveBeenCalledWith(
          expect.objectContaining({ serverName: "Glean", threadId }),
        ),
      );
      const notices = page.getByRole("region", { name: "Provider notices" });
      await expect.element(notices).toBeVisible();
      expect(notices.element().textContent).toContain("MCP server docs: failed");
      expect(notices.element().textContent).not.toContain("needs-auth");
    } finally {
      await screen.unmount();
    }
  });
});
