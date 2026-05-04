import "../index.css";

import type { NativeApi, ProjectId, ServerConfig } from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../appSettings";
import { getRouter } from "../router";
import { useStore } from "../store";

vi.mock("../components/CommandPalette", () => ({
  CommandPalette: ({ children }: { children?: ReactNode }) => children ?? null,
}));

vi.mock("../components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children ?? null,
}));

vi.mock("../components/ModelRecencyController", () => ({
  default: () => null,
}));

vi.mock("../components/ThreadRecencyController", () => ({
  default: () => null,
}));

vi.mock("../components/ThreadStatusNotificationController", () => ({
  default: () => null,
}));

vi.mock("../components/Sidebar", () => ({
  __esModule: true,
  default: () => <div data-testid="mock-thread-sidebar">Mock sidebar</div>,
}));

vi.mock("../components/WebSocketConnectionSurface", () => ({
  SlowRpcWarningToastCoordinator: () => null,
  WebSocketConnectionSurface: ({ children }: { children?: ReactNode }) => children ?? null,
}));

const { nativeApiRef } = vi.hoisted(() => ({
  nativeApiRef: {
    current: undefined as NativeApi | undefined,
  },
}));

vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => {
    if (!nativeApiRef.current) {
      throw new Error("Native API not found");
    }
    return nativeApiRef.current;
  },
  readNativeApi: () => nativeApiRef.current,
}));

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const NOW_ISO = "2026-04-22T12:00:00.000Z";
const PROJECT_ONE = "project-settings-1" as ProjectId;
const PROJECT_TWO = "project-settings-2" as ProjectId;
const MOD_N_SHORTCUT = {
  key: "n",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
} as const;

function fillInput(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) {
    throw new Error(`Missing input: ${selector}`);
  }
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function getCategoryPanel(category: string): HTMLElement {
  const panel = document.querySelector<HTMLElement>(`[data-settings-category-panel="${category}"]`);
  if (!panel) {
    throw new Error(`Missing settings category panel: ${category}`);
  }
  return panel;
}

function expectCategoryVisible(category: string) {
  expect(getCategoryPanel(category).hasAttribute("hidden")).toBe(false);
}

function getCategoryPanelText(category: string): string {
  return getCategoryPanel(category).textContent ?? "";
}

async function selectSettingsProject(projectName: string) {
  const trigger = document.querySelector<HTMLElement>('[aria-label="Settings project"]');
  if (!trigger) {
    throw new Error("Missing settings project picker.");
  }

  trigger.scrollIntoView({ block: "center" });
  trigger.click();

  await vi.waitFor(() => {
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="select-item"]'),
    ).find((candidate) => candidate.textContent?.trim() === projectName);
    expect(option, `Missing settings project option: ${projectName}`).toBeTruthy();
  });

  await page.getByRole("option", { name: projectName }).click();

  await vi.waitFor(() => {
    expect(document.querySelector("[data-base-ui-inert]")).toBeNull();
    expect(
      document.querySelector<HTMLElement>('[aria-label="Settings project"]')?.textContent,
    ).toContain(projectName);
  });
}

function seedAppSettings(settings: Record<string, unknown> = {}) {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      ...parsePersistedAppSettings(null),
      ...settings,
    }),
  );
}

function seedProjects() {
  useStore.setState({
    projects: [
      {
        id: PROJECT_ONE,
        name: "Project One",
        cwd: "/repo/project-one",
        model: "gpt-5.4",
        createdAt: NOW_ISO,
        expanded: true,
        scripts: [],
        skills: [],
        memories: [
          {
            id: "memory-1",
            projectId: PROJECT_ONE,
            scope: "project",
            type: "project",
            name: "Build rule",
            description: "Keep changes small.",
            body: "Prefer small, reviewable changes.",
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          },
        ],
      },
      {
        id: PROJECT_TWO,
        name: "Project Two",
        cwd: "/repo/project-two",
        model: "gpt-5.4",
        createdAt: NOW_ISO,
        expanded: true,
        scripts: [],
        skills: [],
        memories: [],
      },
    ],
    threads: [],
    planningWorkflows: [],
    codeReviewWorkflows: [],
  });
}

