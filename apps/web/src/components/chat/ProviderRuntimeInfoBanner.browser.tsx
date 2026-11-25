import "../../index.css";
import { ProjectId, ProviderInstanceId, ThreadId, type ProviderKind } from "@t3tools/contracts";
import { latestMcpStatusActivities } from "@t3tools/shared/orchestrationActivityPayload";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  Outlet,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { ProviderRuntimeInfoBanner } from "./ProviderRuntimeInfoBanner";

const {
  getEffectiveConfig,
  getLoginStatus,
  startLogin,
  openExternal,
  getHubAuthStatus,
  startHubSignIn,
} = vi.hoisted(() => ({
  getHubAuthStatus: vi.fn(async () => ({
    servers: [{ name: "search", signedIn: false, refreshable: false }],
  })),
  startHubSignIn: vi.fn(async () => ({
    status: "pending" as const,
    attempt: {
      attemptId: "attempt-1",
      authorizationUrl: "https://auth.example.test/hub-search",
      redirectUrl: "http://127.0.0.1:4000/callback",
      startedAt: "2026-11-25T10:00:00.000Z",
    },
  })),
  getEffectiveConfig: vi.fn(),
  getLoginStatus: vi.fn(
    async (input: { provider: string; projectId: string; serverName: string }) => ({
      ...input,
      target: "server",
      mode: "oauth",
      status: "idle",
    }),
  ),
  startLogin: vi.fn(),
  openExternal: vi.fn(async (_url: string) => undefined),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    mcp: {
      getEffectiveConfig,
      getLoginStatus,
      startLogin,
      getHubAuthStatus,
      startHubSignIn,
      onStatusUpdated: () => () => {},
    },
    shell: { openExternal },
  }),
}));

afterEach(() => {
  document.body.innerHTML = "";
});

