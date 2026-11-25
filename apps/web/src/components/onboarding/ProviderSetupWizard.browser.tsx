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
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../../appSettings";
import { useStore } from "../../store";
import { HomeEmptyStatePanel } from "./HomeEmptyStatePanel";
import { ProviderSetupWizard } from "./ProviderSetupWizard";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const NOW_ISO = "2026-04-24T12:00:00.000Z";

const nativeApiRef = vi.hoisted(() => ({
  current: undefined as NativeApi | undefined,
  getConfig: vi.fn<() => Promise<ServerConfig>>(),
  refreshProviders: vi.fn<() => Promise<{ providers: ReadonlyArray<ServerProvider> }>>(),
  updateSettings:
    vi.fn<(patch: Record<string, unknown>) => Promise<typeof DEFAULT_SERVER_SETTINGS>>(),
  loginStart: vi.fn(),
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

vi.mock("../../lib/startupReady", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/startupReady")>()),
  isStartupReady: () => true,
  useStartupReady: () => true,
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

async function renderOnboardingComponent(
  providers: ReadonlyArray<ServerProvider>,
  options?: {
    readonly component?: () => React.JSX.Element | null;
    readonly getConfigError?: Error;
    readonly updateSettingsError?: Error;
  },
) {
  nativeApiRef.getConfig.mockReset();
  nativeApiRef.refreshProviders.mockReset();
  nativeApiRef.updateSettings.mockReset();
  nativeApiRef.loginStart.mockReset();

  if (options?.getConfigError) {
    nativeApiRef.getConfig.mockRejectedValue(options.getConfigError);
  } else {
    nativeApiRef.getConfig.mockResolvedValue(makeServerConfig(providers));
  }
  nativeApiRef.refreshProviders.mockResolvedValue({ providers });
  if (options?.updateSettingsError) {
    nativeApiRef.updateSettings.mockRejectedValue(options.updateSettingsError);
  } else {
    nativeApiRef.updateSettings.mockImplementation(async (patch) => ({
      ...DEFAULT_SERVER_SETTINGS,
      ...patch,
    }));
  }
  nativeApiRef.loginStart.mockResolvedValue({ handle: "login-handle-1" });

  nativeApiRef.current = {
    server: {
      getConfig: nativeApiRef.getConfig,
      refreshProviders: nativeApiRef.refreshProviders,
      updateSettings: nativeApiRef.updateSettings,
    },
    profiles: {
      loginStart: nativeApiRef.loginStart,
      cancel: vi.fn().mockResolvedValue(undefined),
      input: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    projects: {
      detectImportableHistory: vi.fn().mockResolvedValue({ candidates: [] }),
    },
    harness: {
      validate: vi.fn().mockResolvedValue({ results: [] }),
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

  const PageComponent = options?.component ?? ProviderSetupWizard;
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: PageComponent,
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

  it("displays detected provider readiness, opens in-app sign-in, and refreshes providers", async () => {
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
        message: "Sign in to Codex.",
      }),
      makeProvider({
        instanceId: "grok",
        driver: "grok",
        displayName: "Grok Disabled",
        enabled: false,
        status: "disabled",
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
      initialProviders[2]!,
    ];

    const mounted = await renderOnboardingComponent(initialProviders);
    nativeApiRef.refreshProviders.mockResolvedValue({ providers: refreshedProviders });

    try {
      await expect
        .element(page.getByText("1 ready, 1 need sign-in, 0 unavailable, 1 disabled"))
        .toBeInTheDocument();
      await expect.element(page.getByText("Grok Disabled")).not.toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Sign in" })).toBeInTheDocument();

      await page.getByRole("button", { name: "Sign in" }).click();
      await expect
        .element(page.getByRole("heading", { name: "Sign in to Codex" }))
        .toBeInTheDocument();
      await vi.waitFor(() => {
        expect(nativeApiRef.loginStart).toHaveBeenCalledWith(
          expect.objectContaining({ instanceId: "codex" }),
        );
      });
      await userEvent.keyboard("{Escape}");

      await page.getByRole("button", { name: "Refresh providers" }).click();

      await expect
        .element(page.getByText("2 ready, 0 need sign-in, 0 unavailable, 1 disabled"))
        .toBeInTheDocument();
      expect(nativeApiRef.refreshProviders).toHaveBeenCalledTimes(1);
    } finally {
      mounted.queryClient.clear();
      await mounted.screen.unmount();
    }
  });

  it("keeps Permissions step incomplete when saving default permissions is rejected", async () => {
    const mounted = await renderOnboardingComponent(
      [
        makeProvider({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude Code",
          status: "ready",
        }),
      ],
      { updateSettingsError: new Error("Disk full") },
    );

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

      const permissionsStep = document.querySelector(
        'ol[aria-label="Setup steps"] li:nth-child(2)',
      );
      expect(permissionsStep?.getAttribute("aria-current")).toBe("step");
    } finally {
      mounted.queryClient.clear();
      await mounted.screen.unmount();
    }
  });

  it("shows checking, caveat, and unverified auth states accurately", async () => {
    const mounted = await renderOnboardingComponent([
      makeProvider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude Code",
        status: "warning",
        installed: false,
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      }),
      makeProvider({
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        status: "warning",
        installed: true,
        auth: { status: "authenticated" },
        message: "Update available.",
      }),
      makeProvider({
        instanceId: "cursor",
        driver: "cursor",
        displayName: "Cursor Agent",
        status: "ready",
        installed: true,
        auth: { status: "unknown" },
        message: "Account unverified.",
      }),
    ]);

    try {
      await expect
        .element(page.getByText("2 ready, 1 checking, 0 need sign-in, 0 unavailable"))
        .toBeInTheDocument();
      await expect.element(page.getByText("Checking…")).toBeInTheDocument();
      await expect.element(page.getByText("Ready with caveats")).toBeInTheDocument();
      await expect.element(page.getByText("Ready (auth unverified)")).toBeInTheDocument();
      await expect.element(page.getByText("Account unverified.")).toBeInTheDocument();
    } finally {
      mounted.queryClient.clear();
      await mounted.screen.unmount();
    }
  });

  it("blocks incompatible permission defaults on a Muse-only setup", async () => {
    const mounted = await renderOnboardingComponent([
      makeProvider({
        instanceId: "muse",
        driver: "muse",
        displayName: "Muse Code",
        status: "ready",
        auth: { status: "authenticated" },
      }),
    ]);

    try {
      await expect
        .element(page.getByText("1 ready, 0 need sign-in, 0 unavailable"))
        .toBeInTheDocument();

      const supervisedBtn = page.getByRole("button", { name: /Supervised/ });
      await expect.element(supervisedBtn).toBeDisabled();
      await expect
        .element(page.getByText(/Not supported by ready providers \(Muse Code\)/).first())
        .toBeInTheDocument();

      const editsBtn = page.getByRole("button", { name: /Auto-accept edits/ });
      await expect.element(editsBtn).toBeEnabled();
      await editsBtn.click();
      await vi.waitFor(() => {
        expect(nativeApiRef.updateSettings).toHaveBeenCalledWith({
          defaultRuntimeMode: "auto-accept-edits",
        });
      });
    } finally {
      mounted.queryClient.clear();
      await mounted.screen.unmount();
    }
  });

  it("renders a retryable error state when getConfig fails", async () => {
    const mounted = await renderOnboardingComponent([], {
      getConfigError: new Error("Server unreachable"),
    });

    try {
      await expect.element(page.getByRole("alert")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Retry" })).toBeInTheDocument();

      nativeApiRef.getConfig.mockResolvedValue(
        makeServerConfig([
          makeProvider({
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            displayName: "Claude Code",
            status: "ready",
          }),
        ]),
      );

      await page.getByRole("button", { name: "Retry" }).click();

      await expect
        .element(page.getByText("1 ready, 0 need sign-in, 0 unavailable"))
        .toBeInTheDocument();
    } finally {
      mounted.queryClient.clear();
      await mounted.screen.unmount();
    }
  });

  it("hides only the quick setup wizard inside HomeEmptyStatePanel without dismissing onboarding", async () => {
    const mounted = await renderOnboardingComponent(
      [
        makeProvider({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude Code",
          status: "ready",
        }),
      ],
      { component: HomeEmptyStatePanel },
    );

    try {
      await expect.element(page.getByTestId("provider-setup-wizard")).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /Add your first project/ }))
        .toBeInTheDocument();

      await page.getByRole("button", { name: "Hide quick setup" }).click();

      await expect.element(page.getByTestId("provider-setup-wizard")).not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /Add your first project/ }))
        .toBeInTheDocument();

      const persisted = parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
      expect(persisted.onboardingLiteStatus).not.toBe("dismissed");
    } finally {
      mounted.queryClient.clear();
      await mounted.screen.unmount();
    }
  });
});