function createNativeApiMock(options?: { serverConfig?: Partial<ServerConfig> }) {
  const serverConfig: ServerConfig = {
    cwd: "/repo/project-one",
    keybindingsConfigPath: "/repo/project-one/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
    availableEditors: [],
    ...options?.serverConfig,
  };

  nativeApiRef.current = {
    server: {
      getConfig: vi.fn(async () => serverConfig),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
    },
    mcp: {
      getCommonConfig: vi.fn(async () => ({
        version: "common-v1",
        servers: {
          filesystem: {
            type: "stdio",
            command: "npx",
          },
        },
      })),
      getProjectConfig: vi.fn(async ({ projectId }: { projectId: ProjectId }) => ({
        projectId,
        version: `project-${projectId}`,
        servers: {
          [`project-${projectId}`]: {
            type: "stdio",
            command: "project-command",
          },
        },
      })),
      getEffectiveConfig: vi.fn(async ({ projectId }: { projectId: ProjectId }) => ({
        projectId,
        commonVersion: "common-v1",
        projectVersion: `project-${projectId}`,
        effectiveVersion: `effective-${projectId}`,
        servers: {
          filesystem: {
            type: "stdio",
            command: "npx",
          },
          [`project-${projectId}`]: {
            type: "stdio",
            command: "project-command",
          },
        },
      })),
      getProviderStatus: vi.fn(
        async ({
          provider,
          projectId,
        }: {
          provider: "codex" | "claudeAgent";
          projectId: ProjectId;
        }) => ({
          provider,
          projectId,
          support: "supported" as const,
          available: true,
          authStatus: "authenticated" as const,
          configVersion: `effective-${projectId}`,
        }),
      ),
      getServerStatuses: vi.fn(
        async ({
          provider,
          projectId,
        }: {
          provider: "codex" | "claudeAgent";
          projectId: ProjectId;
        }) => ({
          provider,
          projectId,
          support: "supported" as const,
          configVersion: `effective-${projectId}`,
          statuses: [
            {
              name: "filesystem",
              state: "ready" as const,
              authStatus: "authenticated" as const,
              toolCount: 1,
              resourceCount: 0,
              resourceTemplateCount: 0,
            },
            {
              name: `project-${projectId}`,
              state: "ready" as const,
              authStatus: "authenticated" as const,
              toolCount: 1,
              resourceCount: 0,
              resourceTemplateCount: 0,
            },
          ],
        }),
      ),
      getLoginStatus: vi.fn(
        async ({
          provider,
          projectId,
          serverName,
        }: {
          provider: "codex" | "claudeAgent";
          projectId: ProjectId;
          serverName?: string;
        }) => ({
          target: serverName ? ("server" as const) : ("provider" as const),
          mode: "cli" as const,
          provider,
          projectId,
          ...(serverName ? { serverName } : {}),
          status: "idle" as const,
        }),
      ),
      applyToLiveSessions: vi.fn(async () => ({
        scope: "project",
        projectId: PROJECT_ONE,
        codexReloaded: 0,
        claudeRestarted: 0,
        skipped: 0,
        configVersion: "effective",
      })),
      replaceCommonConfig: vi.fn(),
      replaceProjectConfig: vi.fn(),
      startLogin: vi.fn(),
      onStatusUpdated: vi.fn(() => () => {}),
    },
    orchestration: {
      getSnapshot: vi.fn(async () => ({
        snapshotSequence: 1,
        projects: [],
        planningWorkflows: [],
        codeReviewWorkflows: [],
        threads: [],
        updatedAt: NOW_ISO,
      })),
      dispatchCommand: vi.fn(async () => undefined),
      onDomainEvent: vi.fn(() => () => {}),
    },
    terminal: {
      onEvent: vi.fn(() => () => {}),
    },
  } as unknown as NativeApi;
}

async function renderSettingsRoute(
  initialEntry = "/settings",
  options?: { serverConfig?: Partial<ServerConfig> },
) {
  createNativeApiMock(options);
  seedProjects();
  seedAppSettings();

  const history = createMemoryHistory({
    initialEntries: [initialEntry],
  });
  const router = getRouter(history);
  const screen = await render(<RouterProvider router={router} />);

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Settings");
  });

  return { screen, router, history };
}

