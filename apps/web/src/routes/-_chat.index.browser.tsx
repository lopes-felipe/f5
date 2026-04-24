import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { displayProfilePatchFor, parsePersistedAppSettings, useAppSettings } from "../appSettings";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { ChatIndexRouteView } from "./_chat.index";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useRecoveryStateStore } from "../recoveryStateStore";
import { useStore } from "../store";
import { SidebarProvider } from "../components/ui/sidebar";
import { SettingsRouteContext } from "../components/settings/SettingsRouteContext";
import { AboutSettings } from "../components/settings/categories/AboutSettings";
import type { SettingsRouteValue } from "../components/settings/useSettingsRouteState";
import type { Project, Thread } from "../types";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const NOW_ISO = "2026-04-22T12:00:00.000Z";

function makeProject(id = "project-1"): Project {
  return {
    id: ProjectId.makeUnsafe(id),
    name: `Project ${id}`,
    cwd: `/repo/${id}`,
    model: "gpt-5.4",
    createdAt: NOW_ISO,
    expanded: true,
    scripts: [],
    memories: [],
    skills: [],
  };
}

function makeThread(projectId: Project["id"], id = "thread-1"): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId,
    title: "Thread",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: NOW_ISO,
    archivedAt: null,
    lastInteractionAt: NOW_ISO,
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    compaction: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: false,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
  };
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

function readPersistedSettings() {
  return parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
}

function seedStores(input?: {
  projects?: ReadonlyArray<ReturnType<typeof makeProject>>;
  threads?: ReadonlyArray<ReturnType<typeof makeThread>>;
  threadsHydrated?: boolean;
  recoveryEpoch?: number;
}) {
  useStore.setState({
    projects: [...(input?.projects ?? [])],
    threads: [...(input?.threads ?? [])],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threadsHydrated: input?.threadsHydrated ?? true,
  });
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  useRecoveryStateStore.setState({
    recoveryEpoch: input?.recoveryEpoch ?? 1,
    lastCompletedAt: (input?.recoveryEpoch ?? 1) > 0 ? NOW_ISO : null,
  });
  useCommandPaletteStore.setState({
    open: false,
    openIntent: null,
  });
}

function TestSettingsRoute() {
  const { settings, defaults, updateSettings } = useAppSettings();
  const value = useMemo(
    () =>
      ({
        settings,
        defaults,
        updateSettings,
      }) as unknown as SettingsRouteValue,
    [defaults, settings, updateSettings],
  );

  return (
    <SettingsRouteContext.Provider value={value}>
      <div data-testid="settings-route" className="p-6">
        <AboutSettings />
      </div>
    </SettingsRouteContext.Provider>
  );
}

function createTestRouter(initialEntry = "/") {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider defaultOpen>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: ChatIndexRouteView,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: TestSettingsRoute,
  });

  return createRouter({
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
  });
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

async function renderIndexRoute(options?: {
  initialEntry?: string;
  settings?: Record<string, unknown>;
  projects?: ReadonlyArray<ReturnType<typeof makeProject>>;
  threads?: ReadonlyArray<ReturnType<typeof makeThread>>;
  threadsHydrated?: boolean;
  recoveryEpoch?: number;
}) {
  if (options?.settings) {
    seedAppSettings(options.settings);
  } else if (!localStorage.getItem(APP_SETTINGS_STORAGE_KEY)) {
    seedAppSettings();
  }
  seedStores({
    ...(options?.projects ? { projects: options.projects } : {}),
    ...(options?.threads ? { threads: options.threads } : {}),
    ...(options?.threadsHydrated !== undefined ? { threadsHydrated: options.threadsHydrated } : {}),
    ...(options?.recoveryEpoch !== undefined ? { recoveryEpoch: options.recoveryEpoch } : {}),
  });

  const router = createTestRouter(options?.initialEntry);
  const queryClient = makeQueryClient();
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return {
    queryClient,
    router,
    screen,
  };
}

