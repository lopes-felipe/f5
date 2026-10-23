import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import type { NativeApi, ProjectId, ServerConfig, ServerProvider } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../../appSettings";
import { useStore } from "../../store";
import { TestRouterContext } from "../../test/routerContext";
import { createTestServerProvider } from "../../testServerProvider";
import {
  ProjectScopeGate,
  ProjectScopeProvider,
  ProjectThreadsOverrides,
} from "./ProjectSettingsScope";
import { SettingsRouteContext } from "./SettingsRouteContext";
import { useSettingsRouteState } from "./useSettingsRouteState";
import { ProjectSettings } from "./categories/ProjectSettings";

const { nativeApiRef } = vi.hoisted(() => ({
  nativeApiRef: {
    current: undefined as NativeApi | undefined,
  },
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

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const NOW_ISO = "2026-04-22T12:00:00.000Z";
const PROJECT_ONE = "project-settings-1" as ProjectId;
const PROJECT_TWO = "project-settings-2" as ProjectId;

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
    investigationWorkflows: [],
  });
}

function createNativeApiMock(providers?: ReadonlyArray<ServerProvider>) {
  let saved = DEFAULT_SERVER_SETTINGS;
  const serverConfig: ServerConfig = {
    cwd: "/repo/project-one",
    keybindingsConfigPath: "/repo/project-one/.t3code-keybindings.json",
    keybindings: [],
    customKeybindings: [],
    issues: [],
    providers: providers ?? [createTestServerProvider("codex", { checkedAt: NOW_ISO })],
    availableEditors: [],
  };

  nativeApiRef.current = {
    server: {
      getConfig: vi.fn(async () => ({ ...serverConfig, settings: saved })),
      updateSettings: vi.fn(async (patch: Parameters<NativeApi["server"]["updateSettings"]>[0]) => {
        saved = applyServerSettingsPatch(saved, patch);
        return saved;
      }),
      getProjectSettings: vi.fn(async ({ projectId }: { projectId: ProjectId }) =>
        resolveProjectSettings({ projectId, global: saved }),
      ),
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
      getStartupSnapshot: vi.fn(async () => ({
        snapshot: {
          snapshotSequence: 1,
          projects: useStore.getState().projects.map((project) => ({
            id: project.id,
            title: project.name,
            workspaceRoot: project.cwd,
            defaultModel: project.model,
            defaultModelSelection: null,
            defaultEnvMode: project.defaultEnvMode ?? null,
            icon: project.icon ?? null,
            scripts: project.scripts,
            memories: project.memories,
            skills: project.skills ?? [],
            createdAt: project.createdAt,
            updatedAt: project.createdAt,
            deletedAt: null,
          })),
          planningWorkflows: [],
          codeReviewWorkflows: [],
          investigationWorkflows: [],
          threads: [],
          updatedAt: NOW_ISO,
        },
        threadTailDetails: null,
      })),
    },
    projects: {
      getCheckedInConfig: vi.fn(async ({ projectId }: { projectId: ProjectId }) => ({
        projectId,
        sourceFile: "f5.json" as const,
        defaultThreadEnvMode: "worktree" as const,
        iconPath: null,
        diagnostics: [
          {
            field: "scripts" as const,
            message: "Repository-defined scripts require explicit approval.",
          },
        ],
      })),
    },
  } as unknown as NativeApi;
}

// Mirrors the project scope of the settings route: the Project page plus the
// project Threads overrides, for the project picked in the header.
function SettingsRouteStateHarness({ projectId }: { readonly projectId: ProjectId }) {
  const routeState = useSettingsRouteState({ projectId });

  return (
    <SettingsRouteContext.Provider value={routeState}>
      <ProjectScopeProvider key={projectId} projectId={projectId}>
        <ProjectSettings />
        <ProjectScopeGate>
          <ProjectThreadsOverrides />
        </ProjectScopeGate>
      </ProjectScopeProvider>
    </SettingsRouteContext.Provider>
  );
}

