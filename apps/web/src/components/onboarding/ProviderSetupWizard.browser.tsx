import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type NativeApi,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../../appSettings";
import { useStore } from "../../store";
import { ProviderSetupWizard } from "./ProviderSetupWizard";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const NOW_ISO = "2026-04-24T12:00:00.000Z";

const nativeApiRef = vi.hoisted(() => ({
  current: undefined as NativeApi | undefined,
  getConfig: vi.fn<() => Promise<ServerConfig>>(),
  refreshProviders: vi.fn<() => Promise<{ providers: ReadonlyArray<ServerProvider> }>>(),
  updateSettings:
    vi.fn<(patch: Record<string, unknown>) => Promise<typeof DEFAULT_SERVER_SETTINGS>>(),
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

function makeProvider(
  overrides: Partial<Omit<ServerProvider, "instanceId" | "driver">> & {
    instanceId: string;
    driver: string;
  },
): ServerProvider {
  const { instanceId, driver, ...rest } = overrides;
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW_ISO,
    models: [],
    slashCommands: [],
    skills: [],
    ...rest,
  } as ServerProvider;
}

function makeServerConfig(providers: ReadonlyArray<ServerProvider>): ServerConfig {
  return {
    cwd: "/repo",
    keybindingsConfigPath: "/repo/keybindings.json",
    keybindings: [],
    issues: [],
    providers,
    availableEditors: [],
    settings: { ...DEFAULT_SERVER_SETTINGS },
    providerInstances: [],
    drivers: [],
  } as unknown as ServerConfig;
}

async function renderWizard(providers: ReadonlyArray<ServerProvider>) {
  nativeApiRef.getConfig.mockReset();
  nativeApiRef.refreshProviders.mockReset();
  nativeApiRef.updateSettings.mockReset();

  nativeApiRef.getConfig.mockResolvedValue(makeServerConfig(providers));
  nativeApiRef.refreshProviders.mockResolvedValue({ providers });
  nativeApiRef.updateSettings.mockImplementation(async (patch) => ({
    ...DEFAULT_SERVER_SETTINGS,
    ...patch,
  }));

  nativeApiRef.current = {
    server: {
      getConfig: nativeApiRef.getConfig,
      refreshProviders: nativeApiRef.refreshProviders,
      updateSettings: nativeApiRef.updateSettings,
    },
  } as unknown as NativeApi;

  useStore.setState({
    projects: [],
    threads: [],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    investigationWorkflows: [],
    threadsHydrated: true,
  });

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: ProviderSetupWizard,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div data-testid="settings-page">Settings</div>,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
  });

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { queryClient, router, screen };
}

describe("ProviderSetupWizard", () => {
  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("displays detected provider readiness and lets users refresh providers", async () => {
    const initialProviders = [
      makeProvider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude Code",
        status: "ready",
        auth: { status: "authenticated" },
        version: "2.1.0",
      }),
      makeProvider({
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        status: "warning",
        installed: true,
        auth: { status: "unauthenticated" },
        message: "Run codex login to authenticate.",
      }),
    ];
    const refreshedProviders = [
      initialProviders[0]!,
      makeProvider({
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        status: "ready",
        installed: true,
        auth: { status: "authenticated" },
        version: "0.42.0",
      }),
    ];

    const mounted = await renderWizard(initialProviders);
    nativeApiRef.refreshProviders.mockResolvedValue({ providers: refreshedProviders });

    try {
      await expect
        .element(page.getByText("1 ready, 1 need sign-in, 0 unavailable"))
        .toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "codex login" })).toBeInTheDocument();

      await page.getByRole("button", { name: "Refresh providers" }).click();

      await expect
        .element(page.getByText("2 ready, 0 need sign-in, 0 unavailable"))
        .toBeInTheDocument();
      expect(nativeApiRef.refreshProviders).toHaveBeenCalledTimes(1);
    } finally {
      mounted.queryClient.clear();
      await mounted.screen.unmount();
    }
  });

  it("persists the selected default permission mode and supports skipping setup", async () => {
    const mounted = await renderWizard([
      makeProvider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude Code",
        status: "ready",
      }),
    ]);

    try {
      await expect
        .element(page.getByText("1 ready, 0 need sign-in, 0 unavailable"))
        .toBeInTheDocument();

      await page.getByRole("button", { name: /Supervised/ }).click();

      await vi.waitFor(() => {
        expect(nativeApiRef.updateSettings).toHaveBeenCalledWith({
          defaultRuntimeMode: "approval-required",
        });
      });

      await page.getByRole("button", { name: "Skip setup" }).click();

      const persisted = parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
      expect(persisted.onboardingLiteStatus).toBe("dismissed");
    } finally {
      mounted.queryClient.clear();
      await mounted.screen.unmount();
    }
  });
});
