import { Schema } from "effect";
import { useProfileState } from "../../profileState";
import { ProfileId } from "@t3tools/contracts";
import "../../index.css";
import { StrictMode, useState } from "react";
import { McpKeyValueFields } from "./mcp/McpKeyValueFields";

import type {
  McpCommonConfigResult,
  McpEffectiveConfigResult,
  McpLoginStatusResult,
  McpProjectConfigResult,
  McpServerStatusesResult,
  McpGetHubAuthStatusResult,
  McpListActivityResult,
  McpSearchCatalogResult,
  McpRepositoryServersResult,
  McpListToolPinsResult,
  McpGetHubStatusResult,
  McpStartHubSignInResult,
  McpReconnectServerResult,
  McpProviderStatusResult,
  NativeApi,
  ProjectId,
} from "@t3tools/contracts";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { noteWsConnectionOpened, noteWsConnectionClosed } from "../../wsConnectionState";
import { formatMcpServersAsJson } from "@t3tools/shared/mcpConfig";
import { CODEX_SSE_TRANSPORT_HINT } from "@t3tools/shared/mcpTranslation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { McpServersSettings } from "./McpServersSettings";
import { toastManager } from "../ui/toast";

const { copyToClipboard, nativeApiRef, hubMode } = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  nativeApiRef: {
    current: undefined as NativeApi | undefined,
  },
  // Most tests cover Codex's and Claude's own sign-in, which native passthrough keeps.
  hubMode: { nativeProvidersOnHub: false },
}));

vi.mock("../../lib/mcpHubChat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mcpHubChat")>()),
  useNativeProvidersOnHub: () => hubMode.nativeProvidersOnHub,
}));

vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard,
    isCopied: false,
  }),
  writeTextToClipboard: async () => {},
}));

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => {
    if (!nativeApiRef.current) {
      throw new Error("Native API not found");
    }
    return nativeApiRef.current;
  },
  readNativeApi: () => nativeApiRef.current,
}));

const PROJECT_ID = "project-1" as ProjectId;

const commonConfig: McpCommonConfigResult = {
  version: "common-v1",
  servers: {
    "common-server": {
      type: "stdio",
      command: "common-command",
    },
  },
};

const projectConfig: McpProjectConfigResult = {
  projectId: PROJECT_ID,
  version: "project-v1",
  servers: {
    "project-server": {
      type: "stdio",
      command: "project-command",
    },
  },
};

const effectiveConfig: McpEffectiveConfigResult = {
  projectId: PROJECT_ID,
  commonVersion: "common-v1",
  projectVersion: "project-v1",
  effectiveVersion: "effective-v1",
  servers: {
    ...commonConfig.servers,
    ...projectConfig.servers,
  },
};

function createNativeApiMock() {
  const getCommonConfig = vi.fn(async () => commonConfig);
  const getProjectConfig = vi.fn(async () => projectConfig);
  const getEffectiveConfig = vi.fn(async () => effectiveConfig);
  const getProviderStatus = vi.fn(
    async ({
      provider,
      projectId,
    }: {
      provider: "codex" | "claudeAgent";
      projectId: ProjectId;
    }): Promise<McpProviderStatusResult> =>
      provider === "codex"
        ? {
            provider,
            projectId,
            support: "supported" as const,
            available: true,
            authStatus: "authenticated" as const,
            configVersion: "effective-v1",
          }
        : {
            provider,
            projectId,
            support: "supported" as const,
            available: true,
            authStatus: "authenticated" as const,
            configVersion: "effective-v1",
          },
  );
  const getServerStatuses = vi.fn(
    async ({
      provider,
      projectId,
    }: {
      provider: "codex" | "claudeAgent";
      projectId: ProjectId;
    }): Promise<McpServerStatusesResult> => ({
      provider,
      projectId,
      support: "supported" as const,
      configVersion: "effective-v1",
      statuses: [
        {
          name: "common-server",
          state: "ready" as const,
          authStatus: "authenticated" as const,
          toolCount: 1,
          resourceCount: 0,
          resourceTemplateCount: 0,
        },
        {
          name: "project-server",
          state: "ready" as const,
          authStatus: "authenticated" as const,
          toolCount: 1,
          resourceCount: 0,
          resourceTemplateCount: 0,
        },
      ],
    }),
  );
  const getLoginStatus = vi.fn(
    async ({
      provider,
      projectId,
      serverName,
    }: {
      provider: "codex" | "claudeAgent";
      projectId: ProjectId;
      serverName?: string;
    }): Promise<McpLoginStatusResult> => ({
      target: serverName ? ("server" as const) : ("provider" as const),
      mode: "cli" as const,
      provider,
      projectId,
      ...(serverName ? { serverName } : {}),
      status: "idle" as const,
    }),
  );
  const getHubStatus = vi.fn(async (): Promise<McpGetHubStatusResult> => ({ servers: [] }));
  const reconnectHubServer = vi.fn(async () => ({ reconnected: 1 }));
  const getHubAuthStatus = vi.fn(async (): Promise<McpGetHubAuthStatusResult> => ({ servers: [] }));
  const startHubSignIn = vi.fn(
    async (): Promise<McpStartHubSignInResult> => ({ status: "signed-in" }),
  );
  const completeHubSignIn = vi.fn(async () => ({
    status: "signed-in" as const,
    serverName: "docs",
    reconnected: 1,
  }));
  const signOutHubServer = vi.fn(async () => ({ signedOut: true }));
  const listToolPins = vi.fn(async (): Promise<McpListToolPinsResult> => ({ tools: [] }));
  const acceptToolChanges = vi.fn(async () => ({ accepted: 1 }));
  const searchCatalog = vi.fn(async (): Promise<McpSearchCatalogResult> => ({ entries: [] }));
  const getRepositoryServers = vi.fn(
    async (): Promise<McpRepositoryServersResult> => ({
      projectId: PROJECT_ID,
      found: false,
      servers: [],
      issues: [],
    }),
  );
  const setRepositoryServerTrust = vi.fn(
    async (): Promise<McpRepositoryServersResult> => ({
      projectId: PROJECT_ID,
      found: false,
      servers: [],
      issues: [],
    }),
  );
  const listActivity = vi.fn(
    async (): Promise<McpListActivityResult> => ({
      calls: [],
      last24h: { calls: 0, errors: 0 },
    }),
  );
  const reconnectServer = vi.fn(
    async (): Promise<McpReconnectServerResult> => ({
      settingsConnectionReloaded: false,
      sessionsMatched: 1,
      sessionsReconnected: 1,
      failures: [],
    }),
  );
  const inspectServer = vi.fn(async (input: Parameters<NativeApi["mcp"]["inspectServer"]>[0]) => ({
    ...(await getServerStatuses({
      provider: input.provider as "codex",
      projectId: input.projectId,
    })),
    serverName: input.serverName,
    capabilities: { tools: true, inputSchemas: false, resources: false },
    tools: [{ name: "read", description: "Read metadata" }],
    resources: [],
    resourceTemplates: [],
    diagnostics: [],
  }));
  const onStatusUpdated = vi.fn(
    (_listener: Parameters<NativeApi["mcp"]["onStatusUpdated"]>[0]) => () => {},
  );
  const startLogin = vi.fn();
  const openExternal = vi.fn(async (_url: string) => undefined);
  const applyToLiveSessions = vi.fn(
    async (input: { scope: "common" | "project"; projectId?: ProjectId }) => ({
      scope: input.scope,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      codexReloaded: input.scope === "project" ? 1 : 2,
      claudeRestarted: 0,
      skipped: 0,
      configVersion: "effective-v1",
    }),
  );

  const replaceProjectConfig = vi.fn(
    async (input: Parameters<NativeApi["mcp"]["replaceProjectConfig"]>[0]) => {
      const result = {
        projectId: input.projectId,
        version: "project-v2",
        servers: input.servers,
        ...(input.disabledCommonServers
          ? { disabledCommonServers: input.disabledCommonServers }
          : {}),
      };
      getProjectConfig.mockResolvedValue(result);
      return result;
    },
  );
  const replaceCommonConfig = vi.fn(
    async (input: Parameters<NativeApi["mcp"]["replaceCommonConfig"]>[0]) => {
      const result = { version: "common-v2", servers: input.servers };
      getCommonConfig.mockResolvedValue(result);
      return result;
    },
  );

  nativeApiRef.current = {
    mcp: {
      replaceProjectConfig,
      replaceCommonConfig,
      getCommonConfig,
      getProjectConfig,
      getEffectiveConfig,
      getProviderStatus,
      getServerStatuses,
      getLoginStatus,
      startLogin,
      applyToLiveSessions,
      reconnectServer,
      getHubStatus,
      reconnectHubServer,
      getHubAuthStatus,
      startHubSignIn,
      completeHubSignIn,
      signOutHubServer,
      listToolPins,
      acceptToolChanges,
      listActivity,
      searchCatalog,
      getRepositoryServers,
      setRepositoryServerTrust,
      inspectServer,
      onStatusUpdated,
    },
    shell: {
      openExternal,
    },
  } as unknown as NativeApi;

  return {
    replaceProjectConfig,
    getHubStatus,
    reconnectHubServer,
    getHubAuthStatus,
    startHubSignIn,
    completeHubSignIn,
    signOutHubServer,
    listToolPins,
    acceptToolChanges,
    listActivity,
    searchCatalog,
    getRepositoryServers,
    setRepositoryServerTrust,
    replaceCommonConfig,
    getCommonConfig,
    getProjectConfig,
    getEffectiveConfig,
    getProviderStatus,
    getServerStatuses,
    getLoginStatus,
    startLogin,
    reconnectServer,
    inspectServer,
    onStatusUpdated,
    openExternal,
    applyToLiveSessions,
  };
}

async function renderSettings(withProject = true) {
  await page.viewport(1280, 900);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <McpServersSettings
        selectedProject={withProject ? { id: PROJECT_ID, name: "Project One" } : null}
        hasProjects
      />
    </QueryClientProvider>,
  );

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain(withProject ? "project-server" : "common-server");
  });

  return { screen, queryClient };
}

async function captureSettingsScreenshot() {
  await page.viewport(1280, 1800);
  window.scrollTo({ top: 0, behavior: "instant" });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await page.screenshot({ fullPage: true });
}

/** Opens a server's detail panel, optionally on a tab. */
async function openServer(name: string, tab?: string) {
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await expect.element(page.getByRole("heading", { name, exact: true })).toBeVisible();
  if (tab) await page.getByRole("tab", { name: tab, exact: true }).click();
}

/** Opens Add server on the Form tab, or another tab. */
async function openAddServer(tab?: string) {
  await page.getByRole("button", { name: "Add server", exact: true }).first().click();
  await expect.element(page.getByRole("heading", { name: "Add MCP server" })).toBeVisible();
  if (tab) await page.getByRole("tab", { name: tab, exact: true }).click();
}

async function rowAction(name: string, action: string) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

/** Expands the collapsed provider-managed section. */
async function openProviderManaged() {
  const details = Array.from(document.querySelectorAll("details")).find((element) =>
    element.querySelector("summary")?.textContent?.includes("Provider-managed servers"),
  );
  expect(details).toBeDefined();
  if (details && !details.open)
    await page.getByText("Provider-managed servers", { exact: true }).click();
  await vi.waitFor(() => expect(details?.open).toBe(true));
}