async function renderHarness(options?: {
  settings?: Record<string, unknown>;
  providers?: ReadonlyArray<ServerProvider>;
}) {
  createNativeApiMock(options?.providers);
  seedProjects();
  seedAppSettings(options?.settings);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const harness = (projectId: ProjectId) => (
    <QueryClientProvider client={queryClient}>
      <TestRouterContext>
        <SettingsRouteStateHarness projectId={projectId} />
      </TestRouterContext>
    </QueryClientProvider>
  );
  const screen = await render(harness(PROJECT_ONE));

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Project memory");
  });

  return { screen, queryClient, selectProject: (id: ProjectId) => screen.rerender(harness(id)) };
}

describe("useSettingsRouteState", () => {
  afterEach(() => {
    nativeApiRef.current = undefined;
    localStorage.clear();
    document.body.innerHTML = "";
    useStore.setState({
      projects: [],
      threads: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      investigationWorkflows: [],
    });
  });

  it("saves a provider switch for one project and can restore global inheritance", async () => {
    const { screen, queryClient, selectProject } = await renderHarness();
    try {
      const toggle = () =>
        page.getByRole("switch", { name: "Enable Codex for this project", exact: true });
      await vi.waitFor(() =>
        expect(
          document.querySelector(
            '[data-settings-search-target="project.providers"] [data-slot="switch"]',
          ),
        ).not.toBeNull(),
      );
      await expect.element(toggle()).toBeChecked();
      await toggle().click();
      await expect.element(toggle()).not.toBeChecked();
      const update = vi.mocked(nativeApiRef.current!.server.updateSettings);
      expect(update.mock.calls[0]?.[0]).toMatchObject({
        projectSettingsOverrides: {
          [PROJECT_ONE]: { providerInstances: { codex: { enabled: false } } },
        },
      });
      expect(update.mock.calls[0]?.[0]).not.toHaveProperty("providerInstances");
      await selectProject(PROJECT_TWO);
      await expect.element(toggle()).toBeChecked();
      await selectProject(PROJECT_ONE);
      await expect.element(toggle()).not.toBeChecked();
      await page.getByRole("button", { name: "Use global providers", exact: true }).click();
      await expect.element(toggle()).toBeChecked();
      expect(update.mock.calls.at(-1)?.[0]).toMatchObject({
        projectSettingsOverrides: { [PROJECT_ONE]: { providerInstances: {} } },
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("shows checked-in non-executable defaults and their diagnostics", async () => {
    const { screen, queryClient } = await renderHarness();

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Loaded non-executable defaults from f5.json");
        expect(document.body.textContent).toContain("File workspace default: worktree");
        expect(document.body.textContent).toContain(
          "Repository-defined scripts require explicit approval.",
        );
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("keeps icon and memory usable when project settings fail to load", async () => {
    createNativeApiMock();
    vi.mocked(nativeApiRef.current!.server.getProjectSettings).mockRejectedValue(
      new Error("offline"),
    );
    seedProjects();
    seedAppSettings();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <TestRouterContext>
          <SettingsRouteStateHarness projectId={PROJECT_ONE} />
        </TestRouterContext>
      </QueryClientProvider>,
    );

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Could not load project settings.");
        expect(document.body.textContent).toContain("Build rule");
        expect(document.querySelector('[aria-label="Project icon source"]')).not.toBeNull();
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("inherits global Claude sub-agent defaults until the project overrides them", async () => {
    const { screen, queryClient } = await renderHarness({
      settings: { claudeSubagentDefaults: { subagentsEnabled: true } },
    });
    const subagentCard = () =>
      Array.from(document.querySelectorAll<HTMLElement>("section, [data-slot]")).find((node) =>
        node.textContent?.startsWith("Claude sub-agents"),
      );
    const toggle = () =>
      document.querySelector<HTMLElement>('[aria-label="Enable Claude sub-agents"]');

    try {
      await vi.waitFor(() => {
        expect(toggle()?.getAttribute("aria-checked")).toBe("true");
        expect(subagentCard()?.textContent).toContain("From global");
      });

      toggle()!.click();
      await vi.waitFor(() => {
        expect(toggle()?.getAttribute("aria-checked")).toBe("false");
        expect(subagentCard()?.textContent).toContain("Project override");
        expect(
          JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!).claudeProjectSettings[
            PROJECT_ONE
          ],
        ).toMatchObject({ subagentsEnabled: false });
      });

      await page.getByRole("button", { name: "Reset all project overrides" }).click();
      await vi.waitFor(() => {
        expect(toggle()?.getAttribute("aria-checked")).toBe("true");
        expect(subagentCard()?.textContent).toContain("From global");
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("dispatches manual icon overrides", async () => {
    const { screen, queryClient } = await renderHarness();
    const dispatchCommand = vi.mocked(nativeApiRef.current!.orchestration.dispatchCommand);

    try {
      document.querySelector<HTMLElement>('[aria-label="Project icon source"]')?.click();
      await page.getByRole("option", { name: "Emoji", exact: true }).click();

      await vi.waitFor(() => {
        expect(dispatchCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "project.meta.update",
            projectId: PROJECT_ONE,
            icon: { type: "emoji", emoji: "📁" },
          }),
        );
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("clears project memory edit state when the scoped project changes", async () => {
    const { screen, queryClient, selectProject } = await renderHarness();

    try {
      await page.getByRole("button", { name: "Edit" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Save changes");
      });

      await selectProject(PROJECT_TWO);

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Project memory");
        expect(document.body.textContent).not.toContain("Save changes");
        expect(document.body.textContent).not.toContain("Build rule");
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it.each([
    {
      name: "Claude Opus 5.5",
      alias: "opus",
      slug: "claude-opus-5-5",
      before: "2.1.279",
      after: "2.1.280",
    },
    {
      name: "Claude Opus 5",
      alias: "opus-5[1m]",
      slug: "claude-opus-5",
      before: "2.1.219",
      after: "2.1.220",
    },
    {
      name: "Claude Fable 5.1",
      alias: "fable[1m]",
      slug: "claude-fable-5-1",
      before: "2.1.256",
      after: "2.1.257",
    },
  ])(
    "uses inherit for gated $name subagents and reactivates hidden selections after upgrade",
    async ({ name, alias, slug, before, after }) => {
      const settings = {
        claudeProjectSettings: {
          [PROJECT_ONE]: {
            subagentsEnabled: true,
            subagentModel: alias,
          },
        },
        providerModelPreferences: {
          claudeAgent: {
            hiddenModels: [slug],
            modelOrder: [],
          },
        },
      };
      const preUpgrade = await renderHarness({
        settings,
        providers: [
          createTestServerProvider("claudeAgent", {
            version: before,
            models: [
              {
                slug: "claude-fable-5",
                name: "Claude Fable 5",
                isCustom: false,
                capabilities: null,
              },
            ],
          }),
        ],
      });

      try {
        await vi.waitFor(() => {
          expect(
            document.querySelector<HTMLElement>('[aria-label="Claude sub-agent model"]')
              ?.textContent,
          ).toContain("Inherit from parent");
        });
        expect(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toContain(alias);
      } finally {
        preUpgrade.queryClient.clear();
        await preUpgrade.screen.unmount();
        document.body.innerHTML = "";
      }

      const postUpgrade = await renderHarness({
        settings,
        providers: [
          createTestServerProvider("claudeAgent", {
            version: after,
            models: [
              {
                slug: slug,
                name: name,
                isCustom: false,
                capabilities: null,
              },
            ],
          }),
        ],
      });

      try {
        await vi.waitFor(() => {
          expect(
            document.querySelector<HTMLElement>('[aria-label="Claude sub-agent model"]')
              ?.textContent,
          ).toContain(name);
        });
      } finally {
        postUpgrade.queryClient.clear();
        await postUpgrade.screen.unmount();
      }
    },
  );
});