describe("settings route", () => {
  afterEach(() => {
    nativeApiRef.current = undefined;
    localStorage.clear();
    document.body.innerHTML = "";
    useStore.setState({
      projects: [],
      threads: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
    });
  });

  it("renders the category nav, updates the URL, and supports back/forward", async () => {
    const { screen, router, history } = await renderSettingsRoute("/settings?category=general");

    try {
      expect(page.getByRole("button", { name: "General" })).toBeTruthy();
      expect(page.getByRole("button", { name: "Display" })).toBeTruthy();
      expect(page.getByRole("button", { name: "Notifications" })).toBeTruthy();
      expect(page.getByRole("button", { name: "Providers & Models" })).toBeTruthy();
      expect(page.getByRole("button", { name: "Integrations" })).toBeTruthy();
      expect(page.getByRole("button", { name: "Projects" })).toBeTruthy();
      expect(page.getByRole("button", { name: "About" })).toBeTruthy();
      expect(router.state.location.search.category).toBe("general");
      expectCategoryVisible("general");
      expect(getCategoryPanelText("general")).toContain("Appearance");

      await page.getByRole("button", { name: "Display" }).click();

      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("display");
        expectCategoryVisible("display");
        expect(getCategoryPanelText("display")).toContain("Responses");
      });

      await page.getByRole("button", { name: "Providers & Models" }).click();

      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("providers");
        expectCategoryVisible("providers");
        expect(getCategoryPanelText("providers")).toContain("Codex App Server");
      });

      history.back();

      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("display");
        expectCategoryVisible("display");
        expect(getCategoryPanelText("display")).toContain("Responses");
      });

      history.forward();

      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("providers");
        expectCategoryVisible("providers");
        expect(getCategoryPanelText("providers")).toContain("Codex App Server");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("falls back to General when the category search param is invalid", async () => {
    const { screen, router } = await renderSettingsRoute("/settings?category=foo");

    try {
      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("general");
        expectCategoryVisible("general");
        expect(getCategoryPanelText("general")).toContain("Appearance");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("preserves provider drafts, display disclosure state, project memory drafts, and keybinding errors across category switches", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=providers");

    try {
      fillInput("#custom-model-slug-codex", "custom/provider-draft");
      await page.getByRole("button", { name: "Display" }).click();
      await page.getByRole("button", { name: "Show" }).click();
      await page.getByRole("button", { name: "Providers & Models" }).click();

      await vi.waitFor(() => {
        expect(document.querySelector<HTMLInputElement>("#custom-model-slug-codex")?.value).toBe(
          "custom/provider-draft",
        );
      });

      await page.getByRole("button", { name: "Display" }).click();

      await vi.waitFor(() => {
        expect(getCategoryPanelText("display")).toContain("Hide");
      });

      await page.getByRole("button", { name: "Projects" }).click();
      fillInput('input[placeholder="Avoid extra comments"]', "Drafted memory");
      await page.getByRole("button", { name: "Display" }).click();
      await page.getByRole("button", { name: "Projects" }).click();

      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLInputElement>('input[placeholder="Avoid extra comments"]')
            ?.value,
        ).toBe("Drafted memory");
      });

      await page.getByRole("button", { name: "Integrations" }).click();
      await page.getByRole("button", { name: "Open keybindings.json" }).click();

      await vi.waitFor(() => {
        expect(getCategoryPanelText("integrations")).toContain("No available editors found.");
      });

      await page.getByRole("button", { name: "Display" }).click();
      await page.getByRole("button", { name: "Integrations" }).click();

      await vi.waitFor(() => {
        expect(getCategoryPanelText("integrations")).toContain("No available editors found.");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("preserves MCP drafts across category switches and clears them when the shared project picker changes", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=integrations");

    try {
      fillInput('input[placeholder="filesystem"]', "draft-server");
      await page.getByRole("button", { name: "Show" }).click();

      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLInputElement>('input[placeholder="filesystem"]')?.value,
        ).toBe("draft-server");
        expect(getCategoryPanelText("integrations")).toContain("Hide");
      });

      await page.getByRole("button", { name: "Display" }).click();
      await page.getByRole("button", { name: "Integrations" }).click();

      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLInputElement>('input[placeholder="filesystem"]')?.value,
        ).toBe("draft-server");
        expect(getCategoryPanelText("integrations")).toContain("Hide");
      });

      await page.getByRole("button", { name: "Projects" }).click();
      await selectSettingsProject("Project Two");
      await page.getByRole("button", { name: "Integrations" }).click();

      await vi.waitFor(() => {
        expect(getCategoryPanelText("integrations")).toContain("Project Two");
        expect(
          document.querySelector<HTMLInputElement>('input[placeholder="filesystem"]')?.value,
        ).toBe("");
        expect(getCategoryPanelText("integrations")).toContain("Show");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps MCP bound to the shared project selection without rendering its own picker", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=projects");

    try {
      await page.getByRole("button", { name: "Edit" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Save changes");
      });

      await page.getByRole("button", { name: "Integrations" }).click();

      await vi.waitFor(() => {
        expect(getCategoryPanelText("integrations")).toContain("Selected project");
        expect(getCategoryPanelText("integrations")).toContain("Project One");
      });
      expect(document.querySelector('[aria-label="MCP servers project"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("shows overlapping keybinding warnings in integrations settings", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=integrations", {
      serverConfig: {
        keybindings: [
          {
            command: "chat.new",
            shortcut: MOD_N_SHORTCUT,
          },
          {
            command: "workflow.new",
            shortcut: MOD_N_SHORTCUT,
          },
        ],
      },
    });

    try {
      await vi.waitFor(() => {
        expect(getCategoryPanelText("integrations")).toContain("Conflicting shortcuts");
        expect(getCategoryPanelText("integrations")).toContain("New workflow");
        expect(getCategoryPanelText("integrations")).toContain("New thread");
      });
    } finally {
      await screen.unmount();
    }
  });
});
