import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type {
  NativeApi,
  ProjectId,
  ServerHarnessValidationResult,
  ThreadId,
} from "@t3tools/contracts";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../../appSettings";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useRecoveryStateStore } from "../../recoveryStateStore";
import { useStore } from "../../store";
import type { Project, Thread } from "../../types";
import { SidebarProvider } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { HarnessValidationPanel } from "./HarnessValidationPanel";
import { HARNESSES } from "./harnessMeta";
import { HomeEmptyStatePanel } from "./HomeEmptyStatePanel";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const NOW_ISO = "2026-04-23T12:00:00.000Z";

const nativeApiRef = vi.hoisted(() => ({
  current: undefined as NativeApi | undefined,
  validateHarnesses:
    vi.fn<
      (input?: {
        providerOptions?: unknown;
      }) => Promise<{ results: ReadonlyArray<ServerHarnessValidationResult> }>
    >(),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
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

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createTestRouter(node: ReactElement) {
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
    component: () => node,
  });

  return createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([indexRoute]),
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

function seedStores(input?: {
  readonly projects?: ReadonlyArray<Project>;
  readonly threads?: ReadonlyArray<Thread>;
  readonly recoveryEpoch?: number;
}) {
  useStore.setState({
    projects: [...(input?.projects ?? [])],
    threads: [...(input?.threads ?? [])],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threadsHydrated: true,
  });
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  useRecoveryStateStore.setState({
    recoveryEpoch: input?.recoveryEpoch ?? 1,
    lastCompletedAt: NOW_ISO,
  });
  useCommandPaletteStore.setState({
    open: false,
    openIntent: null,
  });
}

function createNativeApiMock() {
  nativeApiRef.validateHarnesses.mockReset();
  nativeApiRef.openExternal.mockReset();
  nativeApiRef.openExternal.mockResolvedValue(undefined);
  nativeApiRef.current = {
    server: {
      getConfig: vi.fn(),
      validateHarnesses: nativeApiRef.validateHarnesses,
      upsertKeybinding: vi.fn(),
    },
    shell: {
      openExternal: nativeApiRef.openExternal,
    },
  } as unknown as NativeApi;
}

function makeProject(id = "project-1" as ProjectId): Project {
  return {
    id,
    name: "Project",
    cwd: "/repo/project",
    model: "gpt-5.4",
    createdAt: NOW_ISO,
    expanded: true,
    scripts: [],
    memories: [],
    skills: [],
  };
}

function makeThread(projectId: ProjectId, id = "thread-1" as ThreadId): Thread {
  return {
    id,
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

function makeResult(
  provider: ServerHarnessValidationResult["provider"],
  overrides: Partial<ServerHarnessValidationResult> = {},
): ServerHarnessValidationResult {
  return {
    provider,
    status: "ready",
    installed: true,
    authStatus: "authenticated",
    checkedAt: NOW_ISO,
    ...overrides,
  };
}

async function renderWithQueryClient(node: ReactElement) {
  const queryClient = makeQueryClient();
  const router = createTestRouter(node);
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

describe("HarnessValidationPanel", () => {
  afterEach(() => {
    nativeApiRef.current = undefined;
    nativeApiRef.validateHarnesses.mockReset();
    nativeApiRef.openExternal.mockReset();
    localStorage.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    seedStores();
  });

  it("renders idle rows before any validation request is made", async () => {
    createNativeApiMock();
    seedAppSettings();
    const { screen, queryClient } = await renderWithQueryClient(<HarnessValidationPanel />);

    try {
      expect(document.body.textContent).toContain("Check your model harnesses");
      expect((document.body.textContent ?? "").match(/Not checked yet\./g)?.length).toBe(2);
      expect(document.querySelector('[aria-label="Ready"]')).toBeNull();
      expect(document.querySelector('[aria-label="Error"]')).toBeNull();
      expect(nativeApiRef.validateHarnesses).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("starts validation only after the CTA is clicked", async () => {
    createNativeApiMock();
    seedAppSettings();

    let resolveValidation:
      | ((value: { results: ReadonlyArray<ServerHarnessValidationResult> }) => void)
      | undefined;
    nativeApiRef.validateHarnesses.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveValidation = resolve;
        }),
    );

    const { screen, queryClient } = await renderWithQueryClient(<HarnessValidationPanel />);

    try {
      await page.getByRole("button", { name: "Check my setup" }).click();

      await vi.waitFor(() => {
        expect(nativeApiRef.validateHarnesses).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain("Checking…");
        expect(document.querySelector('ul[aria-busy="true"]')).not.toBeNull();
      });

      resolveValidation?.({
        results: [makeResult("claudeAgent"), makeResult("codex")],
      });

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Re-check");
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it.each([
    { failureKind: "notInstalled", expectedButton: "Install guide" },
    { failureKind: "unsupportedVersion", expectedButton: "Upgrade docs" },
    { failureKind: "unauthenticated", expectedButton: "Open docs" },
    { failureKind: "versionProbeFailed", expectedButton: "Open docs" },
    { failureKind: "versionProbeTimeout", expectedButton: "Open docs" },
    { failureKind: "preflight", expectedButton: "Open docs" },
    { failureKind: "connectivity", expectedButton: null },
  ] as const)(
    "renders the correct row treatment for %s failures",
    async ({ expectedButton, failureKind }) => {
      createNativeApiMock();
      seedAppSettings();
      nativeApiRef.validateHarnesses.mockResolvedValue({
        results: [
          makeResult("claudeAgent"),
          makeResult("codex", {
            status: "error",
            authStatus: failureKind === "unauthenticated" ? "unauthenticated" : "unknown",
            failureKind,
            message: `Failure: ${failureKind}`,
          }),
        ],
      });

      const { screen, queryClient } = await renderWithQueryClient(<HarnessValidationPanel />);

      try {
        await page.getByRole("button", { name: "Check my setup" }).click();

        await vi.waitFor(() => {
          expect(document.body.textContent).toContain(`Failure: ${failureKind}`);
        });

        if (expectedButton) {
          await expect
            .element(page.getByRole("button", { name: expectedButton }))
            .toBeInTheDocument();
        } else {
          expect(document.body.textContent).not.toContain("Install guide");
          expect(document.body.textContent).not.toContain("Upgrade docs");
          expect(document.body.textContent).not.toContain("Open docs");
        }
      } finally {
        queryClient.clear();
        await screen.unmount();
      }
    },
  );

  it("renders ready-row messages verbatim", async () => {
    createNativeApiMock();
    seedAppSettings();
    nativeApiRef.validateHarnesses.mockResolvedValue({
      results: [
        makeResult("claudeAgent"),
        makeResult("codex", {
          message: "Using a custom Codex model provider; OpenAI login check skipped.",
          authStatus: "unknown",
        }),
      ],
    });

    const { screen, queryClient } = await renderWithQueryClient(<HarnessValidationPanel />);

    try {
      await page.getByRole("button", { name: "Check my setup" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(
          "Using a custom Codex model provider; OpenAI login check skipped.",
        );
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("opens the install guide for missing harnesses", async () => {
    createNativeApiMock();
    seedAppSettings();
    const codexMeta = HARNESSES.find((meta) => meta.provider === "codex");
    nativeApiRef.validateHarnesses.mockResolvedValue({
      results: [
        makeResult("claudeAgent"),
        makeResult("codex", {
          status: "error",
          installed: false,
          authStatus: "unknown",
          failureKind: "notInstalled",
          message: "Codex CLI (`codex`) is not installed or not on PATH.",
        }),
      ],
    });

    const { screen, queryClient } = await renderWithQueryClient(<HarnessValidationPanel />);

    try {
      await page.getByRole("button", { name: "Check my setup" }).click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Not installed.");
      });

      await page.getByRole("button", { name: "Install guide" }).click();

      expect(nativeApiRef.openExternal).toHaveBeenCalledWith(codexMeta?.installUrl);
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("shows a toast and copies the URL when opening docs fails", async () => {
    createNativeApiMock();
    seedAppSettings();
    const toastSpy = vi.spyOn(toastManager, "add");
    const clipboardSpy = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: clipboardSpy,
      },
    });

    const claudeMeta = HARNESSES.find((meta) => meta.provider === "claudeAgent");
    nativeApiRef.openExternal.mockRejectedValue(new Error("boom"));
    nativeApiRef.validateHarnesses.mockResolvedValue({
      results: [
        makeResult("claudeAgent", {
          status: "error",
          installed: false,
          authStatus: "unknown",
          failureKind: "notInstalled",
          message: "Claude Agent CLI (`claude`) is not installed or not on PATH.",
        }),
        makeResult("codex"),
      ],
    });

    const { screen, queryClient } = await renderWithQueryClient(<HarnessValidationPanel />);

    try {
      await page.getByRole("button", { name: "Check my setup" }).click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Claude Agent CLI (`claude`) is not installed");
      });

      await page.getByRole("button", { name: "Install guide" }).click();

      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith({
          type: "error",
          title: "Couldn't open the link",
          description: claudeMeta?.installUrl,
        });
        expect(clipboardSpy).toHaveBeenCalledWith(claudeMeta?.installUrl);
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("shows a retryable card-level error when validation rejects", async () => {
    createNativeApiMock();
    seedAppSettings();
    nativeApiRef.validateHarnesses
      .mockResolvedValueOnce({
        results: [makeResult("claudeAgent"), makeResult("codex", { message: "Ready" })],
      })
      .mockRejectedValueOnce(new Error("Server unavailable"))
      .mockResolvedValueOnce({
        results: [makeResult("claudeAgent"), makeResult("codex")],
      });

    const { screen, queryClient } = await renderWithQueryClient(<HarnessValidationPanel />);

    try {
      await page.getByRole("button", { name: "Check my setup" }).click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Ready");
      });

      await page.getByRole("button", { name: "Re-check" }).click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Harness validation failed");
        expect(document.body.textContent).toContain("Server unavailable");
      });

      await page.getByRole("button", { name: "Try again" }).click();
      await vi.waitFor(() => {
        expect(nativeApiRef.validateHarnesses).toHaveBeenCalledTimes(3);
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("keeps rows idle when the native API is unavailable", async () => {
    seedAppSettings();
    const { screen, queryClient } = await renderWithQueryClient(<HarnessValidationPanel />);

    try {
      await page.getByRole("button", { name: "Check my setup" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Native API not found");
      });
      expect((document.body.textContent ?? "").match(/Not checked yet\./g)?.length).toBe(2);
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("renders only in the welcome onboarding branch", async () => {
    createNativeApiMock();
    seedAppSettings();
    seedStores();
    const onboardingRender = await renderWithQueryClient(<HomeEmptyStatePanel />);

    try {
      expect(document.body.textContent).toContain("Check your model harnesses");
    } finally {
      onboardingRender.queryClient.clear();
      await onboardingRender.screen.unmount();
    }

    seedAppSettings({ onboardingLiteStatus: "dismissed" });
    seedStores();
    const emptyProjectsRender = await renderWithQueryClient(<HomeEmptyStatePanel />);

    try {
      expect(document.body.textContent).toContain("Add a project to get started.");
      expect(document.body.textContent).not.toContain("Check your model harnesses");
    } finally {
      emptyProjectsRender.queryClient.clear();
      await emptyProjectsRender.screen.unmount();
    }

    seedAppSettings();
    const project = makeProject();
    seedStores({ projects: [project], threads: [makeThread(project.id)] });
    const emptyThreadsRender = await renderWithQueryClient(<HomeEmptyStatePanel />);

    try {
      expect(document.body.textContent).not.toContain("Check your model harnesses");
    } finally {
      emptyThreadsRender.queryClient.clear();
      await emptyThreadsRender.screen.unmount();
    }
  });
});
