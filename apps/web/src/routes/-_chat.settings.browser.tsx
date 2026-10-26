import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import "../index.css";

import type { NativeApi, ProjectId, ServerConfig } from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../appSettings";
import { migrateLegacyClientSetting } from "../hooks/useMigrateClientSettings";
import { getRouter } from "../router";
import { useStore } from "../store";
import { createTestServerProvider } from "../testServerProvider";

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

async function selectScopeProject(projectName: string) {
  await page.getByRole("combobox", { name: "Settings scope" }).click();
  await page.getByRole("combobox", { name: "Search projects" }).fill(projectName);
  await page.getByRole("option", { name: projectName, exact: true }).click();
  await vi.waitFor(() => {
    expect(
      document.querySelector<HTMLElement>('[aria-label="Settings scope"]')?.textContent,
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
    threadsHydrated: true,
    planningWorkflows: [],
    codeReviewWorkflows: [],
    investigationWorkflows: [],
  });
}

function createNativeApiMock(options?: { serverConfig?: Partial<ServerConfig> }) {
  let serverConfig: ServerConfig = {
    cwd: "/repo/project-one",
    keybindingsConfigPath: "/repo/project-one/.t3code-keybindings.json",
    keybindings: [],
    customKeybindings: [],
    issues: [],
    providers: [createTestServerProvider("codex", { checkedAt: NOW_ISO })],
    availableEditors: [],
    ...options?.serverConfig,
  };

  nativeApiRef.current = {
    server: {
      getConfig: vi.fn(async () => serverConfig),
      reportClientDiagnostics: vi.fn(async () => undefined),
      updateSettings: vi.fn(async (patch) => {
        serverConfig = {
          ...serverConfig,
          settings: applyServerSettingsPatch(
            serverConfig.settings ?? DEFAULT_SERVER_SETTINGS,
            patch,
          ),
        };
        return serverConfig.settings;
      }),
      getProjectSettings: vi.fn(async ({ projectId }) =>
        resolveProjectSettings({
          projectId,
          global: serverConfig.settings ?? DEFAULT_SERVER_SETTINGS,
        }),
      ),
      migrateClientSetting: vi.fn(async ({ value }) => ({ applied: true, currentValue: value })),
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
        investigationWorkflows: [],
        threads: [],
        updatedAt: NOW_ISO,
      })),
      dispatchCommand: vi.fn(async () => undefined),
      onDomainEvent: vi.fn(() => () => {}),
    },
    projects: {
      getCheckedInConfig: vi.fn(async ({ projectId }: { projectId: ProjectId }) => ({
        projectId,
        sourceFile: null,
        defaultThreadEnvMode: null,
        iconPath: null,
        diagnostics: [],
      })),
    },
    terminal: {
      onEvent: vi.fn(() => () => {}),
    },
    git: {
      onStatusInvalidated: vi.fn(() => () => {}),
    },
    agentBridge: {
      getState: vi.fn(async () => ({
        revision: 0,
        enabled: false,
        local: { status: "stopped", port: null, detail: null },
        stdio: { desktop: null, cli: { command: "f5", args: ["bridge"], env: {} } },
        clients: [],
      })),
      onStateChanged: vi.fn(() => () => {}),
    },
    // The chat layout subscribes to scheduled-task changes.
    scheduledTasks: {
      onChanged: vi.fn(() => () => {}),
    },
  } as unknown as NativeApi;
}

async function renderSettingsRoute(
  initialEntry = "/settings",
  options?: { serverConfig?: Partial<ServerConfig>; appSettings?: Record<string, unknown> },
) {
  createNativeApiMock(options);
  seedProjects();
  seedAppSettings(options?.appSettings);

  const history = createMemoryHistory({
    initialEntries: [initialEntry],
  });
  const router = getRouter(history);
  await router.load();
  const screen = await render(<RouterProvider router={router} />);

  await vi.waitFor(() => {
    expect(document.body.textContent).toMatch(/settings/i);
  });

  return { screen, router, history };
}