describe("_chat.index onboarding lite", () => {
  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    seedStores({
      threadsHydrated: true,
      recoveryEpoch: 1,
    });
  });

  it("shows onboarding for a fresh empty startup and still shows it after reload", async () => {
    const firstRender = await renderIndexRoute();

    try {
      await expect.element(page.getByText("Planning workflows")).toBeInTheDocument();
    } finally {
      firstRender.queryClient.clear();
      await firstRender.screen.unmount();
    }

    const secondRender = await renderIndexRoute();
    try {
      await expect.element(page.getByText("Planning workflows")).toBeInTheDocument();
    } finally {
      secondRender.queryClient.clear();
      await secondRender.screen.unmount();
    }
  });

  it("persists dismissal across reloads", async () => {
    const firstRender = await renderIndexRoute();

    try {
      await page.getByText(/Don't show this again/).click();

      await vi.waitFor(() => {
        expect(readPersistedSettings().onboardingLiteStatus).toBe("dismissed");
        expect(document.body.textContent).toContain("Add a project to get started.");
      });
    } finally {
      firstRender.queryClient.clear();
      await firstRender.screen.unmount();
    }

    const secondRender = await renderIndexRoute();

    try {
      expect(document.body.textContent).toContain("Add a project to get started.");
      expect(document.body.textContent).not.toContain("Planning workflows");
    } finally {
      secondRender.queryClient.clear();
      await secondRender.screen.unmount();
    }
  });

  it("restores onboarding from About settings", async () => {
    const settingsRender = await renderIndexRoute({
      initialEntry: "/settings",
      settings: { onboardingLiteStatus: "dismissed" },
    });

    try {
      await page.getByRole("button", { name: "Show onboarding again" }).click();

      await vi.waitFor(() => {
        expect(readPersistedSettings().onboardingLiteStatus).toBe("reopened");
        expect(settingsRender.router.state.location.pathname).toBe("/");
      });

      await expect.element(page.getByText("Planning workflows")).toBeInTheDocument();
    } finally {
      settingsRender.queryClient.clear();
      await settingsRender.screen.unmount();
    }
  });

  it("restores onboarding for completed users even when they already have project data", async () => {
    const project = makeProject();
    const settingsRender = await renderIndexRoute({
      initialEntry: "/settings",
      settings: { onboardingLiteStatus: "completed" },
      projects: [project],
      threads: [makeThread(project.id)],
    });

    try {
      await page.getByRole("button", { name: "Show onboarding again" }).click();

      await vi.waitFor(() => {
        expect(readPersistedSettings().onboardingLiteStatus).toBe("reopened");
        expect(settingsRender.router.state.location.pathname).toBe("/");
      });

      await expect.element(page.getByText("Planning workflows")).toBeInTheDocument();
    } finally {
      settingsRender.queryClient.clear();
      await settingsRender.screen.unmount();
    }

    const restartRender = await renderIndexRoute({
      projects: [project],
      threads: [makeThread(project.id)],
    });

    try {
      expect(readPersistedSettings().onboardingLiteStatus).toBe("reopened");
      await expect.element(page.getByText("Planning workflows")).toBeInTheDocument();
    } finally {
      restartRender.queryClient.clear();
      await restartRender.screen.unmount();
    }
  });

  it("does not rewrite display settings when the selected preset already matches", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const screen = await renderIndexRoute();

    try {
      setItemSpy.mockClear();
      await page.getByRole("button", { name: /Balanced/ }).click();
      expect(setItemSpy).not.toHaveBeenCalled();
    } finally {
      setItemSpy.mockRestore();
      screen.queryClient.clear();
      await screen.screen.unmount();
    }
  });

  it("shows the custom warning and applies a preset when the current profile is custom", async () => {
    const screen = await renderIndexRoute({
      settings: {
        ...displayProfilePatchFor("detailed"),
        showProviderRuntimeMetadata: false,
      },
    });

    try {
      await expect
        .element(page.getByText(/Selecting a preset will overwrite your custom display settings\./))
        .toBeInTheDocument();

      await page.getByRole("button", { name: /Balanced/ }).click();

      await vi.waitFor(() => {
        expect(readPersistedSettings()).toMatchObject(displayProfilePatchFor("balanced"));
      });
    } finally {
      screen.queryClient.clear();
      await screen.screen.unmount();
    }
  });

  it("opens the add-project command intent from onboarding", async () => {
    const screen = await renderIndexRoute();

    try {
      await page.getByRole("button", { name: "Add your first project" }).click();

      expect(useCommandPaletteStore.getState().open).toBe(true);
      expect(useCommandPaletteStore.getState().openIntent?.kind).toBe("add-project");
    } finally {
      screen.queryClient.clear();
      await screen.screen.unmount();
    }
  });

  it("does not render a display settings CTA in onboarding", async () => {
    const screen = await renderIndexRoute();

    try {
      expect(document.body.textContent).not.toContain("Open display settings");
    } finally {
      screen.queryClient.clear();
      await screen.screen.unmount();
    }
  });

  it("never flashes onboarding for users with existing data before recovery completes", async () => {
    const project = makeProject();
    const screen = await renderIndexRoute({
      projects: [project],
      threads: [makeThread(project.id)],
      recoveryEpoch: 0,
    });

    try {
      expect(document.body.textContent).not.toContain("Planning workflows");
      expect(document.body.textContent).not.toContain("Add a project to get started.");

      useRecoveryStateStore.setState({
        recoveryEpoch: 1,
        lastCompletedAt: NOW_ISO,
      });

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(
          "Select a thread or create a new one to get started.",
        );
      });
      expect(document.body.textContent).not.toContain("Planning workflows");
    } finally {
      screen.queryClient.clear();
      await screen.screen.unmount();
    }
  });

  it("keeps completed users on the neutral empty-projects state after everything is deleted", async () => {
    const screen = await renderIndexRoute({
      settings: { onboardingLiteStatus: "completed" },
    });

    try {
      expect(document.body.textContent).toContain("Add a project to get started.");
      expect(document.body.textContent).not.toContain("Planning workflows");
    } finally {
      screen.queryClient.clear();
      await screen.screen.unmount();
    }
  });
});
