import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NativeApi, ProjectId, ServerConfig } from "@t3tools/contracts";
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
  });
}

function createNativeApiMock() {
  const serverConfig: ServerConfig = {
    cwd: "/repo/project-one",
    keybindingsConfigPath: "/repo/project-one/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [createTestServerProvider("codex", { checkedAt: NOW_ISO })],
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
        threads: [],
        updatedAt: NOW_ISO,
      })),
      dispatchCommand: vi.fn(async () => undefined),
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

async function renderHarness() {
  createNativeApiMock();
  seedProjects();
  seedAppSettings();

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
    });
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
});