it.each(["codex", "claudeAgent"] as ProviderKind[])(
  "shows generation-filtered MCP details and a project settings link for %s",
  async (provider) => {
    const servers = latestMcpStatusActivities([
      { kind: "mcp.status.updated", payload: { name: "legacy", status: "ready" } },
      {
        kind: "mcp.status.updated",
        payload: { name: "old-generation", status: "ready", sessionGeneration: 1 },
      },
      {
        kind: "mcp.status.updated",
        payload: { name: "docs", status: "ready", sessionGeneration: 2 },
      },
      {
        kind: "mcp.status.updated",
        payload: {
          name: "search",
          status: "needs-auth",
          error:
            "configured-secret-value Sign in at https://user:pass@example.test/mcp?token=secret#fragment",
          sessionGeneration: 2,
        },
      },
    ]);
    getEffectiveConfig.mockResolvedValue({
      projectId: "project-1",
      effectiveVersion: "v1",
      servers: {
        docs: {
          type: "http",
          url: "https://example.test",
          headers: { "X-Key": "configured-secret-value" },
        },
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute({ component: () => <Outlet /> });
    const index = createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => (
        <ProviderRuntimeInfoBanner
          provider={provider}
          projectId={ProjectId.make("project-1")}
          entries={[{ label: "MCP", value: "1/2 connected" }]}
          mcpServers={[...servers.values()]}
        />
      ),
    });
    const router = createRouter({
      routeTree: root.addChildren([index]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    try {
      const trigger = page.getByRole("button", { name: "MCP: 1/2 connected, 1 needs sign-in" });
      trigger.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByText("docs · ready", { exact: true })).toBeVisible();
      await expect.element(page.getByText("search · needs-auth", { exact: true })).toBeVisible();
      expect(document.body.textContent).not.toContain("old-generation");
      expect(document.body.textContent).not.toContain("legacy");
      await expect
        .element(page.getByText("[redacted] Sign in at https://example.test/mcp", { exact: true }))
        .toBeVisible();
      const link = page.getByRole("link", { name: "Open MCP settings" });
      await expect
        .element(link)
        .toHaveAttribute("href", expect.stringContaining("project=project-1"));
      await expect.element(link).toHaveAttribute("href", expect.stringContaining("item=tools.mcp"));
      await expect.element(link).toHaveFocus();
      await expect.element(link).toHaveAttribute("href", expect.stringContaining("category=tools"));
      await page.screenshot({ fullPage: true });
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
      queryClient.removeQueries({ queryKey: ["mcp", "effectiveConfig"] });
      getEffectiveConfig.mockRejectedValueOnce(new Error("Configuration unavailable"));
      await trigger.click();
      await expect
        .element(
          page.getByText(
            "Error details unavailable until configuration loads. Open MCP settings for details.",
            { exact: true },
          ),
        )
        .toBeVisible();
      expect(document.body.textContent).not.toContain("configured-secret-value");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  },
);

it.each(["codex", "claudeAgent"] as ProviderKind[])(
  "starts sign-in for a needs-auth server from the chat MCP details for %s",
  async (provider) => {
    const threadId = ThreadId.make("chat-thread");
    const instanceId = ProviderInstanceId.make(`${provider}-work`);
    getEffectiveConfig.mockResolvedValue({
      projectId: "project-1",
      effectiveVersion: "v1",
      servers: {},
    });
    startLogin.mockResolvedValue({
      target: "server",
      mode: "oauth",
      provider,
      projectId: "project-1",
      serverName: "search",
      status: "pending",
      authorizationUrl: "https://auth.example.test/search",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute({ component: () => <Outlet /> });
    const index = createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => (
        <ProviderRuntimeInfoBanner
          provider={provider}
          projectId={ProjectId.make("project-1")}
          threadId={threadId}
          entries={[{ label: "MCP", value: "1/2 connected" }]}
          mcpServers={[
            { name: "docs", status: "ready", providerInstanceId: instanceId },
            { name: "search", status: "needs-auth", providerInstanceId: instanceId },
          ]}
        />
      ),
    });
    const router = createRouter({
      routeTree: root.addChildren([index]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    try {
      await page.getByRole("button", { name: "MCP: 1/2 connected, 1 needs sign-in" }).click();
      expect(document.querySelector('[aria-label="Sign in to docs"]')).toBeNull();
      await page.getByRole("button", { name: "Sign in to search" }).click();
      await vi.waitFor(() =>
        expect(startLogin).toHaveBeenCalledWith({
          provider,
          instanceId,
          projectId: "project-1",
          serverName: "search",
          ...(provider === "claudeAgent" ? { threadId } : {}),
        }),
      );
      await vi.waitFor(() =>
        expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/search"),
      );
    } finally {
      startLogin.mockReset();
      openExternal.mockClear();
      queryClient.clear();
      await screen.unmount();
    }
  },
);

it("offers F5 sign-in and links each server's settings panel for agents served by the hub", async () => {
  getEffectiveConfig.mockResolvedValue({
    projectId: "project-1",
    effectiveVersion: "v1",
    servers: {},
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <ProviderRuntimeInfoBanner
        provider="cursor"
        projectId={ProjectId.make("project-1")}
        entries={[{ label: "MCP", value: "1/2 connected" }]}
        mcpServers={[
          { name: "docs", status: "ready", toolCount: 3 },
          { name: "search", status: "needs-auth" },
        ]}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole("button", { name: "MCP: 1/2 connected, 1 needs sign-in" }).click();
    await expect.element(page.getByText("docs · ready · 3 tools", { exact: true })).toBeVisible();
    const details = page.getByRole("link", { name: "search in MCP settings" });
    await expect.element(details).toHaveAttribute("href", expect.stringContaining("server=search"));
    await expect
      .element(details)
      .toHaveAttribute("href", expect.stringContaining("project=project-1"));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await vi.waitFor(() =>
      expect(startHubSignIn).toHaveBeenCalledWith({
        serverName: "search",
        projectId: "project-1",
      }),
    );
    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/hub-search"),
    );
    expect(startLogin).not.toHaveBeenCalled();
  } finally {
    openExternal.mockClear();
    queryClient.clear();
    await screen.unmount();
  }
});

it("uses F5 sign-in for servers the hub serves a Codex conversation, and Codex's own for the rest", async () => {
  getEffectiveConfig.mockResolvedValue({
    projectId: "project-1",
    effectiveVersion: "v1",
    servers: {},
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <ProviderRuntimeInfoBanner
        provider="codex"
        projectId={ProjectId.make("project-1")}
        entries={[{ label: "MCP", value: "0/2 connected" }]}
        mcpServers={[
          { name: "search", status: "needs-auth" },
          { name: "codex-own", status: "needs-auth" },
        ]}
        mcpHubServerNames={new Set(["search"])}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole("button", { name: "MCP: 0/2 connected, 2 need sign-in" }).click();
    await expect
      .element(
        page.getByText(
          "Codex reaches this server through F5 now; its earlier sign-in is not carried over.",
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await vi.waitFor(() =>
      expect(startHubSignIn).toHaveBeenCalledWith({
        serverName: "search",
        projectId: "project-1",
      }),
    );
    // Codex's own server keeps Codex's sign-in.
    await expect.element(page.getByRole("button", { name: /codex-own/ }).first()).toBeVisible();
    expect(startLogin).not.toHaveBeenCalled();
  } finally {
    openExternal.mockClear();
    startHubSignIn.mockClear();
    queryClient.clear();
    await screen.unmount();
  }
});
