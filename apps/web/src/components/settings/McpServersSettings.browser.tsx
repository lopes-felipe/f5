import "../../index.css";

import type {
  McpCommonConfigResult,
  McpEffectiveConfigResult,
  McpLoginStatusResult,
  McpProjectConfigResult,
  McpServerStatusesResult,
  NativeApi,
  ProjectId,
} from "@t3tools/contracts";
import { formatMcpServersAsJson } from "@t3tools/shared/mcpConfig";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { McpServersSettings } from "./McpServersSettings";

const { copyToClipboard, nativeApiRef } = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  nativeApiRef: {
    current: undefined as NativeApi | undefined,
  },
}));

vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard,
    isCopied: false,
  }),
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
    async ({ provider, projectId }: { provider: "codex" | "claudeAgent"; projectId: ProjectId }) =>
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

  nativeApiRef.current = {
    mcp: {
      getCommonConfig,
      getProjectConfig,
      getEffectiveConfig,
      getProviderStatus,
      getServerStatuses,
      getLoginStatus,
      startLogin,
      applyToLiveSessions,
      onStatusUpdated: vi.fn(() => () => {}),
    },
    shell: {
      openExternal,
    },
  } as unknown as NativeApi;

  return {
    getCommonConfig,
    getProjectConfig,
    getEffectiveConfig,
    getProviderStatus,
    getServerStatuses,
    getLoginStatus,
    startLogin,
    openExternal,
    applyToLiveSessions,
  };
}

async function renderSettings() {
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
        selectedProject={{ id: PROJECT_ID, name: "Project One" }}
        hasProjects
        codexBinaryPath=""
        codexHomePath=""
        claudeBinaryPath=""
      />
    </QueryClientProvider>,
  );

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("project-server");
  });

  return { screen, queryClient };
}

function clickButtonWithExactText(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button?.click();
}

describe("McpServersSettings", () => {
  afterEach(() => {
    copyToClipboard.mockReset();
    nativeApiRef.current = undefined;
    document.body.innerHTML = "";
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

      expect(document.body.textContent).toContain("Codex-only options");
      expect(document.body.textContent?.toLowerCase()).not.toContain("redacted");

      await page.getByRole("button", { name: "Copy JSON" }).click();

      expect(copyToClipboard).toHaveBeenCalledWith(effectiveJson, undefined);
      expect(mocks.getEffectiveConfig).toHaveBeenCalledWith({ projectId: PROJECT_ID });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("switches scopes and applies the selected MCP layer to live sessions", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();

    try {
      expect(document.body.textContent).toContain("Project servers (1/16)");

      clickButtonWithExactText("Common");

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Common servers (1/16)");
      });

      await page.getByRole("button", { name: "Apply to live sessions" }).click();

      await vi.waitFor(() => {
        expect(mocks.applyToLiveSessions).toHaveBeenCalledWith({
          scope: "common",
        });
      });

      clickButtonWithExactText("Project");

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Project servers (1/16)");
      });

      await page.getByRole("button", { name: "Apply to live sessions" }).click();

      await vi.waitFor(() => {
        expect(mocks.applyToLiveSessions).toHaveBeenCalledWith({
          scope: "project",
          projectId: PROJECT_ID,
        });
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
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

      await page.getByRole("button", { name: "Connect" }).click();

      await vi.waitFor(() => {
        expect(mocks.startLogin).toHaveBeenCalledWith({
          provider: "codex",
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

      await page.getByRole("button", { name: "Connect" }).click();

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
});
