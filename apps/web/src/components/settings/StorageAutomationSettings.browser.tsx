import "../../index.css";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { StorageAutomationSettings } from "./StorageAutomationSettings";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  updateSettings: vi.fn(),
  settings: null as typeof DEFAULT_SERVER_SETTINGS | null,
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (value: typeof DEFAULT_SERVER_SETTINGS) => unknown) =>
    selector(mocks.settings ?? DEFAULT_SERVER_SETTINGS),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    storage: { automationAudit: mocks.audit },
    server: { updateSettings: mocks.updateSettings },
  }),
}));
vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  Link: () => null,
}));
afterEach(() => {
  vi.restoreAllMocks();
  mocks.updateSettings.mockReset();
  mocks.settings = null;
});

it("turns hourly inactive worktree cleanup on only under automatic storage cleanup", async () => {
  mocks.audit.mockResolvedValue({ entries: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderSettings = () =>
    render(
      <QueryClientProvider client={client}>
        <StorageAutomationSettings />
      </QueryClientProvider>,
    );
  const toggle = page.getByRole("switch", { name: "Remove inactive F5 worktrees hourly" });

  let view = await renderSettings();
  try {
    await expect.element(toggle).toBeDisabled();
  } finally {
    await view.unmount();
  }

  mocks.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, enabled: true },
  };
  mocks.updateSettings.mockResolvedValue(mocks.settings);
  view = await renderSettings();
  try {
    await expect.element(toggle).not.toBeChecked();
    await toggle.click();
    await vi.waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        storageCleanup: { inactiveWorktrees: true },
      }),
    );
  } finally {
    await view.unmount();
    client.clear();
  }
});

it("shows persisted daily backup success and actionable failure status", async () => {
  mocks.audit.mockResolvedValue({
    entries: [],
    scheduledBackupStatus: {
      lastAttemptAt: "2026-10-16T12:00:00.000Z",
      lastSuccessAt: "2026-10-15T12:00:00.000Z",
      lastError: "Owned attachment 'missing' is missing: /storage/missing.txt",
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <StorageAutomationSettings />
    </QueryClientProvider>,
  );
  try {
    await expect.element(page.getByText(/Last successful daily backup:/)).toBeVisible();
    await expect.element(page.getByText(/Last attempt:/)).toBeVisible();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Owned attachment 'missing'");
  } finally {
    await view.unmount();
    client.clear();
  }
});
