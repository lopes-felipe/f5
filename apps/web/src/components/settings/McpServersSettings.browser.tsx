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

  const replaceProjectConfig = vi.fn(
    async (input: Parameters<NativeApi["mcp"]["replaceProjectConfig"]>[0]) => {
      const result = { projectId: input.projectId, version: "project-v2", servers: input.servers };
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
      onStatusUpdated: vi.fn(() => () => {}),
    },
    shell: {
      openExternal,
    },
  } as unknown as NativeApi;

  return {
    replaceProjectConfig,
    replaceCommonConfig,
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
  it("keeps editing, toggling, and removing connected through the extracted components", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    try {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
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
      await expect
        .element(page.getByRole("switch", { name: "Enable MCP server", exact: true }))
        .not.toBeChecked();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await vi.waitFor(() => {
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith({
          projectId: PROJECT_ID,
          expectedVersion: "project-v2",
          servers: {},
        });
        expect(document.body.textContent).toContain("No MCP servers configured for this scope.");
      });
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("imports into the selected scope and keeps pasted text after a failed save", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    const pasted = '{"mcpServers":{"docs":{"url":"https://example.test/mcp"}}}';
    try {
      clickButtonWithExactText("Common");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Common servers (1/16)"));
      const importInput = page.getByPlaceholder(
        '{"mcpServers":{"filesystem":{"type":"stdio","command":"npx","args":["@modelcontextprotocol/server-filesystem"]}}}',
      );
      await importInput.fill(pasted);
      mocks.replaceCommonConfig.mockRejectedValueOnce(new Error("Save failed"));
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Save failed"));
      await expect.element(importInput).toHaveValue(pasted);
      await page.getByRole("button", { name: "Import", exact: true }).click();
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
      await expect.element(importInput).toHaveValue("");
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
      await page.getByRole("button", { name: "Edit", exact: true }).first().click();
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
        expect(document.body.textContent).toContain("Edit renamed-server");
      });
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
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("renamed-server");
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("updated-command");
      mocks.replaceProjectConfig.mockRejectedValueOnce(new Error("Draft save failed"));
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Draft save failed");
        expect(document.body.textContent).toContain("Edit project-server");
      });
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("renamed-server");
      await expect
        .element(page.getByRole("textbox", { name: "Command", exact: true }))
        .toHaveValue("updated-command");
      await page.getByRole("button", { name: /Codex-only options/ }).click();
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
        expect(document.body.textContent).toContain("Edit renamed-server");
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("resets the editor and errors on scope changes while retaining pasted import text", async () => {
    const mocks = createNativeApiMock();
    const { screen, queryClient } = await renderSettings();
    const importText = '{"mcpServers":';
    try {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("unsaved-name");
      await page.getByRole("button", { name: /Codex-only options/ }).click();
      await page.getByRole("textbox", { name: "OAuth callback port", exact: true }).fill("0");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          "OAuth callback port must be between 1 and 65535.",
        ),
      );
      const importInput = page.getByPlaceholder(
        '{"mcpServers":{"filesystem":{"type":"stdio","command":"npx","args":["@modelcontextprotocol/server-filesystem"]}}}',
      );
      await importInput.fill(importText);
      await page.getByRole("button", { name: "Import", exact: true }).click();
      const errorMessages = Array.from(document.querySelectorAll("p.text-destructive")).map(
        (element) => element.textContent,
      );
      expect(errorMessages).toHaveLength(2);
      clickButtonWithExactText("Common");
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Common servers (1/16)");
        expect(document.body.textContent).not.toContain("Edit project-server");
        expect(document.querySelectorAll("p.text-destructive")).toHaveLength(0);
      });
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("");
      await expect
        .element(page.getByRole("textbox", { name: "Command", exact: true }))
        .toHaveValue("");
      await expect
        .element(page.getByRole("switch", { name: "Enable MCP server", exact: true }))
        .toBeChecked();
      await expect
        .element(page.getByRole("button", { name: /Codex-only options/ }))
        .toHaveAttribute("aria-expanded", "false");
      await expect.element(importInput).toHaveValue(importText);
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
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("seventeenth");
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("node");
      await page.getByRole("button", { name: "Add server", exact: true }).last().click();
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
      await page.getByRole("button", { name: "Edit", exact: true }).last().click();
      await page.getByRole("textbox", { name: "Command", exact: true }).fill("updated");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            servers: { ...servers, "legacy-17": { ...servers["legacy-17"], command: "updated" } },
          }),
        ),
      );
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
      await page.getByRole("button", { name: "Remove", exact: true }).last().click();
      const remaining = { ...servers };
      delete remaining["legacy-17"];
      await vi.waitFor(() =>
        expect(mocks.replaceProjectConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({ servers: remaining }),
        ),
      );
      const importInput = page.getByPlaceholder(
        '{"mcpServers":{"filesystem":{"type":"stdio","command":"npx","args":["@modelcontextprotocol/server-filesystem"]}}}',
      );
      await importInput.fill(
        JSON.stringify({ mcpServers: { "legacy-16": { command: "imported", args: [] } } }),
      );
      await page.getByRole("button", { name: "Import", exact: true }).click();
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
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByRole("button", { name: /Codex-only options/ }).click();
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
      const importInput = page.getByPlaceholder(
        '{"mcpServers":{"filesystem":{"type":"stdio","command":"npx","args":["@modelcontextprotocol/server-filesystem"]}}}',
      );
      await importInput.fill(
        JSON.stringify({
          mcpServers: {
            first: { command: "first-command" },
            second: { command: "second-command" },
            third: { command: "third-command" },
          },
        }),
      );
      await page.getByRole("button", { name: "Import", exact: true }).click();
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
});
