import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NativeApi, ProjectId, ServerConfig, ServerProvider } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../../appSettings";
import { useStore } from "../../store";
import { createTestServerProvider } from "../../testServerProvider";
import { SettingsRouteContext } from "./SettingsRouteContext";
import { useSettingsRouteState } from "./useSettingsRouteState";
import { ProjectsSettings } from "./categories/ProjectsSettings";

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
      getConfig: vi.fn(async () => serverConfig),
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

function SettingsRouteStateHarness() {
  const routeState = useSettingsRouteState();

  return (
    <SettingsRouteContext.Provider value={routeState}>
      <ProjectsSettings />
    </SettingsRouteContext.Provider>
  );
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

  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <SettingsRouteStateHarness />
    </QueryClientProvider>,
  );

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Project memory");
  });

  return { screen, queryClient };
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

  it("dispatches local workspace and manual icon overrides", async () => {
    const { screen, queryClient } = await renderHarness();
    const dispatchCommand = vi.mocked(nativeApiRef.current!.orchestration.dispatchCommand);

    try {
      document.querySelector<HTMLElement>('[aria-label="Project default workspace mode"]')?.click();
      await page.getByRole("option", { name: "Worktree", exact: true }).click();

      await vi.waitFor(() => {
        expect(dispatchCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "project.meta.update",
            projectId: PROJECT_ONE,
            defaultEnvMode: "worktree",
          }),
        );
      });

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

  it("clears project memory edit state when the selected project changes via the shared picker", async () => {
    const { screen, queryClient } = await renderHarness();

    try {
      await page.getByRole("button", { name: "Edit" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Save changes");
      });

      await selectSettingsProject("Project Two");

      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain("Save changes");
        expect(
          document.querySelector<HTMLElement>('[aria-label="Settings project"]')?.textContent,
        ).toContain("Project Two");
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it.each([
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
