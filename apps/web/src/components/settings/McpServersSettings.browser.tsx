import "../../index.css";

import type {
  McpCodexStatusResult,
  McpCommonConfigResult,
  McpEffectiveConfigResult,
  McpProjectConfigResult,
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

const codexStatus: McpCodexStatusResult = {
  projectId: PROJECT_ID,
  support: "supported",
  configVersion: "effective-v1",
};

function createNativeApiMock() {
  const getCommonConfig = vi.fn(async () => commonConfig);
  const getProjectConfig = vi.fn(async () => projectConfig);
  const getEffectiveConfig = vi.fn(async () => effectiveConfig);
  const getCodexStatus = vi.fn(async () => codexStatus);
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
      getCodexStatus,
      applyToLiveSessions,
    },
  } as unknown as NativeApi;

  return {
    getCommonConfig,
    getProjectConfig,
    getEffectiveConfig,
    getCodexStatus,
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
      />
    </QueryClientProvider>,
  );

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("project-server");
  });

  return { screen, queryClient };
}

function scopeToggleButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="toggle"]'));
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

      scopeToggleButtons()[1]?.click();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Common servers (1/16)");
      });

      await page.getByRole("button", { name: "Apply to live sessions" }).click();

      await vi.waitFor(() => {
        expect(mocks.applyToLiveSessions).toHaveBeenCalledWith({
          scope: "common",
        });
      });

      scopeToggleButtons()[0]?.click();

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
});