describe("settings route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    nativeApiRef.current = undefined;
    localStorage.clear();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
      planningWorkflows: [],
      codeReviewWorkflows: [],
      investigationWorkflows: [],
    });
  });

  it("invalidates cached workflow details when project settings refresh the startup snapshot", async () => {
    const { screen, router } = await renderSettingsRoute(
      `/settings?category=project&project=${PROJECT_ONE}`,
    );
    const client = router.options.context.queryClient;
    const key = ["workflow-platform", "details", "planning", "cached-run"];
    try {
      client.setQueryData(key, { detail: "old" });
      nativeApiRef.current!.orchestration.getStartupSnapshot = vi.fn(async () => ({
        snapshot: {
          snapshotSequence: 1,
          pinRevision: 0,
          projects: [],
          threads: [],
          planningWorkflows: [],
          codeReviewWorkflows: [],
          investigationWorkflows: [],
          updatedAt: NOW_ISO,
        },
        threadTailDetails: null,
      }));
      await page.getByRole("combobox", { name: "Project icon source" }).click();
      await page.getByRole("option", { name: "Emoji", exact: true }).click();
      await vi.waitFor(() => expect(client.getQueryState(key)?.isInvalidated).toBe(true));
      expect(nativeApiRef.current!.orchestration.getStartupSnapshot).toHaveBeenCalled();
    } finally {
      await screen.unmount();
      client.clear();
    }
  });

  it("lists runtime providers and resets model options when switching the project text-generation account", async () => {
    const { screen } = await renderSettingsRoute(`/settings?category=git&project=${PROJECT_ONE}`, {
      serverConfig: {
        providers: [createTestServerProvider("codex"), createTestServerProvider("claudeAgent")],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: {
            [PROJECT_ONE]: {
              textGenerationModelSelection: {
                instanceId: "codex" as never,
                model: "gpt-5.4",
                options: [{ id: "reasoningEffort", value: "high" }],
              },
            },
          },
        },
      },
    });
    try {
      await page
        .getByRole("combobox", { name: "Text generation provider" })
        .selectOptions("claudeAgent");
      await vi.waitFor(() =>
        expect(nativeApiRef.current!.server.updateSettings).toHaveBeenCalledWith({
          projectSettingsOverrides: {
            [PROJECT_ONE]: {
              textGenerationModelSelection: {
                instanceId: "claudeAgent",
                model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.claudeAgent,
              },
            },
          },
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("searches project scopes, keeps the selected scope in the URL, and shows only project pages", async () => {
    const { screen, router } = await renderSettingsRoute("/settings?category=git");
    try {
      await selectScopeProject("Project Two");
      await vi.waitFor(() => {
        expect(router.state.location.search).toMatchObject({
          category: "git",
          project: PROJECT_TWO,
        });
        expect(document.body.textContent).toContain("Overrides for Project Two.");
      });
      const nav = document.querySelector('nav[aria-label="Settings categories"]');
      const pages = Array.from(nav?.querySelectorAll("button") ?? []).map((button) =>
        button.textContent?.trim(),
      );
      expect(pages).toEqual(["Project", "Threads", "Tools", "Browser & Computer", "Git & GitHub"]);

      await page.getByRole("button", { name: "Global", exact: true }).click();
      await vi.waitFor(() => {
        expect(router.state.location.search.project).toBeUndefined();
        expect(router.state.location.search.category).toBe("git");
        expect(document.body.textContent).toContain("Settings for this profile.");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows a pending browser workspace default on the global and project pages", async () => {
    createNativeApiMock({ serverConfig: { settings: DEFAULT_SERVER_SETTINGS } });
    const migrate = vi.mocked(nativeApiRef.current!.server.migrateClientSetting);
    // Startup sync keeps rejecting the migration, so the browser value stays pending.
    migrate.mockRejectedValue(new Error("Sync pending"));
    seedProjects();
    seedAppSettings({ defaultThreadEnvMode: "worktree" });
    const router = getRouter(
      createMemoryHistory({ initialEntries: ["/settings?category=threads"] }),
    );
    const screen = await render(<RouterProvider router={router} />);
    try {
      await vi.waitFor(() => expect(getCategoryPanelText("threads")).toContain("New worktree"));
      await selectScopeProject("Project One");
      await expect
        .element(page.getByRole("combobox", { name: "Default workspace", exact: true }))
        .toHaveValue("worktree");
      expect(getCategoryPanelText("threads")).toContain("From global");
    } finally {
      migrate.mockResolvedValue({ applied: true, currentValue: "worktree" });
      await migrateLegacyClientSetting();
      await screen.unmount();
    }
  });

  it("persists and resets project overrides while hiding global-only controls", async () => {
    const { screen, router } = await renderSettingsRoute(
      `/settings?category=threads&project=${PROJECT_ONE}`,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Appearance", exact: true }))
        .not.toBeInTheDocument();
      await page
        .getByRole("combobox", { name: "Default permissions", exact: true })
        .selectOptions("approval-required");
      await expect
        .element(page.getByRole("combobox", { name: "Default permissions", exact: true }))
        .toHaveValue("approval-required");
      await vi.waitFor(() => expect(getCategoryPanelText("threads")).toContain("Project override"));
      expect(nativeApiRef.current!.server.updateSettings).toHaveBeenCalledWith({
        projectSettingsOverrides: { [PROJECT_ONE]: { defaultRuntimeMode: "approval-required" } },
      });

      await page.getByRole("button", { name: "Project", exact: true }).click();
      await page.getByRole("button", { name: "Reset all project overrides" }).click();
      await page.getByRole("button", { name: "Threads", exact: true }).click();
      await expect
        .element(page.getByRole("combobox", { name: "Default permissions", exact: true }))
        .toHaveValue("full-access");
      expect(router.state.location.search.project).toBe(PROJECT_ONE);

      await page.getByRole("button", { name: "Global", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Appearance", exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("shows which layer wins for the project default workspace", async () => {
    const { screen } = await renderSettingsRoute(
      `/settings?category=threads&project=${PROJECT_ONE}`,
      {
        serverConfig: {
          settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
        },
      },
    );
    try {
      const workspace = page.getByRole("combobox", { name: "Default workspace", exact: true });
      await expect.element(workspace).toHaveValue("worktree");
      await vi.waitFor(() => expect(getCategoryPanelText("threads")).toContain("From global"));

      await workspace.selectOptions("local");
      await vi.waitFor(() => {
        expect(nativeApiRef.current!.server.updateSettings).toHaveBeenCalledWith({
          projectSettingsOverrides: { [PROJECT_ONE]: { defaultThreadEnvMode: "local" } },
        });
        expect(getCategoryPanelText("threads")).toContain("Project override");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders the category nav, updates the URL, and supports back/forward", async () => {
    const { screen, router, history } = await renderSettingsRoute("/settings?category=general");

    try {
      for (const name of [
        "General",
        "Appearance",
        "Conversation",
        "Keyboard",
        "Notifications",
        "Providers",
        "Threads",
        "Tools",
        "Browser & Computer",
        "Projects",
        "Git & GitHub",
        "Profiles & Accounts",
        "Storage",
        "Archive",
        "About",
      ]) {
        await expect.element(page.getByRole("button", { name, exact: true })).toBeVisible();
      }
      expect(router.state.location.search.category).toBe("general");
      expectCategoryVisible("general");
      expect(getCategoryPanelText("general")).toContain("Sidebar & panels");

      await page.getByRole("button", { name: "Conversation", exact: true }).click();

      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("conversation");
        expectCategoryVisible("conversation");
        expect(getCategoryPanelText("conversation")).toContain("Activity detail");
      });

      await page.getByRole("button", { name: "Git & GitHub", exact: true }).click();

      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("git");
        expectCategoryVisible("git");
        expect(getCategoryPanelText("git")).toContain("Pull requests");
      });

      history.back();

      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("conversation");
        expectCategoryVisible("conversation");
      });

      history.forward();

      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("git");
        expectCategoryVisible("git");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("scrolls the category nav on short desktop windows", async () => {
    await page.viewport(1280, 480);
    const { screen } = await renderSettingsRoute("/settings?category=general");

    try {
      const about = page.getByRole("button", { name: "About", exact: true });
      await vi.waitFor(() => expect(about.element()).toBeTruthy());
      const list = about.element().closest<HTMLElement>(".lg\\:overflow-y-auto");
      expect(list).not.toBeNull();
      expect(list!.scrollHeight).toBeGreaterThan(list!.clientHeight);

      about.element().scrollIntoView({ block: "nearest" });
      await about.click();
      await vi.waitFor(() => expectCategoryVisible("about"));
    } finally {
      await screen.unmount();
      // vitest's default browser viewport.
      await page.viewport(414, 896);
    }
  });

  it("falls back to General when the category search param is invalid", async () => {
    const { screen, router } = await renderSettingsRoute("/settings?category=foo");

    try {
      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe("general");
        expectCategoryVisible("general");
        expect(getCategoryPanelText("general")).toContain("Sidebar & panels");
      });
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["/settings?category=display", "conversation", undefined],
    ["/settings?category=integrations", "tools", undefined],
    ["/settings?category=profiles", "accounts", undefined],
    ["/settings?item=integrations.keybindings", "keyboard", "keyboard.keybindings"],
    ["/settings?item=notifications.pr-refresh", "git", "git.pr-refresh"],
    ["/settings?item=general.pr-merge-method", "git", "git.merge-method"],
    ["/settings?category=tools&item=tools.agent-bridge", "tools", "tools.agent-bridge"],
    [
      "/settings?category=integrations&item=integrations.agent-bridge",
      "tools",
      "tools.agent-bridge",
    ],
  ])("redirects the legacy deep link %s", async (url, category, item) => {
    const { screen, router } = await renderSettingsRoute(url);
    try {
      await vi.waitFor(() => {
        expect(router.state.location.search.category).toBe(category);
        expect(router.state.location.search.item).toBe(item);
        expectCategoryVisible(category);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("redirects the legacy project icon deep link into the project scope", async () => {
    const { screen, router } = await renderSettingsRoute(
      `/settings?category=projects&item=projects.icon&projectId=${PROJECT_TWO}`,
    );
    try {
      await vi.waitFor(() => {
        expect(router.state.location.search).toMatchObject({
          category: "project",
          item: "project.icon",
          project: PROJECT_TWO,
        });
        expect(router.state.location.search).not.toHaveProperty("projectId");
        expectCategoryVisible("project");
        const target = document.querySelector<HTMLElement>(
          '[data-settings-search-target="project.icon"]',
        );
        expect(target?.dataset.settingsSearchHighlighted).toBe("true");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("opens an item deep link, focuses its control, and respects reduced motion", async () => {
    const originalMatchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      if (query !== "(prefers-reduced-motion: reduce)") return originalMatchMedia(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      };
    });
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const { screen, router } = await renderSettingsRoute(
      "/settings?category=general&item=projects.base-directory",
    );

    try {
      await vi.waitFor(() => {
        const target = document.querySelector<HTMLElement>("#add-project-base-directory");
        expect(router.state.location.search.category).toBe("projects");
        expect(router.state.location.search.item).toBe("projects.base-directory");
        expect(document.activeElement).toBe(target);
        expect(target?.dataset.settingsSearchHighlighted).toBe("true");
      });
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    } finally {
      await screen.unmount();
    }
  });

  it("searches unmounted categories and restores item deep links with back and forward", async () => {
    const { screen, router, history } = await renderSettingsRoute("/settings?category=general");

    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(
          document.querySelector<HTMLInputElement>('[aria-label="Search settings"]'),
        );
      });

      await page.getByRole("combobox", { name: "Search settings" }).fill("base directory");
      await page.getByRole("option", { name: /Add-project base directory/ }).click();

      await vi.waitFor(() => {
        expect(router.state.location.search).toMatchObject({
          category: "projects",
          item: "projects.base-directory",
        });
        expect(document.activeElement).toBe(
          document.querySelector<HTMLElement>("#add-project-base-directory"),
        );
      });

      await page.getByRole("combobox", { name: "Search settings" }).fill("theme preference");
      await page.getByRole("option", { name: /Theme preference/ }).click();

      await vi.waitFor(() => {
        expect(router.state.location.search).toMatchObject({
          category: "appearance",
          item: "appearance.theme",
        });
      });

      history.back();
      await vi.waitFor(() => {
        expect(router.state.location.search).toMatchObject({
          category: "projects",
          item: "projects.base-directory",
        });
      });

      history.forward();
      await vi.waitFor(() => {
        expect(router.state.location.search).toMatchObject({
          category: "appearance",
          item: "appearance.theme",
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("sends project-scope search results to the project version of an item", async () => {
    const { screen, router } = await renderSettingsRoute(
      `/settings?category=project&project=${PROJECT_ONE}`,
    );

    try {
      await page.getByRole("combobox", { name: "Search settings" }).fill("timestamp");
      await expect.element(page.getByText("No settings found.")).toBeVisible();

      await page.getByRole("combobox", { name: "Search settings" }).fill("merge method");
      await page.getByRole("option", { name: /Default PR merge method/ }).click();

      await vi.waitFor(() => {
        expect(router.state.location.search).toMatchObject({
          category: "git",
          item: "git.merge-method",
          project: PROJECT_ONE,
        });
        const target = getCategoryPanel("git").querySelector<HTMLElement>(
          '[aria-label="Default PR merge method"]',
        );
        expect(document.activeElement).toBe(target);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("applies validated font choices and sizes live", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=appearance");

    try {
      expectCategoryVisible("appearance");

      const interfaceFont = page.getByRole("combobox", { name: "Interface font family" });
      await interfaceFont.fill("Inter");
      interfaceFont
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      const interfaceSize = page.getByRole("slider", { name: "Interface font size" });
      await interfaceSize.fill("18");

      const chatFont = page.getByRole("combobox", { name: "Chat font family" });
      await chatFont.fill("Arial; color: red");
      chatFont.element().blur();

      await vi.waitFor(() => {
        expect(document.documentElement.style.fontSize).toBe("1.125em");
        expect(document.documentElement.style.getPropertyValue("--font-sans")).toContain('"Inter"');
        expect(
          parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)),
        ).toMatchObject({
          uiFontFamily: "Inter",
          uiFontSize: 18,
          chatFontFamily: "",
        });
        expect(chatFont.element().getAttribute("aria-invalid")).toBe("true");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("applies a color palette live and duplicates it into the local theme library", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=appearance");

    try {
      expectCategoryVisible("appearance");
      const originalPrimary = document.documentElement.style.getPropertyValue("--primary");

      await page.getByRole("button", { name: /Ocean Built in/ }).click();

      await vi.waitFor(() => {
        expect(
          parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).themeId,
        ).toBe("f5-ocean");
        expect(document.documentElement.dataset.themeId).toBe("f5-ocean");
        expect(document.documentElement.style.getPropertyValue("--primary")).not.toBe(
          originalPrimary,
        );
      });

      await page.getByRole("button", { name: "Duplicate Ocean" }).click();

      await vi.waitFor(() => {
        const persisted = parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
        expect(persisted.customThemes).toHaveLength(1);
        expect(persisted.themeId).toMatch(/^custom-ocean-/);
        expect(document.body.textContent).toContain("Ocean copy");
        expect(document.querySelector('[aria-label="Edit Ocean copy"]')).not.toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps an unavailable project scope explicit instead of falling back", async () => {
    const { screen, router } = await renderSettingsRoute(
      "/settings?category=project&project=deleted-project",
    );

    try {
      await vi.waitFor(() => {
        expect(router.state.location.search.project).toBe("deleted-project");
        expect(getCategoryPanelText("project")).toContain(
          "This project is unavailable or was deleted.",
        );
        expect(
          document.querySelector<HTMLElement>('[aria-label="Settings scope"]')?.textContent,
        ).toContain("Unavailable project");
      });

      // Override pages must not write overrides for a project that no longer exists.
      await page.getByRole("button", { name: "Threads", exact: true }).click();
      await vi.waitFor(() => {
        expectCategoryVisible("threads");
        expect(getCategoryPanelText("threads")).toContain("so its overrides can't be edited");
        expect(
          getCategoryPanel("threads").querySelector('[aria-label="Default permissions"]'),
        ).toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("moves a legacy Codex binary into a never-edited default instance", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=providers", {
      appSettings: { codexBinaryPath: "/opt/homebrew/bin/codex" },
    });
    const updateSettings = vi.mocked(nativeApiRef.current!.server.updateSettings);

    try {
      await vi.waitFor(() => {
        expect(getCategoryPanelText("providers")).toContain("binary /opt/homebrew/bin/codex");
      });
      await page.getByRole("button", { name: "Move to default instance" }).click();

      await vi.waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            providerInstances: expect.objectContaining({
              codex: expect.objectContaining({
                config: expect.objectContaining({ binaryPath: "/opt/homebrew/bin/codex" }),
              }),
            }),
          }),
        );
        expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!).codexBinaryPath).toBe(
          "",
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps legacy overrides when moving them to the instance fails", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=providers", {
      appSettings: { codexBinaryPath: "/opt/homebrew/bin/codex" },
    });
    const updateSettings = vi.mocked(nativeApiRef.current!.server.updateSettings);
    updateSettings.mockRejectedValueOnce(new Error("socket closed"));

    try {
      await vi.waitFor(() => {
        expect(getCategoryPanelText("providers")).toContain("binary /opt/homebrew/bin/codex");
      });
      await page.getByRole("button", { name: "Move to default instance" }).click();

      await vi.waitFor(() => {
        expect(updateSettings).toHaveBeenCalledTimes(1);
        expect(
          page.getByRole("button", { name: "Move to default instance" }).element(),
        ).not.toBeDisabled();
      });
      expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!).codexBinaryPath).toBe(
        "/opt/homebrew/bin/codex",
      );
      expect(getCategoryPanelText("providers")).toContain("binary /opt/homebrew/bin/codex");
    } finally {
      await screen.unmount();
    }
  });

  it("opens a project's settings from the Projects list", async () => {
    const { screen, router } = await renderSettingsRoute("/settings?category=projects");

    try {
      await page.getByRole("link", { name: "Configure Project Two" }).click();
      await vi.waitFor(() => {
        expect(router.state.location.search).toMatchObject({
          category: "project",
          project: PROJECT_TWO,
        });
        expect(
          document.querySelector<HTMLElement>('[aria-label="Settings scope"]')?.textContent,
        ).toContain("Project Two");
      });
      expect(document.querySelector('[aria-label="Settings project"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("preserves display disclosure state, project memory drafts, and keybinding errors across category switches", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=conversation");

    try {
      await page.getByRole("button", { name: "Show" }).click();
      await page.getByRole("button", { name: "General", exact: true }).click();
      await page.getByRole("button", { name: "Conversation", exact: true }).click();

      await vi.waitFor(() => {
        expect(getCategoryPanelText("conversation")).toContain("Hide");
      });

      await page.getByRole("button", { name: "Keyboard", exact: true }).click();
      await page.getByRole("button", { name: "Open keybindings.json" }).click();

      await vi.waitFor(() => {
        expect(getCategoryPanelText("keyboard")).toContain("No available editors found.");
      });

      await page.getByRole("button", { name: "General", exact: true }).click();
      await page.getByRole("button", { name: "Keyboard", exact: true }).click();

      await vi.waitFor(() => {
        expect(getCategoryPanelText("keyboard")).toContain("No available editors found.");
      });
    } finally {
      await screen.unmount();
    }

    const projectScope = await renderSettingsRoute(
      `/settings?category=project&project=${PROJECT_ONE}`,
    );
    try {
      await vi.waitFor(() =>
        expect(document.querySelector('input[placeholder="Avoid extra comments"]')).not.toBeNull(),
      );
      fillInput('input[placeholder="Avoid extra comments"]', "Drafted memory");
      await page.getByRole("button", { name: "Threads", exact: true }).click();
      await page.getByRole("button", { name: "Project", exact: true }).click();

      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLInputElement>('input[placeholder="Avoid extra comments"]')
            ?.value,
        ).toBe("Drafted memory");
      });
    } finally {
      await projectScope.screen.unmount();
    }
  });

  it("preserves MCP drafts across category switches and clears them when the project scope changes", async () => {
    const { screen } = await renderSettingsRoute(`/settings?category=tools&project=${PROJECT_ONE}`);

    try {
      fillInput('input[placeholder="filesystem"]', "draft-server");
      await page.getByRole("button", { name: "Show" }).click();

      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLInputElement>('input[placeholder="filesystem"]')?.value,
        ).toBe("draft-server");
        expect(getCategoryPanelText("tools")).toContain("Hide");
      });

      await page.getByRole("button", { name: "Threads", exact: true }).click();
      await page.getByRole("button", { name: "Tools", exact: true }).click();

      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLInputElement>('input[placeholder="filesystem"]')?.value,
        ).toBe("draft-server");
        expect(getCategoryPanelText("tools")).toContain("Hide");
      });

      await page.getByRole("combobox", { name: "Settings scope" }).click();
      await page.getByRole("option", { name: "Project Two", exact: false }).click();
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();

      await vi.waitFor(() => {
        expect(getCategoryPanelText("tools")).toContain("Project Two");
        expect(
          document.querySelector<HTMLInputElement>('input[placeholder="filesystem"]')?.value,
        ).toBe("");
      });
    } finally {
      await screen.unmount();
    }
  });

  it.each([null, PROJECT_ONE])(
    "preserves an MCP draft across category and search navigation in scope %s",
    async (project) => {
      const { screen, router } = await renderSettingsRoute(
        `/settings?category=tools${project ? `&project=${project}` : ""}`,
      );
      try {
        await page.getByRole("textbox", { name: "Name", exact: true }).fill("retained-tab-draft");
        await page.getByRole("button", { name: "Threads", exact: true }).click();
        await vi.waitFor(() => expect(router.state.location.search.category).toBe("threads"));
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
        await page.getByRole("button", { name: "Tools", exact: true }).click();
        await expect
          .element(page.getByRole("textbox", { name: "Name", exact: true }))
          .toHaveValue("retained-tab-draft");
        await page.getByRole("combobox", { name: "Search settings" }).fill("MCP servers");
        await page.getByRole("option", { name: /MCP servers/ }).click();
        await vi.waitFor(() => expect(router.state.location.search.item).toBe("tools.mcp"));
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
        await expect
          .element(page.getByRole("textbox", { name: "Name", exact: true }))
          .toHaveValue("retained-tab-draft");
        // A real scope change still asks once and clears the draft on confirmation.
        await page.getByRole("combobox", { name: "Settings scope" }).click();
        await page.getByRole("option", { name: "Project Two", exact: false }).click();
        await page.getByRole("button", { name: "Discard changes", exact: true }).click();
        await vi.waitFor(() => expect(router.state.location.search.project).toBe(PROJECT_TWO));
        await expect
          .element(page.getByRole("textbox", { name: "Name", exact: true }))
          .toHaveValue("");
        await page.getByRole("button", { name: "Threads", exact: true }).click();
        await vi.waitFor(() => expect(router.state.location.search.category).toBe("threads"));
        const unload = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(unload);
        expect(unload.defaultPrevented).toBe(false);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("guards a dirty MCP draft when switching projects through the settings router", async () => {
    const { screen, router } = await renderSettingsRoute(
      `/settings?category=tools&project=${PROJECT_ONE}`,
    );
    try {
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("unsaved-project-draft");
      await page.getByRole("combobox", { name: "Settings scope" }).click();
      await page.getByRole("option", { name: "Project Two", exact: false }).click();
      await expect
        .element(page.getByRole("alertdialog"))
        .toHaveTextContent("Discard unsaved MCP changes?");
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      expect(router.state.location.search.project).toBe(PROJECT_ONE);
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("unsaved-project-draft");
      await page.getByRole("combobox", { name: "Settings scope" }).click();
      await page.getByRole("option", { name: "Project Two", exact: false }).click();
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();
      await vi.waitFor(() => expect(router.state.location.search.project).toBe(PROJECT_TWO));
      await expect
        .element(page.getByRole("textbox", { name: "Name", exact: true }))
        .toHaveValue("");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps global MCP on the common scope and project MCP bound to the scope picker", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=tools", {
      serverConfig: {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          agentBridge: {
            ...DEFAULT_SERVER_SETTINGS.agentBridge,
            enabled: true,
            exposedProjectIds: [PROJECT_ONE],
          },
        },
      },
    });

    try {
      await vi.waitFor(() => {
        expect(getCategoryPanelText("tools")).toContain("Common servers");
      });
      expect(document.querySelector('[aria-label="MCP servers project"]')).toBeNull();
      // Agent Bridge is a global Tools setting (restored for scheduled tasks).
      expect(getCategoryPanelText("tools")).toContain("Agent Bridge");
      expect(
        document.querySelector('[data-settings-search-target="tools.agent-bridge"]'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }

    const projectScope = await renderSettingsRoute(
      `/settings?category=tools&project=${PROJECT_ONE}`,
    );
    try {
      await vi.waitFor(() => {
        expect(getCategoryPanelText("tools")).toContain("Project One");
        expect(getCategoryPanelText("tools")).toContain("Project servers");
      });
      expect(getCategoryPanelText("tools")).not.toContain("Agent Bridge");
    } finally {
      await projectScope.screen.unmount();
    }
  });

  it("shows overlapping keybinding warnings in keyboard settings", async () => {
    const { screen } = await renderSettingsRoute("/settings?category=keyboard", {
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
        expect(getCategoryPanelText("keyboard")).toContain("Conflicting shortcuts");
        expect(getCategoryPanelText("keyboard")).toContain("New workflow");
        expect(getCategoryPanelText("keyboard")).toContain("New thread");
      });
    } finally {
      await screen.unmount();
    }
  });
});