/** The submit button inside the open Add server dialog. */
function addServerSubmit() {
  return page.getByRole("dialog").getByRole("button", { name: "Add server", exact: true });
}

describe("McpServersSettings", () => {
  afterEach(() => {
    noteWsConnectionClosed();
    copyToClipboard.mockReset();
    nativeApiRef.current = undefined;
    hubMode.nativeProvidersOnHub = false;
    document.body.innerHTML = "";
  });

  it("sends Codex and Claude sign-in to F5 and says earlier sign-ins are not carried over", async () => {
    hubMode.nativeProvidersOnHub = true;
    const mocks = createNativeApiMock();
    mocks.getHubAuthStatus.mockResolvedValue({
      servers: [{ name: "docs", signedIn: false, refreshable: false }],
    });
    mocks.getCommonConfig.mockResolvedValue({
      version: "common-v1",
      servers: {
        ...commonConfig.servers,
        docs: { type: "http", url: "https://docs.example.test/mcp" },
        local: { type: "stdio", command: "node", cwd: "/srv" },
      },
    });
    const { screen } = await renderSettings(false);
    try {
      const notice = page.getByRole("region", { name: "How Codex and Claude connect" });
      await expect.element(notice.getByText("Codex and Claude connect through F5")).toBeVisible();
      await expect
        .element(notice.getByText(/Sign-ins Codex and Claude saved earlier are not carried over/))
        .toBeVisible();
      await expect
        .element(
          notice.getByRole("switch", {
            name: "Let Codex and Claude connect to servers themselves",
          }),
        )
        .not.toBeChecked();

      await openServer("docs", "Sign-in");
      const panel = page.getByRole("region", { name: "F5 sign-in" });
      await expect.element(panel.getByText(/F5 signs in for Codex, Claude, Cursor/)).toBeVisible();
      await expect
        .element(panel.getByText(/Codex and Claude reach this server through F5 now/))
        .toBeVisible();
      await expect.element(panel.getByText("Not signed in", { exact: true })).toBeVisible();
      // The agents' own sign-in is not offered for a server F5 serves them.
      expect(mocks.startLogin).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Codex and Claude sign-in needs a project");
      await page.getByRole("button", { name: "Close" }).first().click();

      // The hub runs stdio servers in the conversation's folder for Claude too.
      await openServer("local");
      const matrix = page.getByRole("region", { name: "Providers" });
      await expect.element(matrix.getByText("Supported").first()).toBeVisible();
      expect(matrix.element().textContent).not.toContain("Limited");
    } finally {
      await screen.unmount();
    }
  });

  it("shows hub status in the row and panel, and reconnects a failed hub connection", async () => {
    const mocks = createNativeApiMock();
    mocks.getHubStatus.mockResolvedValue({
      servers: [
        {
          name: "project-server",
          connectionScope: "session",
          transport: "stdio",
          state: "failed",
          error: "Connection refused",
          attempts: 5,
          attachedSessions: 2,
          projectIds: [PROJECT_ID],
          providers: ["cursor", "opencode"],
          toolCount: 3,
        },
      ],
    });
    const { screen, queryClient } = await renderSettings();
    try {
      // The failure outranks Codex's ready observation, and names where it came from.
      const row = page.getByRole("region", { name: "Project servers" });
      await expect.element(row.getByText("Failed · F5")).toBeVisible();
      await expect.element(row.getByText("Connection refused")).toBeVisible();
      expect(mocks.getHubStatus).toHaveBeenCalledWith({ projectId: PROJECT_ID }, expect.anything());
      await rowAction("project-server", "Reconnect");
      await vi.waitFor(() =>
        expect(mocks.reconnectHubServer).toHaveBeenCalledWith({
          serverName: "project-server",
          projectId: PROJECT_ID,
        }),
      );
      await openServer("project-server");
      const live = page.getByRole("region", { name: "Live status" });
      await expect
        .element(
          live.getByText("Cursor, OpenCode · 2 sessions · one connection per session · 3 tools"),
        )
        .toBeVisible();
      await expect.element(live.getByText("Codex", { exact: true })).toBeVisible();
      await live.getByRole("button", { name: "Reconnect", exact: true }).click();
      await vi.waitFor(() => expect(mocks.reconnectHubServer).toHaveBeenCalledTimes(2));
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("signs in to a hub server on click, finishes from a pasted address, and signs out", async () => {
    const mocks = createNativeApiMock();
    const attempt = {
      attemptId: "attempt-1",
      authorizationUrl: "https://auth.example.test/authorize?client_id=f5&state=s1",
      redirectUrl: "http://127.0.0.1:43123/callback",
      startedAt: "2026-11-25T12:00:00.000Z",
    };
    mocks.getHubAuthStatus.mockResolvedValue({
      servers: [{ name: "docs", signedIn: false, refreshable: false }],
    });
    mocks.startHubSignIn.mockResolvedValue({ status: "pending", attempt });
    mocks.getCommonConfig.mockResolvedValue({
      version: "common-v1",
      servers: {
        ...commonConfig.servers,
        docs: { type: "http", url: "https://docs.example.test/mcp" },
      },
    });
    const { screen, queryClient } = await renderSettings(false);
    try {
      await openServer("docs", "Sign-in");
      const panel = page.getByRole("region", { name: "Sign-in for other agents" });
      await expect.element(panel.getByText("Not signed in", { exact: true })).toBeVisible();
      // Nothing opens until the user asks.
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(mocks.getHubAuthStatus).toHaveBeenCalledWith({}, expect.anything());

      mocks.getHubAuthStatus.mockResolvedValue({
        servers: [{ name: "docs", signedIn: false, refreshable: false, pending: attempt }],
      });
      await panel.getByRole("button", { name: "Sign in", exact: true }).click();
      await vi.waitFor(() =>
        expect(mocks.openExternal).toHaveBeenCalledWith(attempt.authorizationUrl),
      );
      expect(mocks.startHubSignIn).toHaveBeenCalledWith({ serverName: "docs" });
      await expect.element(panel.getByText("Waiting for browser", { exact: true })).toBeVisible();

      const field = panel.getByRole("textbox", { name: "Redirected address for docs" });
      await field.fill(`${attempt.redirectUrl}?code=abc&state=s1`);
      mocks.getHubAuthStatus.mockResolvedValue({
        servers: [
          {
            name: "docs",
            signedIn: true,
            refreshable: true,
            expiresAt: "2026-11-25T13:00:00.000Z",
          },
        ],
      });
      await panel.getByRole("button", { name: "Finish sign-in" }).click();
      await vi.waitFor(() =>
        expect(mocks.completeHubSignIn).toHaveBeenCalledWith({
          attemptId: "attempt-1",
          redirectedUrl: `${attempt.redirectUrl}?code=abc&state=s1`,
        }),
      );
      await expect.element(panel.getByText("Signed in", { exact: true })).toBeVisible();
      await expect.element(panel.getByText("Renews automatically")).toBeVisible();
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);

      mocks.getHubAuthStatus.mockResolvedValue({
        servers: [{ name: "docs", signedIn: false, refreshable: false }],
      });
      await panel.getByRole("button", { name: "Sign out" }).click();
      await vi.waitFor(() =>
        expect(mocks.signOutHubServer).toHaveBeenCalledWith({ serverName: "docs" }),
      );
      await expect.element(panel.getByText("Not signed in", { exact: true })).toBeVisible();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("lists each per-session connection of one server and offers Reconnect unless connecting", async () => {
    const mocks = createNativeApiMock();
    const session = {
      name: "project-server",
      connectionScope: "session" as const,
      transport: "stdio" as const,
      attempts: 0,
      attachedSessions: 1,
      projectIds: [PROJECT_ID],
      providers: ["pi" as const],
    };
    mocks.getHubStatus.mockResolvedValue({
      servers: [
        { ...session, id: "conn-a", state: "ready", toolCount: 2 },
        { ...session, id: "conn-b", state: "connecting" },
      ],
    });
    const { screen, queryClient } = await renderSettings();
    try {
      await openServer("project-server");
      const live = page.getByRole("region", { name: "Live status" });
      await expect.element(live.getByText("Connecting", { exact: true })).toBeVisible();
      expect(live.getByText("F5 connection", { exact: true }).elements()).toHaveLength(2);
      expect(live.getByRole("button", { name: "Reconnect", exact: true }).elements()).toHaveLength(
        1,
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("shows no stuck provider badge without a selected project", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings(false);
    try {
      // Give any (wrongly) pending status query time to render its badge.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(document.body.textContent).not.toContain("Checking...");
      // The header holds no provider badge at all; rows keep their own Unknown state.
      const header = page
        .getByRole("heading", { name: "MCP servers" })
        .element()
        .closest("div")?.parentElement;
      expect(header?.textContent).not.toMatch(/Unknown|Control ready|Configured/u);
      expect(mocks.getServerStatuses).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("shows which providers get a server and turns one off", async () => {
    const mocks = createNativeApiMock();
    mocks.getProjectConfig.mockResolvedValue({
      ...projectConfig,
      servers: {
        "project-server": { type: "stdio", command: "project-command", cwd: "/srv" },
      },
    });
    const { screen, queryClient } = await renderSettings();
    try {
      await openServer("project-server");
      const matrix = page.getByRole("region", { name: "Providers" });
      // Claude ignores the working directory; other providers support every set field.
      await expect.element(matrix.getByText("Limited", { exact: true })).toBeVisible();
      await expect
        .element(
          matrix.getByText(
            "Ignores the working directory; the server starts in the conversation's",
          ),
        )
        .toBeVisible();
      expect(document.body.textContent).not.toContain("Codex only");
      await matrix.getByRole("switch", { name: "Use project-server with Pi" }).click();
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            servers: {
              "project-server": {
                type: "stdio",
                command: "project-command",
                cwd: "/srv",
                disabledProviders: ["pi"],
              },
            },
          }),
        ),
      );
      await expect.element(matrix.getByText("Off", { exact: true })).toBeVisible();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("refreshes configuration but not live statuses after a save, and marks the old check", async () => {
    const mocks = createNativeApiMock();
    mocks.getServerStatuses.mockImplementation(async ({ provider, projectId }) => ({
      provider,
      projectId,
      support: "supported" as const,
      source: "configurationCheck" as const,
      desiredVersion: "effective-v1",
      configVersion: "effective-v1",
      statuses: [
        {
          name: "project-server",
          state: "failed" as const,
          authStatus: "unknown" as const,
          error: "old endpoint failure",
          toolCount: 0,
          resourceCount: 0,
          resourceTemplateCount: 0,
        },
      ],
    }));
    const { screen, queryClient } = await renderSettings();
    try {
      await vi.waitFor(() => expect(mocks.getServerStatuses).toHaveBeenCalled());
      await vi.waitFor(() => expect(mocks.getEffectiveConfig).toHaveBeenCalled());
      await vi.waitFor(() => expect(document.body.textContent).toContain("Failed"));
      const statusCalls = mocks.getServerStatuses.mock.calls.length;
      const effectiveCalls = mocks.getEffectiveConfig.mock.calls.length;
      mocks.getEffectiveConfig.mockResolvedValue({
        ...effectiveConfig,
        effectiveVersion: "effective-v2",
      });
      await page
        .getByRole("switch", { name: "Enable MCP server project-server", exact: true })
        .click();
      await vi.waitFor(() => expect(mocks.replaceProjectConfig).toHaveBeenCalled());
      await vi.waitFor(() =>
        expect(mocks.getEffectiveConfig.mock.calls.length).toBeGreaterThan(effectiveCalls),
      );
      // The check described the configuration before the save: it is not shown as current.
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("Not checked since the last save"),
      );
      expect(document.body.textContent).not.toContain("Failed");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mocks.getServerStatuses.mock.calls.length).toBe(statusCalls);
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("shows the Codex streamable HTTP hint only when editing SSE", async () => {
    createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    try {
      await openAddServer();
      expect(document.body.textContent).not.toContain(CODEX_SSE_TRANSPORT_HINT);
      await page.getByRole("combobox", { name: "MCP transport type" }).click();
      await page.getByRole("option", { name: "sse", exact: true }).click();
      await vi.waitFor(() => expect(document.body.textContent).toContain(CODEX_SSE_TRANSPORT_HINT));
      await page.getByRole("combobox", { name: "MCP transport type" }).click();
      await page.getByRole("option", { name: "http", exact: true }).click();
      await vi.waitFor(() =>
        expect(document.body.textContent).not.toContain(CODEX_SSE_TRANSPORT_HINT),
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("never polls login and refreshes it when completion is pushed", async () => {
    const mocks = createNativeApiMock();
    let status: McpLoginStatusResult["status"] = "idle";
    mocks.getLoginStatus.mockImplementation(async ({ provider, projectId, serverName }) => ({
      target: "server",
      mode: "cli",
      provider,
      projectId,
      ...(serverName ? { serverName } : {}),
      status,
    }));
    mocks.getServerStatuses.mockResolvedValue({
      provider: "codex",
      projectId: PROJECT_ID,
      support: "supported",
      configVersion: "effective-v1",
      statuses: [
        {
          name: "project-server",
          state: "login-required",
          authStatus: "unauthenticated",
          toolCount: 0,
          resourceCount: 0,
          resourceTemplateCount: 0,
        },
      ],
    });
    mocks.startLogin.mockImplementation(async () => {
      status = "pending";
      return {
        target: "server",
        mode: "cli",
        provider: "codex",
        projectId: PROJECT_ID,
        serverName: "project-server",
        status,
      };
    });
    const { screen, queryClient } = await renderSettings();
    const interval = () => new Promise((resolve) => setTimeout(resolve, 2_200));
    try {
      await openServer("project-server", "Sign-in");
      await vi.waitFor(() => expect(mocks.getLoginStatus).toHaveBeenCalled());
      const initial = mocks.getLoginStatus.mock.calls.length;
      await interval();
      expect(mocks.getLoginStatus).toHaveBeenCalledTimes(initial);
      await page.getByRole("button", { name: "Login", exact: true }).click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Logging in..."));
      // Pending sign-in is not polled either.
      const pending = mocks.getLoginStatus.mock.calls.length;
      await interval();
      expect(mocks.getLoginStatus.mock.calls.length).toBeLessThanOrEqual(pending + 1);
      status = "completed";
      const listener = mocks.onStatusUpdated.mock.calls[0]![0];
      listener({
        provider: "codex",
        scope: "project",
        projectId: PROJECT_ID,
        reason: "login-completed",
      });
      await vi.waitFor(() => expect(document.body.textContent).not.toContain("Logging in..."), {
        timeout: 3_000,
      });
      // One subscription however many views use MCP status.
      expect(mocks.onStatusUpdated).toHaveBeenCalledTimes(1);
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("renders the effective JSON export and copies the canonical merged config", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();

    try {
      const effectiveJson = formatMcpServersAsJson(effectiveConfig.servers);

      await vi.waitFor(() => {
        const exportTextarea = document.querySelector<HTMLTextAreaElement>("textarea[readonly]");
        expect(exportTextarea?.value).toBe(effectiveJson);
      });

      expect(document.body.textContent?.toLowerCase()).not.toContain("redacted");

      await page.getByRole("button", { name: "Copy JSON" }).click();

      expect(copyToClipboard).toHaveBeenCalledWith(effectiveJson, undefined);
      expect(mocks.getEffectiveConfig).toHaveBeenCalledWith({ projectId: PROJECT_ID });
      await captureSettingsScreenshot();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("follows the settings scope and applies that scope's layer to live sessions", async () => {
    const mocks = createNativeApiMock();
    const project = await renderSettings();
    try {
      // A project lists its own servers and the common ones it inherits; no scope toggle.
      expect(document.body.textContent).toContain("Project servers (1/16)");
      await expect
        .element(
          page.getByRole("region", { name: "Inherited from common" }).getByText("common-server"),
        )
        .toBeVisible();
      expect(document.body.textContent).not.toMatch(/Provider\s*Codex\s*Claude/u);
      await page.getByRole("button", { name: "Apply to live sessions", exact: true }).click();
      await vi.waitFor(() =>
        expect(mocks.applyToLiveSessions).toHaveBeenCalledWith({
          scope: "project",
          projectId: PROJECT_ID,
        }),
      );
      await captureSettingsScreenshot();
    } finally {
      project.queryClient.clear();
      await project.screen.unmount();
    }
    const global = await renderSettings(false);
    try {
      expect(document.body.textContent).toContain("Common servers (1/16)");
      expect(document.body.textContent).not.toContain("Inherited from common");
      await page.getByRole("button", { name: "Apply to live sessions", exact: true }).click();
      await vi.waitFor(() =>
        expect(mocks.applyToLiveSessions).toHaveBeenCalledWith({ scope: "common" }),
      );
    } finally {
      global.queryClient.clear();
      await global.screen.unmount();
    }
  });

  it("shows Connect for a failed Codex OAuth MCP server and starts OAuth login", async () => {
    const mocks = createNativeApiMock();
    const observabilityServer = {
      type: "http" as const,
      url: "https://observability.example.test/v1/mcp",
    };

    mocks.getProjectConfig.mockResolvedValue({
      ...projectConfig,
      servers: {
        ...projectConfig.servers,
        Observability: observabilityServer,
      },
    });
    mocks.getEffectiveConfig.mockResolvedValue({
      ...effectiveConfig,
      servers: {
        ...effectiveConfig.servers,
        Observability: observabilityServer,
      },
    });
    mocks.getServerStatuses.mockResolvedValue({
      provider: "codex",
      projectId: PROJECT_ID,
      support: "supported",
      configVersion: "effective-v1",
      statuses: [
        {
          name: "project-server",
          state: "ready",
          authStatus: "authenticated",
          toolCount: 1,
          resourceCount: 0,
          resourceTemplateCount: 0,
        },
        {
          name: "Observability",
          state: "failed",
          authStatus: "authenticated",
          toolCount: 0,
          resourceCount: 0,
          resourceTemplateCount: 0,
          message:
            "OAuth token refresh failed: Failed to parse server response, when send initialize request",
        },
      ],
    });
    mocks.getLoginStatus.mockImplementation(async ({ provider, projectId, serverName }) => ({
      target: serverName ? ("server" as const) : ("provider" as const),
      mode: serverName === "Observability" ? ("oauth" as const) : ("cli" as const),
      provider,
      projectId,
      ...(serverName ? { serverName } : {}),
      status: "idle" as const,
    }));
    mocks.startLogin.mockResolvedValue({
      target: "server",
      mode: "oauth",
      provider: "codex",
      projectId: PROJECT_ID,
      serverName: "Observability",
      status: "pending",
      authorizationUrl: "https://auth.example.test",
    });

    const { screen, queryClient } = await renderSettings();

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Observability");
      });
      // The row shows the failure; sign-in lives on the panel's Sign-in tab.
      await expect
        .element(page.getByText("OAuth token refresh failed", { exact: false }))
        .toBeVisible();
      await openServer("Observability", "Sign-in");

      await page.getByRole("button", { name: "Connect", exact: true }).click();

      await vi.waitFor(() => {
        expect(mocks.startLogin).toHaveBeenCalledWith({
          provider: "codex",
          instanceId: "codex",
          projectId: PROJECT_ID,
          serverName: "Observability",
        });
      });
      expect(mocks.openExternal).toHaveBeenCalledWith("https://auth.example.test");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("shows OAuth startup failures without opening the browser", async () => {
    const mocks = createNativeApiMock();
    const observabilityServer = {
      type: "http" as const,
      url: "https://observability.example.test/v1/mcp",
    };

    mocks.getProjectConfig.mockResolvedValue({
      ...projectConfig,
      servers: {
        ...projectConfig.servers,
        Observability: observabilityServer,
      },
    });
    mocks.getEffectiveConfig.mockResolvedValue({
      ...effectiveConfig,
      servers: {
        ...effectiveConfig.servers,
        Observability: observabilityServer,
      },
    });
    mocks.getServerStatuses.mockResolvedValue({
      provider: "codex",
      projectId: PROJECT_ID,
      support: "supported",
      configVersion: "effective-v1",
      statuses: [
        {
          name: "Observability",
          state: "failed",
          authStatus: "authenticated",
          toolCount: 0,
          resourceCount: 0,
          resourceTemplateCount: 0,
        },
      ],
    });
    mocks.getLoginStatus.mockImplementation(async ({ provider, projectId, serverName }) => ({
      target: serverName ? ("server" as const) : ("provider" as const),
      mode: serverName === "Observability" ? ("oauth" as const) : ("cli" as const),
      provider,
      projectId,
      ...(serverName ? { serverName } : {}),
      status: "idle" as const,
    }));
    mocks.startLogin.mockRejectedValue(
      new Error("OAuth callback listener is not reachable at http://127.0.0.1:3118/callback."),
    );

    const { screen, queryClient } = await renderSettings();

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Observability");
      });
      await openServer("Observability", "Sign-in");

      await page.getByRole("button", { name: "Connect", exact: true }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(
          "OAuth callback listener is not reachable at http://127.0.0.1:3118/callback.",
        );
      });
      expect(mocks.openExternal).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
  it("keeps editing, toggling, and removing connected through the extracted components", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    try {
      await rowAction("project-server", "Edit");
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("updated-command");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => {
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith({
          projectId: PROJECT_ID,
          expectedVersion: "project-v1",
          servers: {
            "project-server": { type: "stdio", command: "updated-command" },
          },
        });
      });
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page
        .getByRole("switch", { name: "Enable MCP server project-server", exact: true })
        .click();
      await vi.waitFor(() => {
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith({
          projectId: PROJECT_ID,
          expectedVersion: "project-v2",
          servers: {
            "project-server": { type: "stdio", command: "updated-command", enabled: false },
          },
        });
      });
      await openServer("project-server", "Configuration");
      await expect
        .element(page.getByRole("switch", { name: "Enable MCP server", exact: true }))
        .not.toBeChecked();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await rowAction("project-server", "Remove");
      await page.getByRole("button", { name: "Remove server", exact: true }).click();
      await vi.waitFor(() => {
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith({
          projectId: PROJECT_ID,
          expectedVersion: "project-v2",
          servers: {},
        });
        expect(document.body.textContent).toContain("No MCP servers configured for this scope.");
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("imports into the selected scope and keeps pasted text after a failed save", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings(false);
    const pasted = '{"mcpServers":{"docs":{"url":"https://example.test/mcp"}}}';
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain("Common servers (1/16)"));
      await openAddServer("Paste JSON or TOML");
      const importInput = page.getByRole("textbox", {
        name: "Configuration to import",
        exact: true,
      });
      await importInput.fill(pasted);
      mocks.replaceCommonConfig.mockRejectedValueOnce(new Error("Save failed"));
      await page.getByRole("button", { name: /^Import \d+ into/ }).click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Save failed"));
      await expect.element(importInput).toHaveValue(pasted);
      await page.getByRole("button", { name: /^Import \d+ into/ }).click();
      await vi.waitFor(() => {
        expect(mocks.replaceCommonConfig).toHaveBeenLastCalledWith({
          expectedVersion: "common-v1",
          servers: {
            ...commonConfig.servers,
            docs: { type: "http", url: "https://example.test/mcp" },
          },
        });
        expect(document.body.textContent).toContain("Common servers (2/16)");
      });
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(mocks.replaceProjectConfig).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("renames a server without losing other entries", async () => {
    const mocks = createNativeApiMock();
    const otherServer = { type: "stdio" as const, command: "other-command", enabled: false };
    mocks.getProjectConfig.mockResolvedValue({
      ...projectConfig,
      servers: {
        ...projectConfig.servers,
        untouched: otherServer,
      },
    });
    const { screen, queryClient } = await renderSettings();
    try {
      await rowAction("project-server", "Edit");
      await page.getByRole("textbox", { name: "Name", exact: true }).fill(" renamed-server ");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => {
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith({
          projectId: PROJECT_ID,
          expectedVersion: "project-v1",
          servers: {
            "renamed-server": { type: "stdio", command: "project-command" },
            untouched: otherServer,
          },
        });
      });
      // The panel follows the rename.
      await expect.element(page.getByRole("heading", { name: "renamed-server" })).toBeVisible();
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("renamed-server");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("keeps a failed save draft and preserves basic versus advanced error clearing", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    try {
      await rowAction("project-server", "Edit");
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("renamed-server");
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("updated-command");
      mocks.replaceProjectConfig.mockRejectedValueOnce(new Error("Draft save failed"));
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Draft save failed");
      });
      await expect.element(page.getByRole("heading", { name: "project-server" })).toBeVisible();
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("renamed-server");
      await expect
        .element(page.getByRole("textbox", { name: "Command", exact: true }))
        .toHaveValue("updated-command");
      await page.getByRole("button", { name: /Advanced options/ }).click();
      await page.getByRole("textbox", { name: "Startup timeout (sec)", exact: true }).fill("30");
      expect(document.body.textContent).toContain("Draft save failed");
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("retry-command");
      await vi.waitFor(() => expect(document.body.textContent).not.toContain("Draft save failed"));
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => {
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith({
          projectId: PROJECT_ID,
          expectedVersion: "project-v1",
          servers: {
            "renamed-server": {
              type: "stdio",
              command: "retry-command",
              startupTimeoutSec: 30,
            },
          },
        });
      });
      await expect.element(page.getByRole("heading", { name: "renamed-server" })).toBeVisible();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("asks before closing a panel with unsaved changes, and reopens on the saved values", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    try {
      await rowAction("project-server", "Edit");
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("unsaved-name");
      await page.getByRole("button", { name: /Advanced options/ }).click();
      await page.getByRole("textbox", { name: "OAuth callback port", exact: true }).fill("0");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          "OAuth callback port must be between 1 and 65535.",
        ),
      );
      await page.getByRole("button", { name: "Close", exact: true }).click();
      // Keeping the changes leaves the panel open.
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("unsaved-name");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "project-server" }))
        .not.toBeInTheDocument();
      await openServer("project-server", "Configuration");
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("project-server");
      expect(document.body.textContent).not.toContain("OAuth callback port must be between");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await openAddServer("Paste JSON or TOML");
      await expect
        .element(page.getByRole("textbox", { name: "Configuration to import" }))
        .toHaveValue("");
      expect(mocks.replaceCommonConfig).not.toHaveBeenCalled();
      expect(mocks.replaceProjectConfig).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("rejects adding a seventeenth server without saving or clearing the draft", async () => {
    const mocks = createNativeApiMock();
    mocks.getProjectConfig.mockResolvedValue({
      ...projectConfig,
      servers: {
        ...projectConfig.servers,
        ...Object.fromEntries(
          Array.from({ length: 15 }, (_, index) => [
            `extra-${index}`,
            { type: "stdio" as const, command: "node" },
          ]),
        ),
      },
    });
    const { screen, queryClient } = await renderSettings();
    try {
      await openAddServer();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("seventeenth");
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("node");
      await addServerSubmit().click();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          "You can save at most 16 MCP servers per scope.",
        ),
      );
      expect(mocks.replaceProjectConfig).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("seventeenth");
      expect(document.body.textContent).toContain("Project servers (16/16)");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("preserves all entries while editing, toggling, removing, and importing in an oversized legacy layer", async () => {
    const mocks = createNativeApiMock();
    const servers = Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [
        `legacy-${String(i).padStart(2, "0")}`,
        { type: "stdio" as const, command: "node", args: ["", "  spaces  "] },
      ]),
    );
    mocks.getProjectConfig.mockResolvedValue({ ...projectConfig, servers });
    const { screen, queryClient } = await renderSettings();
    try {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("Project servers (18/16)"),
      );
      await rowAction("legacy-17", "Edit");
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("updated");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: { ...servers, "legacy-17": { ...servers["legacy-17"], command: "updated" } },
          }),
        ),
      );
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("switch", { name: "Enable MCP server legacy-17", exact: true }).click();
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: {
              ...servers,
              "legacy-17": { ...servers["legacy-17"], command: "updated", enabled: false },
            },
          }),
        ),
      );
      await rowAction("legacy-17", "Remove");
      await page.getByRole("button", { name: "Remove server", exact: true }).click();
      const remaining = { ...servers };
      delete remaining["legacy-17"];
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({ servers: remaining }),
        ),
      );
      await openAddServer("Paste JSON or TOML");
      const importInput = page.getByRole("textbox", {
        name: "Configuration to import",
        exact: true,
      });
      await importInput.fill(
        JSON.stringify({ mcpServers: { "legacy-16": { command: "imported", args: [] } } }),
      );
      await page.getByRole("button", { name: "Replace all conflicts", exact: true }).click();
      await page.getByRole("button", { name: /^Import \d+ into/ }).click();
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: {
              ...remaining,
              "legacy-16": { type: "stdio", command: "imported", args: [] },
            },
          }),
        ),
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("saves explicit disabled parallel tool calls", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    try {
      await rowAction("project-server", "Edit");
      await page.getByRole("button", { name: /Advanced options/ }).click();
      await page
        .getByRole("combobox", { name: "Supports parallel tool calls" })
        .selectOptions("disabled");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: {
              "project-server": {
                ...projectConfig.servers["project-server"],
                supportsParallelToolCalls: false,
              },
            },
          }),
        ),
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("rejects import overflow without saving or clearing pasted text", async () => {
    const mocks = createNativeApiMock();
    const existingServers = {
      ...projectConfig.servers,
      ...Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => [
          `existing-${index}`,
          { type: "stdio" as const, command: "node" },
        ]),
      ),
    };
    mocks.getProjectConfig.mockResolvedValue({ ...projectConfig, servers: existingServers });
    const { screen, queryClient } = await renderSettings();
    try {
      await openAddServer("Paste JSON or TOML");
      const importInput = page.getByRole("textbox", {
        name: "Configuration to import",
        exact: true,
      });
      await importInput.fill(
        JSON.stringify({
          mcpServers: {
            first: { command: "first-command" },
            second: { command: "second-command" },
            third: { command: "third-command" },
          },
        }),
      );
      await expect.element(page.getByRole("button", { name: /^Import \d+ into/ })).toBeDisabled();
      await vi.waitFor(() => {
        expect(mocks.replaceProjectConfig).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain(
          "You can save at most 16 MCP servers per scope.",
        );
        expect(document.body.textContent).toContain("Project servers (15/16)");
      });
      await expect.element(importInput).not.toHaveValue("");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("adds a server from the form and opens its panel", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    try {
      await openAddServer();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("added");
      await page.getByRole("textbox", { name: "Description", exact: true }).fill("Added server");
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("node");
      await addServerSubmit().click();
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: {
              ...projectConfig.servers,
              added: {
                type: "stdio",
                command: "node",
                description: "Added server",
                enabled: true,
              },
            },
          }),
        ),
      );
      await expect.element(page.getByRole("heading", { name: "added", exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("tab", { name: "Overview" }))
        .toHaveAttribute("aria-selected", "true");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("duplicates a server and moves one to common scope", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    try {
      await rowAction("project-server", "Duplicate");
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: {
              ...projectConfig.servers,
              "project-server_copy": projectConfig.servers["project-server"],
            },
          }),
        ),
      );
      mocks.replaceProjectConfig.mockClear();
      await rowAction("project-server", "Move to common");
      await vi.waitFor(() =>
        expect(mocks.replaceCommonConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: {
              ...commonConfig.servers,
              "project-server": projectConfig.servers["project-server"],
            },
          }),
        ),
      );
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: { "project-server_copy": projectConfig.servers["project-server"] },
          }),
        ),
      );
      // The common write lands before the project entry is removed.
      expect(mocks.replaceCommonConfig.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.replaceProjectConfig.mock.invocationCallOrder[0]!,
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("opens the linked server's panel, including an inherited one", async () => {
    createNativeApiMock();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <McpServersSettings
          selectedProject={{ id: PROJECT_ID, name: "Project One" }}
          hasProjects
          focusServer="COMMON-server"
        />
      </QueryClientProvider>,
    );
    try {
      await expect
        .element(page.getByRole("heading", { name: "common-server", exact: true }))
        .toBeVisible();
      expect(document.body.textContent).toContain("inherited from common scope");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("overrides an inherited server in the project from its entry", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    try {
      await rowAction("common-server", "Override");
      await expect
        .element(page.getByRole("heading", { name: "Override common-server" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("common-server");
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("project-override");
      await addServerSubmit().click();
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: {
              ...projectConfig.servers,
              "common-server": { type: "stdio", command: "project-override" },
            },
          }),
        ),
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
});

it("keeps automatic selection automatic and recovers after an explicitly selected conversation stops", async () => {
  const mocks = createNativeApiMock();
  const first = ThreadId.make("first-running"),
    second = ThreadId.make("second-running");
  let live = [first, second];
  mocks.getServerStatuses.mockImplementation(async (input) => {
    const requested = (input as { threadId?: ThreadId }).threadId;
    if (requested && !live.includes(requested))
      throw new Error("The conversation is not running in this project and account.");
    const threadId = requested ?? live[0];
    return {
      provider: input.provider,
      projectId: PROJECT_ID,
      support: "supported",
      source: threadId ? "conversation" : "configurationCheck",
      ...(threadId ? { threadId } : {}),
      generation: 1,
      appliedVersion: "saved",
      fingerprint: "execution",
      statuses: [],
      sessions: live.map((id) => ({
        threadId: id,
        instanceId: ProviderInstanceId.make("codex"),
        generation: 1,
        lastSeenAt: "2026-10-18T10:00:00Z",
        busy: false,
      })),
    };
  });
  noteWsConnectionOpened();
  const { screen, queryClient } = await renderSettings();
  try {
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Observed in first-running"),
    );
    expect(mocks.getServerStatuses).toHaveBeenCalledTimes(1);
    expect(
      (document.querySelector('[aria-label="Observed conversation"]') as HTMLSelectElement).value,
    ).toBe("");
    live = [second];
    await openProviderManaged();
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Observed in second-running"),
    );
    expect(
      mocks.getServerStatuses.mock.calls.every(
        ([input]) => !(input as { threadId?: string }).threadId,
      ),
    ).toBe(true);
    await page.getByRole("combobox", { name: "Observed conversation" }).selectOptions(second);
    await vi.waitFor(() =>
      expect(
        mocks.getServerStatuses.mock.calls.some(
          ([input]) => (input as { threadId?: string }).threadId === second,
        ),
      ).toBe(true),
    );
    live = [];
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await vi.waitFor(() =>
      expect(
        (document.querySelector('[aria-label="Observed conversation"]') as HTMLSelectElement).value,
      ).toBe(""),
    );
    await vi.waitFor(() => expect(document.body.textContent).toContain("Configuration check"));
    expect(document.body.textContent).not.toContain("not running in this project");
  } finally {
    screen.unmount();
    queryClient.clear();
  }
});

it("retries a failed reconnect with targeted Reconnect rather than Apply", async () => {
  const mocks = createNativeApiMock();
  const threadId = ThreadId.make("reconnect-thread");
  mocks.reconnectServer.mockResolvedValue({
    settingsConnectionReloaded: false,
    sessionsMatched: 1,
    sessionsReconnected: 0,
    failures: [{ threadId, message: "fixture failure" }],
    sessions: [
      {
        threadId,
        instanceId: ProviderInstanceId.make("codex"),
        generation: 1,
        requestedVersion: "saved",
        attemptedVersion: "saved",
        disposition: "failed",
        result: {
          converged: false,
          restartRequired: false,
          servers: [],
          errors: [{ message: "fixture failure" }],
        },
      },
    ],
  });
  mocks.getServerStatuses.mockResolvedValue({
    provider: "codex",
    projectId: PROJECT_ID,
    support: "supported",
    statuses: [
      {
        name: "project-server",
        state: "failed",
        authStatus: "unknown",
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
      },
    ],
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await rowAction("project-server", "Reconnect");
    await vi.waitFor(() => expect(mocks.reconnectServer).toHaveBeenCalledTimes(1));
    await openServer("project-server");
    await page.getByRole("button", { name: "Retry in this conversation", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.reconnectServer).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        instanceId: "codex",
        serverName: "project-server",
        threadIds: [threadId],
      }),
    );
    expect(mocks.applyToLiveSessions).not.toHaveBeenCalled();
  } finally {
    screen.unmount();
    queryClient.clear();
  }
});

it("shows Claude CLI preflight failures without starting a conversation", async () => {
  const mocks = createNativeApiMock();
  mocks.getServerStatuses.mockImplementation(async (input) => ({
    provider: input.provider,
    projectId: PROJECT_ID,
    source: "configurationCheck",
    support: "supported",
    statuses: [],
  }));
  mocks.getProviderStatus.mockResolvedValue({
    provider: "claudeAgent",
    projectId: PROJECT_ID,
    support: "unavailable",
    available: false,
    authStatus: "unknown",
    supportMessage: "Claude CLI is not installed.",
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await page.getByRole("combobox", { name: "Status account" }).selectOptions("claudeAgent");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Unavailable"));
    expect(document.body.textContent).toContain("Claude CLI is not installed.");
    expect(mocks.getProviderStatus).toHaveBeenCalledWith(
      {
        provider: "claudeAgent",
        projectId: PROJECT_ID,
        instanceId: "claudeAgent",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  } finally {
    screen.unmount();
    queryClient.clear();
  }
});

it("offers Claude sign-in for managed and external needs-auth servers via the observed conversation", async () => {
  const mocks = createNativeApiMock();
  const threadId = ThreadId.make("claude-conversation");
  const needsAuth = {
    state: "needs-auth" as const,
    authStatus: "unauthenticated" as const,
    toolCount: 0,
    resourceCount: 0,
    resourceTemplateCount: 0,
  };
  mocks.getServerStatuses.mockImplementation(async (input) => ({
    provider: input.provider,
    projectId: PROJECT_ID,
    support: "supported",
    configVersion: "effective-v1",
    ...(input.provider === "claudeAgent" ? { source: "conversation" as const, threadId } : {}),
    statuses: [
      { name: "project-server", ownership: "managed" as const, ...needsAuth },
      { name: "linear", ownership: "external" as const, ...needsAuth },
    ],
  }));
  mocks.startLogin.mockImplementation(async (input: { serverName: string }) => ({
    target: "server",
    mode: "oauth",
    provider: "claudeAgent",
    projectId: PROJECT_ID,
    serverName: input.serverName,
    status: "pending",
    authorizationUrl: `https://auth.example.test/${input.serverName}`,
  }));
  const { screen, queryClient } = await renderSettings();
  try {
    await page.getByRole("combobox", { name: "Status account" }).selectOptions("claudeAgent");
    await openServer("project-server", "Sign-in");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.startLogin).toHaveBeenCalledWith({
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        projectId: PROJECT_ID,
        serverName: "project-server",
        threadId,
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith("https://auth.example.test/project-server"),
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await openProviderManaged();
    await page.getByRole("button", { name: "Sign in to linear", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.startLogin).toHaveBeenCalledWith({
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        projectId: PROJECT_ID,
        serverName: "linear",
        threadId,
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith("https://auth.example.test/linear"),
    );
  } finally {
    screen.unmount();
    queryClient.clear();
  }
});

it("offers Codex sign-in for external needs-auth servers", async () => {
  const mocks = createNativeApiMock();
  mocks.getServerStatuses.mockResolvedValue({
    provider: "codex",
    projectId: PROJECT_ID,
    support: "supported",
    configVersion: "effective-v1",
    statuses: [
      {
        name: "linear",
        state: "needs-auth",
        ownership: "external",
        authStatus: "unauthenticated",
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
      },
    ],
  });
  mocks.startLogin.mockResolvedValue({
    target: "server",
    mode: "oauth",
    provider: "codex",
    projectId: PROJECT_ID,
    serverName: "linear",
    status: "pending",
    authorizationUrl: "https://auth.example.test/codex-linear",
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await openProviderManaged();
    await page.getByRole("button", { name: "Sign in to linear", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.startLogin).toHaveBeenCalledWith({
        provider: "codex",
        instanceId: "codex",
        projectId: PROJECT_ID,
        serverName: "linear",
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith("https://auth.example.test/codex-linear"),
    );
  } finally {
    screen.unmount();
    queryClient.clear();
  }
});

it("observes only the selected conversation, refreshes on runtime push, and loads inspector data lazily", async () => {
  const mocks = createNativeApiMock();
  const first = ThreadId.make("conversation-one"),
    second = ThreadId.make("conversation-two");
  const sessions = [first, second].map((threadId) => ({
    threadId,
    instanceId: ProviderInstanceId.make("codex"),
    generation: 1,
    lastSeenAt: "2026-10-18T10:00:00.000Z",
    busy: false,
    appliedVersion: "effective-v1",
  }));
  mocks.getServerStatuses.mockImplementation(async (input) => ({
    provider: input.provider,
    projectId: PROJECT_ID,
    source: "conversation",
    threadId: (input as { threadId?: typeof first }).threadId ?? first,
    generation: 1,
    instanceId: ProviderInstanceId.make("codex"),
    desiredVersion: "effective-v1",
    appliedVersion: "effective-v1",
    observedAt: "2026-10-18T10:00:00.000Z",
    complete: true,
    sessions,
    support: "supported",
    statuses: [
      {
        name: "project-server",
        state: "ready",
        ownership: "managed",
        desiredEnabled: true,
        authStatus: "unknown",
        toolCount: 1,
        resourceCount: 0,
        resourceTemplateCount: 0,
      },
    ],
  }));
  noteWsConnectionOpened();
  const { screen, queryClient } = await renderSettings();
  try {
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Observed in conversation-one"),
    );
    expect(mocks.getProviderStatus).not.toHaveBeenCalled();
    expect(mocks.inspectServer).not.toHaveBeenCalled();
    mocks.getServerStatuses.mockClear();
    await openProviderManaged();
    await page.getByRole("combobox", { name: "Observed conversation" }).selectOptions(second);
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Observed in conversation-two"),
    );
    expect(
      mocks.getServerStatuses.mock.calls.every(
        ([input]) => (input as { threadId?: string }).threadId === second,
      ),
    ).toBe(true);
    expect(mocks.inspectServer).not.toHaveBeenCalled();
    await openServer("project-server", "Tools");
    await vi.waitFor(() => expect(mocks.inspectServer).toHaveBeenCalled());
    expect(mocks.inspectServer.mock.calls[0]?.[0]).toMatchObject({
      threadId: second,
      serverName: "project-server",
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Input schemas are not available from this runtime",
      ),
    );
    const before = mocks.getServerStatuses.mock.calls.length;
    mocks.onStatusUpdated.mock.calls[0]?.[0]({
      scope: "project",
      projectId: PROJECT_ID,
      instanceId: ProviderInstanceId.make("codex"),
      reason: "runtime",
    });
    await vi.waitFor(() =>
      expect(mocks.getServerStatuses.mock.calls.length).toBeGreaterThan(before),
    );
  } finally {
    screen.unmount();
    queryClient.clear();
  }
});
it("refreshes selected runtime after reconnect and offers reopening pending sign-in", async () => {
  const mocks = createNativeApiMock();
  mocks.getServerStatuses.mockResolvedValue({
    provider: "codex",
    projectId: PROJECT_ID,
    support: "supported",
    source: "configurationCheck",
    statuses: [
      {
        name: "project-server",
        state: "needs-auth",
        authStatus: "unauthenticated",
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
      },
    ],
  });
  mocks.getLoginStatus.mockResolvedValue({
    provider: "codex",
    projectId: PROJECT_ID,
    target: "server",
    mode: "oauth",
    serverName: "project-server",
    status: "pending",
    authorizationUrl: "https://auth.example.test/pending",
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await openServer("project-server", "Sign-in");
    await page.getByRole("button", { name: "Reopen sign-in", exact: true }).click();
    expect(mocks.openExternal).toHaveBeenCalledWith("https://auth.example.test/pending");
    const before = mocks.getServerStatuses.mock.calls.length;
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Reconnect in Codex", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.reconnectServer).toHaveBeenCalledWith({
        provider: "codex",
        instanceId: "codex",
        projectId: PROJECT_ID,
        serverName: "project-server",
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.getServerStatuses.mock.calls.length).toBeGreaterThan(before),
    );
  } finally {
    screen.unmount();
    queryClient.clear();
  }
});

it("saves project opt-outs without creating a project override", async () => {
  const mocks = createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  try {
    await page.getByRole("switch", { name: "Use common-server in this project" }).click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith({
        projectId: PROJECT_ID,
        expectedVersion: "project-v1",
        servers: projectConfig.servers,
        disabledCommonServers: ["common-server"],
      }),
    );
    await expect
      .element(page.getByRole("switch", { name: "Use common-server in this project" }))
      .not.toBeChecked();
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("previews import warnings and keeps conflicts until explicitly replaced", async () => {
  const mocks = createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  try {
    await openAddServer("Paste JSON or TOML");
    await page.getByRole("textbox", { name: "Configuration to import" }).fill(
      JSON.stringify({
        mcpServers: {
          "project-server": { command: "replacement" },
          remote: { url: "https://example.test", env_http_headers: { Authorization: "TOKEN" } },
        },
      }),
    );
    await expect.element(page.getByRole("button", { name: "Import 1 into project" })).toBeEnabled();
    expect(document.body.textContent).toContain("add values manually");
    await captureSettingsScreenshot();
    await page.getByRole("button", { name: "Replace all conflicts" }).click();
    await page.getByRole("button", { name: "Import 2 into project" }).click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          servers: {
            "project-server": { type: "stdio", command: "replacement" },
            remote: { type: "http", url: "https://example.test" },
          },
        }),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("treats re-importing a stored legacy name as a conflict that Replace renames", async () => {
  const mocks = createNativeApiMock();
  mocks.getProjectConfig.mockResolvedValue({
    ...projectConfig,
    servers: { ...projectConfig.servers, "team.docs": { type: "stdio", command: "old" } },
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await openAddServer("Paste JSON or TOML");
    await page
      .getByRole("textbox", { name: "Configuration to import" })
      .fill(JSON.stringify({ mcpServers: { "team.docs": { command: "new" } } }));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Already saved as 'team.docs'"),
    );
    // Kept by default: nothing would be added next to the stored server.
    await expect.element(page.getByRole("button", { name: "Import 0 into project" })).toBeVisible();
    await page.getByRole("combobox", { name: "Conflict for team_docs" }).selectOptions("replace");
    await page.getByRole("button", { name: "Import 1 into project" }).click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          servers: {
            "project-server": { type: "stdio", command: "project-command" },
            team_docs: { type: "stdio", command: "new" },
          },
        }),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("retains an import draft after a version conflict and requires confirmation against the new base", async () => {
  const mocks = createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  try {
    await openAddServer("Paste JSON or TOML");
    const input = page.getByRole("textbox", { name: "Configuration to import" });
    const text = JSON.stringify({ mcpServers: { imported: { command: "node" } } });
    await input.fill(text);
    mocks.getProjectConfig.mockResolvedValue({
      ...projectConfig,
      version: "new-base",
      servers: { ...projectConfig.servers, concurrent: { type: "stdio", command: "concurrent" } },
    });
    mocks.replaceProjectConfig.mockRejectedValueOnce(
      new Error("MCP configuration changed since this page loaded."),
    );
    await page.getByRole("button", { name: "Import 1 into project" }).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("changed since"));
    await expect.element(input).toHaveValue(text);
    expect(mocks.replaceProjectConfig).toHaveBeenCalledTimes(1);
    await page.getByRole("button", { name: "Import 1 into project" }).click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedVersion: "new-base",
          servers: expect.objectContaining({
            concurrent: { type: "stdio", command: "concurrent" },
            imported: { type: "stdio", command: "node" },
          }),
        }),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("masks stored secrets without putting placeholders or resolved values in editor inputs", async () => {
  const mocks = createNativeApiMock();
  const placeholder = "${f5-secret:00000000-0000-4000-8000-000000000000}";
  mocks.getProjectConfig.mockResolvedValue({
    ...projectConfig,
    servers: { "project-server": { type: "stdio", command: "node", env: { TOKEN: placeholder } } },
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await rowAction("project-server", "Edit");
    await vi.waitFor(() => expect(document.body.textContent).toContain("•••••• (stored secret)"));
    const values = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input, textarea:not([readonly])",
      ),
    ].map((input) => input.value);
    expect(values.join("\n")).not.toContain(placeholder);
    await captureSettingsScreenshot();
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

function toolPolicy(tool: string, choice: "Allow" | "Ask" | "Block") {
  return page.getByRole("group", { name: `Policy for ${tool}` }).getByRole("button", {
    name: choice,
    exact: true,
  });
}

it("tool policies respect allowlists and store Block as the denylist", async () => {
  const mocks = createNativeApiMock();
  mocks.getProjectConfig.mockResolvedValue({
    ...projectConfig,
    servers: {
      "project-server": {
        type: "stdio",
        command: "node",
        enabledTools: ["read"],
        disabledTools: ["read"],
      },
    },
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await openServer("project-server", "Tools");
    await toolPolicy("read", "Allow").click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          servers: {
            "project-server": {
              type: "stdio",
              command: "node",
              enabledTools: ["read"],
            },
          },
        }),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("reads detected configuration only after an explicit Detect click", async () => {
  createNativeApiMock();
  const detect = vi.fn(async () => ({
    candidates: [
      {
        id: "detected",
        name: "detected",
        source: ".mcp.json",
        selectedByDefault: false,
        server: { type: "stdio" as const, command: "node" },
        issues: [],
      },
    ],
    issues: [],
  }));
  nativeApiRef.current!.mcp.listImportCandidates = detect;
  const { screen, queryClient } = await renderSettings();
  try {
    expect(detect).not.toHaveBeenCalled();
    await openAddServer("Import");
    expect(detect).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Detect configurations", exact: true }).click();
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
    await expect
      .element(page.getByRole("button", { name: "Import 0 into project" }))
      .toBeDisabled();
    await page.getByRole("checkbox", { name: "detected", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Import 1 into project" })).toBeEnabled();
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("tests an unsaved draft only on click and opens its bounded tool summaries", async () => {
  const mocks = createNativeApiMock();
  const probe = vi.fn(async () => ({
    ok: true,
    durationMs: 12,
    tools: [{ name: "draft-tool", description: "Tool from the unsaved draft" }],
    toolsTruncated: false,
    resourceCount: 0,
    promptCount: 0,
    authRequired: false,
  }));
  nativeApiRef.current!.mcp.probeServer = probe;
  const { screen, queryClient } = await renderSettings();
  try {
    expect(probe).not.toHaveBeenCalled();
    await openAddServer();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("draft-test");
    await page.getByRole("textbox", { name: "Command", exact: true }).fill("node");
    await page.getByRole("button", { name: "Test", exact: true }).last().click();
    await vi.waitFor(() =>
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          serverName: "draft-test",
          server: expect.objectContaining({ type: "stdio", command: "node" }),
        }),
      ),
    );
    expect(mocks.replaceProjectConfig).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "1 tools", exact: true }).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Tool from the unsaved draft"),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

function SecretFieldsHarness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <McpKeyValueFields label="Environment" value={value} onChange={setValue} />;
}
it.each([false, true])(
  "stores under Strict Mode and preserves concurrent edits (same row: %s)",
  async (editSameRow) => {
    createNativeApiMock();
    let finish!: (result: { placeholder: string }) => void;
    const store = vi.fn(
      () =>
        new Promise<{ placeholder: string }>((resolve) => {
          finish = resolve;
        }),
    );
    nativeApiRef.current!.mcp.storeSecret = store;
    const screen = await render(
      <StrictMode>
        <SecretFieldsHarness
          initial={JSON.stringify([
            { key: "TOKEN", value: "private-value", secret: true },
            { key: "OTHER", value: "original" },
          ])}
        />
      </StrictMode>,
    );
    try {
      await page.getByRole("button", { name: "Store secret", exact: true }).click();
      await vi.waitFor(() => expect(store).toHaveBeenCalledTimes(1));
      await page
        .getByRole("textbox", { name: `Environment value ${editSameRow ? 1 : 2}` })
        .fill("edited");
      finish({ placeholder: "${f5-secret:00000000-0000-4000-8000-000000000000}" });
      if (editSameRow) {
        await expect
          .element(page.getByText("This value changed while storing.", { exact: false }))
          .toBeVisible();
        await expect
          .element(page.getByRole("textbox", { name: "Environment value 1" }))
          .toHaveValue("edited");
      } else {
        await expect.element(page.getByText("•••••• (stored secret)")).toBeVisible();
        await expect
          .element(page.getByRole("textbox", { name: "Environment value 2" }))
          .toHaveValue("edited");
        await page.getByRole("button", { name: "Replace", exact: true }).click();
        await page.getByRole("button", { name: "Cancel replacement", exact: true }).click();
        await expect.element(page.getByText("•••••• (stored secret)")).toBeVisible();
      }
    } finally {
      await screen.unmount();
    }
  },
);
it("keeps legacy key-only lines intact", async () => {
  const screen = await render(<SecretFieldsHarness initial="TOKEN" />);
  try {
    await expect
      .element(page.getByRole("textbox", { name: "Environment key 1" }))
      .toHaveValue("TOKEN");
    await expect
      .element(page.getByRole("textbox", { name: "Environment value 1" }))
      .toHaveValue("");
  } finally {
    await screen.unmount();
  }
});
it("sets Ask per tool and as the default, and accepts a changed tool after review", async () => {
  const mocks = createNativeApiMock();
  mocks.getProjectConfig.mockResolvedValue({
    ...projectConfig,
    servers: { "project-server": { type: "stdio", command: "node" } },
  });
  mocks.listToolPins.mockResolvedValue({
    tools: [
      {
        serverName: "project-server",
        identity: "identity-1",
        identityLabel: "node",
        toolName: "read",
        state: "changed",
        firstSeenAt: "2026-11-01T00:00:00.000Z",
        acceptedAt: "2026-11-01T00:00:00.000Z",
        accepted: '{\n  "description": "Read metadata"\n}',
        observed: '{\n  "description": "Read metadata and upload it"\n}',
      },
    ],
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await openServer("project-server", "Tools");
    const review = page.getByRole("region", { name: "Tools to review" });
    await expect.element(review).toHaveTextContent("1 tool needs review.");
    await expect.element(review).toHaveTextContent("Read metadata and upload it");
    await review.getByRole("button", { name: "Accept change", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.acceptToolChanges).toHaveBeenCalledWith({
        serverName: "project-server",
        identity: "identity-1",
        // The definition shown, so a tool that changed again since is not accepted.
        reviewed: [
          { toolName: "read", definition: '{\n  "description": "Read metadata and upload it"\n}' },
        ],
      }),
    );

    await toolPolicy("read", "Ask").click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          servers: {
            "project-server": { type: "stdio", command: "node", toolPolicy: { read: "ask" } },
          },
        }),
      ),
    );
    await page
      .getByRole("group", { name: "Default tool policy" })
      .getByRole("button", { name: "Ask", exact: true })
      .click();
    // Read's own Ask now matches the default, so it keeps no entry of its own.
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          servers: {
            "project-server": { type: "stdio", command: "node", defaultToolPolicy: "ask" },
          },
        }),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("fills the Add form from a catalog entry, asking for its secret before saving", async () => {
  const mocks = createNativeApiMock();
  mocks.searchCatalog.mockImplementation(async (input?: { query?: string }) => ({
    entries: [
      {
        name: "io.github.acme/mcp-server-project-server",
        title: input?.query ? `Notes for ${input.query}` : "Notes",
        description: "Notes for agents",
        version: "1.2.0",
        remotes: [],
        packages: [
          {
            registryType: "npm",
            identifier: "@acme/notes",
            version: "1.2.0",
            environmentVariables: [{ name: "NOTES_TOKEN", required: true, secret: true }],
            packageArguments: [],
            runtimeArguments: [],
          },
        ],
      },
    ],
  }));
  const toastAdd = vi.spyOn(toastManager, "add");
  const { screen, queryClient } = await renderSettings();
  try {
    await openAddServer("Catalog");
    await page.getByRole("searchbox", { name: "Search the MCP Registry" }).fill("acme");
    await vi.waitFor(() =>
      expect(mocks.searchCatalog).toHaveBeenCalledWith({ query: "acme" }, expect.anything()),
    );
    await page.getByRole("button", { name: "Use Notes for acme: npm package" }).click();

    // The scope already has `project-server`, so the catalog's name gets a suffix.
    await expect.element(page.getByRole("tab", { name: "Form", selected: true })).toBeVisible();
    await expect
      .element(page.getByLabelText("Name", { exact: true }))
      .toHaveValue("project-server-2");
    await expect.element(page.getByLabelText("Command", { exact: true })).toHaveValue("npx");
    await expect
      .element(page.getByLabelText("Argument 2", { exact: true }))
      .toHaveValue("@acme/notes@1.2.0");
    await expect
      .element(page.getByLabelText("Environment key 1", { exact: true }))
      .toHaveValue("NOTES_TOKEN");
    await expect.element(page.getByRole("checkbox", { name: "Secret" })).toBeChecked();
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Review project-server-2 before saving",
        description: "Store a secret for NOTES_TOKEN. Nothing runs until you save.",
      }),
    );
    expect(mocks.replaceProjectConfig).not.toHaveBeenCalled();
  } finally {
    toastAdd.mockRestore();
    queryClient.clear();
    await screen.unmount();
  }
});

it("lists .mcp.json servers and approves the reviewed definition", async () => {
  const mocks = createNativeApiMock();
  const pending = {
    name: "repo-docs",
    server: { type: "stdio" as const, command: "npx", args: ["-y", "docs-mcp"] },
    definitionHash: "hash-1",
    state: "needs-approval" as const,
    overridden: false,
    disabled: false,
  };
  mocks.getRepositoryServers.mockResolvedValue({
    projectId: PROJECT_ID,
    path: "/repo/.mcp.json",
    found: true,
    servers: [
      pending,
      { ...pending, name: "old-tool", definitionHash: "hash-2", state: "changed" },
    ],
    issues: ["leak: Secret references cannot be imported."],
  });
  const approved = {
    projectId: PROJECT_ID,
    path: "/repo/.mcp.json",
    found: true,
    servers: [{ ...pending, state: "approved" as const }],
    issues: [],
  };
  mocks.setRepositoryServerTrust.mockImplementation(async () => {
    mocks.getRepositoryServers.mockResolvedValue(approved);
    return approved;
  });
  const { screen, queryClient } = await renderSettings();
  try {
    const section = page.getByRole("region", { name: "Repository servers" });
    await expect.element(section).toHaveTextContent("/repo/.mcp.json");
    await expect.element(section).toHaveTextContent("Needs approval");
    await expect.element(section).toHaveTextContent("Changed");
    await expect.element(section).toHaveTextContent("leak: Secret references cannot be imported.");

    await section.getByRole("button", { name: "Review", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Approve repo-docs?" });
    await expect.element(dialog).toHaveTextContent("npx");
    await expect.element(dialog).toHaveTextContent("-y");
    await dialog.getByRole("button", { name: "Approve" }).click();
    expect(mocks.setRepositoryServerTrust).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      serverName: "repo-docs",
      trusted: true,
      definitionHash: "hash-1",
    });
    await expect.element(section).toHaveTextContent("Approved");
    await expect.element(section.getByRole("button", { name: "Revoke" })).toBeVisible();
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("shows a server's recent calls, error rate, latency and stderr", async () => {
  const mocks = createNativeApiMock();
  mocks.listActivity.mockResolvedValue({
    calls: [
      {
        id: "call-1",
        createdAt: "2026-11-25T10:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        provider: "codex",
        serverName: "project-server",
        toolName: "read",
        outcome: "error",
        durationMs: 1500,
        approval: "asked",
        errorSummary: "Rate limited",
      },
    ],
    last24h: { calls: 4, errors: 1, p50Ms: 120, p95Ms: 1500 },
    stderrTail: "server started",
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await openServer("project-server", "Activity");
    const summary = page.getByRole("definition").first();
    await expect.element(summary).toHaveTextContent("4");
    await expect.element(page.getByText("25%", { exact: true })).toBeVisible();
    await expect.element(page.getByText("120 ms", { exact: true })).toBeVisible();
    const calls = page.getByRole("list", { name: "Recent calls" });
    await expect.element(calls).toHaveTextContent("Error · 1.5 s");
    await expect.element(calls).toHaveTextContent("Rate limited");
    await expect.element(calls).toHaveTextContent("Asked");
    await expect.element(page.getByText("Server output (stderr)")).toBeVisible();
    expect(mocks.listActivity).toHaveBeenCalledWith(
      { serverName: "project-server", projectId: PROJECT_ID },
      expect.anything(),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("retains disabled tools in a single list when the live listing omits them", async () => {
  const mocks = createNativeApiMock();
  mocks.getProjectConfig.mockResolvedValue({
    ...projectConfig,
    servers: {
      "project-server": { type: "stdio", command: "node", disabledTools: ["hidden"] },
    },
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await openServer("project-server", "Tools");
    await expect.element(toolPolicy("hidden", "Block")).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("read", { exact: true })).toBeVisible();
    await toolPolicy("hidden", "Allow").click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          servers: {
            "project-server": { type: "stdio", command: "node" },
          },
        }),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});
it("opens probe tools and saves switches in common settings without a project", async () => {
  const mocks = createNativeApiMock();
  nativeApiRef.current!.mcp.probeServer = vi.fn(async () => ({
    ok: true,
    durationMs: 1,
    tools: [{ name: "probe-tool" }],
    toolsTruncated: false,
    resourceCount: 0,
    promptCount: 0,
    authRequired: false,
  }));
  const { screen, queryClient } = await renderSettings(false);
  try {
    await openServer("common-server");
    await page.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByRole("button", { name: "1 tools", exact: true }).click();
    await toolPolicy("probe-tool", "Block").click();
    await vi.waitFor(() =>
      expect(mocks.replaceCommonConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          servers: {
            "common-server": {
              type: "stdio",
              command: "common-command",
              disabledTools: ["probe-tool"],
            },
          },
        }),
      ),
    );
    expect(mocks.inspectServer).not.toHaveBeenCalled();
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("marks cross-source duplicate selections on each affected candidate", async () => {
  createNativeApiMock();
  nativeApiRef.current!.mcp.listImportCandidates = vi.fn<NativeApi["mcp"]["listImportCandidates"]>(
    async () => ({
      candidates: [
        {
          id: "first",
          name: "duplicate",
          source: "user config",
          server: { type: "stdio", command: "first" },
          issues: [],
        },
        {
          id: "second",
          name: "duplicate",
          source: "codex config",
          selectedByDefault: false,
          server: { type: "stdio", command: "second" },
          issues: [
            {
              field: "name",
              severity: "warning",
              message:
                "Duplicate name also found in user config. Select only one candidate with this name.",
            },
          ],
        },
      ],
      issues: [],
    }),
  );
  const { screen, queryClient } = await renderSettings();
  try {
    await openAddServer("Import");
    await page.getByRole("button", { name: "Detect configurations", exact: true }).click();
    const candidates = page.getByRole("checkbox", { name: "duplicate", exact: true });
    await expect.element(candidates.first()).toBeChecked();
    await expect.element(candidates.nth(1)).not.toBeChecked();
    await candidates.nth(1).click();
    await expect
      .element(page.getByRole("button", { name: "Import 2 into project" }))
      .toBeDisabled();
    expect(document.body.textContent?.match(/Duplicate selected name/g)).toHaveLength(2);
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("edits arguments in order and preserves multiline key/value content while blocking duplicate keys", async () => {
  const mocks = createNativeApiMock();
  mocks.getProjectConfig.mockResolvedValue({
    ...projectConfig,
    servers: {
      "project-server": {
        type: "stdio",
        command: "node",
        args: ["", " spaced ", "line\nbreak"],
        env: { TOKEN: " a=b\nc " },
      },
    },
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await rowAction("project-server", "Edit");
    await expect
      .element(page.getByRole("textbox", { name: "Argument 1", exact: true }))
      .toHaveValue("");
    await expect
      .element(page.getByRole("textbox", { name: "Environment value 1" }))
      .toHaveValue(" a=b\nc ");
    await page.getByRole("button", { name: "Move argument 3 up" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Argument 2", exact: true }))
      .toHaveValue("line\nbreak");
    await page.getByRole("button", { name: "Add argument", exact: true }).click();
    await page.getByRole("textbox", { name: "Argument 4", exact: true }).fill("last=arg");
    await page.getByRole("button", { name: "Add environment value" }).click();
    await page.getByRole("textbox", { name: "Environment key 2" }).fill("TOKEN");
    await expect
      .element(page.getByRole("textbox", { name: "Environment key 2" }))
      .toHaveAttribute("aria-invalid", "true");
    await expect
      .element(page.getByRole("button", { name: "Save changes", exact: true }))
      .toBeDisabled();
    await page.getByRole("textbox", { name: "Environment key 2" }).fill("OTHER");
    await page.getByRole("textbox", { name: "Environment value 2" }).fill(" x=y\nz ");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          servers: {
            "project-server": {
              type: "stdio",
              command: "node",
              args: ["", "line\nbreak", " spaced ", "last=arg"],
              env: { TOKEN: " a=b\nc ", OTHER: " x=y\nz " },
            },
          },
        }),
      ),
    );
    await captureSettingsScreenshot();
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("confirms removal with the server and scope, and leaves config intact on cancellation", async () => {
  const mocks = createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  try {
    await rowAction("project-server", "Remove");
    await expect
      .element(page.getByRole("alertdialog"))
      .toHaveTextContent("Remove “project-server”?");
    await expect
      .element(page.getByRole("alertdialog"))
      .toHaveTextContent("project scope (Project One)");
    expect(mocks.replaceProjectConfig).not.toHaveBeenCalled();
    await captureSettingsScreenshot();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    expect(mocks.replaceProjectConfig).not.toHaveBeenCalled();
    await rowAction("project-server", "Remove");
    await page.getByRole("button", { name: "Remove server", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({ servers: {} }),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("guards closing Add server and Override with a typed draft, and keeps drafts across panel tabs", async () => {
  createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  try {
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await openAddServer();
    await name.fill("unsaved");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect
      .element(page.getByRole("alertdialog"))
      .toHaveTextContent("Discard unsaved MCP changes?");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect.element(name).toHaveValue("unsaved");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await captureSettingsScreenshot();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await openAddServer();
    await expect.element(name).toHaveValue("");
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await rowAction("project-server", "Edit");
    await name.fill("renamed-draft");
    await page.getByRole("tab", { name: "Tools", exact: true }).click();
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await expect.element(name).toHaveValue("renamed-draft");
    await page.getByRole("button", { name: "Revert", exact: true }).click();
    await expect.element(name).toHaveValue("project-server");
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("keeps newer typing when a save completes and clears the save banner after Apply or scope change", async () => {
  const mocks = createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  let finish!: (result: Awaited<ReturnType<typeof mocks.replaceProjectConfig>>) => void;
  mocks.replaceProjectConfig.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await rowAction("project-server", "Edit");
    const command = page.getByRole("textbox", { name: "Command", exact: true });
    await command.fill("saved-command");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await command.fill("newer-command");
    finish({
      projectId: PROJECT_ID,
      version: "project-v2",
      servers: { "project-server": { type: "stdio", command: "saved-command" } },
    });
    const banner = "Saved. Codex and Claude sessions pick up MCP changes on their next message";
    await vi.waitFor(() => expect(document.body.textContent).toContain(banner));
    await expect.element(command).toHaveValue("newer-command");
    await captureSettingsScreenshot();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await page.getByRole("button", { name: "Apply to all live sessions", exact: true }).click();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain(banner));
    await page
      .getByRole("switch", { name: "Enable MCP server project-server", exact: true })
      .click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(banner));
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <McpServersSettings selectedProject={null} hasProjects />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(document.body.textContent).toContain("common-server"));
    expect(document.body.textContent).not.toContain(banner);
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("shows known row counts and copies sanitized expandable errors", async () => {
  const mocks = createNativeApiMock();
  mocks.getProjectConfig.mockResolvedValue({
    ...projectConfig,
    servers: {
      "project-server": { type: "stdio", command: "node", env: { TOKEN: "private-token-value" } },
    },
  });
  mocks.getServerStatuses.mockResolvedValue({
    provider: "codex",
    projectId: PROJECT_ID,
    support: "supported",
    configVersion: "effective-v1",
    statuses: [
      {
        name: "project-server",
        state: "failed",
        authStatus: "unknown",
        toolCount: 3,
        resourceCount: 2,
        resourceTemplateCount: 0,
        message:
          "Failed private-token-value at https://user:pass@example.test/mcp?token=abc#secret",
      },
    ],
  });
  const { screen, queryClient } = await renderSettings();
  try {
    // The row shows the redacted failure reason.
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Failed [redacted] at https://example.test/mcp"),
    );
    expect(document.body.textContent).not.toContain("private-token-value");
    await openServer("project-server");
    await vi.waitFor(() => expect(document.body.textContent).toContain("3 tools"));
    await page.getByText("Connection details", { exact: true }).click();
    await page.getByRole("button", { name: "Copy error" }).click();
    expect(copyToClipboard).toHaveBeenCalledWith(
      "Failed [redacted] at https://example.test/mcp",
      undefined,
    );
    expect(document.body.textContent).not.toContain("private-token-value");
    await captureSettingsScreenshot();
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("observes the chosen Codex account for live status", async () => {
  const mocks = createNativeApiMock();
  useProfileState.setState({
    active: {
      id: Schema.decodeUnknownSync(ProfileId)("a".repeat(32)),
      slug: "default",
      name: "Default",
      isDefault: true,
      isActive: true,
      status: "ready",
      port: 3773,
      createdAt: "2026-01-01T00:00:00.000Z",
      stateDir: "/tmp/f5",
      providerAccounts: ["one", "two"].map((name) => ({
        driver: "codex",
        instanceId: ProviderInstanceId.make(name),
        displayName: name,
        status: "authenticated",
      })),
    },
  });
  const { screen, queryClient } = await renderSettings();
  try {
    const select = page.getByRole("combobox", { name: "Status account" });
    await expect.element(select).toHaveValue("one");
    expect(
      Array.from((select.element() as HTMLSelectElement).options).map((option) => option.text),
    ).toEqual(["Codex · one", "Codex · two", "Claude"]);
    await select.selectOptions("two");
    await vi.waitFor(() =>
      expect(mocks.getServerStatuses).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "codex", instanceId: "two" }),
        expect.anything(),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
    useProfileState.setState({ active: null });
  }
});

it("does not apply a late secret-store response to a new draft with the same key and value", async () => {
  createNativeApiMock();
  let complete!: (result: { placeholder: string }) => void;
  nativeApiRef.current!.mcp.storeSecret = vi.fn(
    () =>
      new Promise<{ placeholder: string }>((resolve) => {
        complete = resolve;
      }),
  );
  const { screen, queryClient } = await renderSettings();
  const enterValue = async (name: string) => {
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await page.getByRole("button", { name: "Add environment value" }).click();
    await page.getByRole("textbox", { name: "Environment key 1" }).fill("TOKEN");
    await page.getByRole("textbox", { name: "Environment value 1" }).fill("same-draft-value");
    await page.getByRole("checkbox", { name: "Secret", exact: true }).click();
  };
  try {
    await openAddServer();
    await enterValue("first-draft");
    await page.getByRole("button", { name: "Store secret", exact: true }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await openAddServer();
    await enterValue("second-draft");
    complete({ placeholder: "${f5-secret:00000000-0000-4000-8000-000000000000}" });
    await expect
      .element(page.getByRole("textbox", { name: "Environment value 1" }))
      .toHaveValue("same-draft-value");
    await expect
      .element(page.getByRole("button", { name: "Store secret", exact: true }))
      .toBeEnabled();
    expect(document.body.textContent).not.toContain("•••••• (stored secret)");
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("requires explicit creation when the edited server is deleted elsewhere", async () => {
  const mocks = createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  try {
    await rowAction("project-server", "Edit");
    await page.getByRole("textbox", { name: "Command", exact: true }).fill("preserved-draft");
    mocks.getProjectConfig.mockResolvedValue({
      projectId: PROJECT_ID,
      version: "deleted-v2",
      servers: {},
    });
    await queryClient.invalidateQueries({ queryKey: ["mcp", "projectConfig"] });
    await expect
      .element(page.getByRole("button", { name: "Save changes", exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("textbox", { name: "Command", exact: true }))
      .toHaveValue("preserved-draft");
    expect(mocks.replaceProjectConfig).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Create from this draft", exact: true }).click();
    await expect.element(page.getByRole("heading", { name: "Add MCP server" })).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Command", exact: true }))
      .toHaveValue("preserved-draft");
    await addServerSubmit().click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedVersion: "deleted-v2",
          servers: { "project-server": { type: "stdio", command: "preserved-draft" } },
        }),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("merges a provider switch with typing during its save", async () => {
  const mocks = createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  let finish!: (result: Awaited<ReturnType<typeof mocks.replaceProjectConfig>>) => void;
  mocks.replaceProjectConfig.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await rowAction("project-server", "Edit");
    await page.getByRole("textbox", { name: "Command", exact: true }).fill("typed-before-toggle");
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("switch", { name: "Use project-server with Claude", exact: true }).click();
    const toggled = {
      projectId: PROJECT_ID,
      version: "toggle-v2",
      servers: {
        "project-server": {
          type: "stdio" as const,
          command: "project-command",
          disabledProviders: ["claudeAgent" as const],
        },
      },
    };
    mocks.getProjectConfig.mockResolvedValue(toggled);
    finish(toggled);
    await expect
      .element(page.getByRole("switch", { name: "Use project-server with Claude", exact: true }))
      .not.toBeChecked();
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Command", exact: true }))
      .toHaveValue("typed-before-toggle");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          servers: {
            "project-server": {
              type: "stdio",
              command: "typed-before-toggle",
              disabledProviders: ["claudeAgent"],
            },
          },
        }),
      ),
    );
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("explains pending saves when an editor-replacing action is blocked", async () => {
  const mocks = createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  let finish!: (result: Awaited<ReturnType<typeof mocks.replaceProjectConfig>>) => void;
  mocks.replaceProjectConfig.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await rowAction("project-server", "Edit");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toHaveTextContent("Saving MCP changes…");
    finish({ projectId: PROJECT_ID, version: "v2", servers: projectConfig.servers });
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("treats adding then removing an argument as a no-op and keeps focus with moved arguments", async () => {
  createNativeApiMock();
  const { screen, queryClient } = await renderSettings();
  try {
    await openAddServer();
    await page.getByRole("button", { name: "Add argument", exact: true }).click();
    await page.getByRole("button", { name: "Remove argument 1", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Add argument", exact: true }))
      .toHaveFocus();
    // Nothing changed, so closing does not ask to discard.
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Add MCP server" }))
      .not.toBeInTheDocument();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await openAddServer();
    await page.getByRole("button", { name: "Add argument", exact: true }).click();
    await page.getByRole("textbox", { name: "Argument 1", exact: true }).fill("first");
    await page.getByRole("button", { name: "Add argument", exact: true }).click();
    await page.getByRole("textbox", { name: "Argument 2", exact: true }).fill("second");
    await page.getByRole("button", { name: "Move argument 1 down", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Argument 2", exact: true }))
      .toHaveValue("first");
    await expect
      .element(page.getByRole("textbox", { name: "Argument 2", exact: true }))
      .toHaveFocus();
    await page.getByRole("button", { name: "Remove argument 1", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Argument 1", exact: true }))
      .toHaveFocus();
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});

it("scrubs observed-group messages with effective values and keeps informational messages neutral", async () => {
  const mocks = createNativeApiMock();
  mocks.getEffectiveConfig.mockResolvedValue({
    ...effectiveConfig,
    servers: {
      ...effectiveConfig.servers,
      remote: {
        type: "http",
        url: "https://example.test",
        headers: { "X-Custom": "configured-group-secret" },
      },
    },
  });
  mocks.getServerStatuses.mockResolvedValue({
    provider: "codex",
    projectId: PROJECT_ID,
    support: "supported",
    configVersion: "effective-v1",
    statuses: [
      {
        name: "external",
        state: "ready",
        ownership: "external",
        authStatus: "unknown",
        toolCount: 1,
        resourceCount: 0,
        resourceTemplateCount: 0,
        message: "configured-group-secret connected",
      },
      {
        name: "builtin",
        state: "failed",
        ownership: "built-in",
        authStatus: "unknown",
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
        message: "configured-group-secret failed",
      },
    ],
  });
  const { screen, queryClient } = await renderSettings();
  try {
    await openProviderManaged();
    const info = page.getByText("[redacted] connected", { exact: true });
    await expect.element(info).toBeVisible();
    // Informational messages stay plain text; only the failure is an expandable error.
    expect(info.element().closest("details pre")).toBeNull();
    expect(document.querySelectorAll("details details > summary")).toHaveLength(1);
    await page.getByText("Connection details", { exact: true }).click();
    await page.getByRole("button", { name: "Copy error", exact: true }).click();
    expect(copyToClipboard).toHaveBeenCalledWith("[redacted] failed", undefined);
  } finally {
    queryClient.clear();
    await screen.unmount();
  }
});
