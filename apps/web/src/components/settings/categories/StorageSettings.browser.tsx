import "../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  NativeApi,
  StorageCleanupCategoryUsage,
  StorageCleanupResult,
  StorageUsageReport,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { SettingsLayout } from "../SettingsLayout";
import { StorageActionConfirmDialog } from "../StorageActionConfirmDialog";
import { StorageSettings } from "./StorageSettings";

const { nativeApiRef } = vi.hoisted(() => ({
  nativeApiRef: {
    current: undefined as NativeApi | undefined,
  },
}));

vi.mock("../../../nativeApi", () => ({
  ensureNativeApi: () => {
    if (!nativeApiRef.current) {
      throw new Error("Native API not found");
    }
    return nativeApiRef.current;
  },
  readNativeApi: () => nativeApiRef.current,
}));

vi.mock("./GeneralSettings", () => ({
  GeneralSettings: () => <div>General settings mock</div>,
}));
vi.mock("./DisplaySettings", () => ({
  DisplaySettings: () => <div>Display settings mock</div>,
}));
vi.mock("./NotificationsSettings", () => ({
  NotificationsSettings: () => <div>Notifications settings mock</div>,
}));
vi.mock("./ProvidersSettings", () => ({
  ProvidersSettings: () => <div>Providers settings mock</div>,
}));
vi.mock("./IntegrationsSettings", () => ({
  IntegrationsSettings: () => <div>Integrations settings mock</div>,
}));
vi.mock("./ProjectsSettings", () => ({
  ProjectsSettings: () => <div>Projects settings mock</div>,
}));
vi.mock("./ArchiveSettings", () => ({
  ArchiveSettings: () => <div>Archive settings mock</div>,
}));
vi.mock("./AboutSettings", () => ({
  AboutSettings: () => <div>About settings mock</div>,
}));

const GIB = 1024 * 1024 * 1024;
const NOW_ISO = "2026-05-08T12:00:00.000Z";

function category(
  input: Partial<StorageCleanupCategoryUsage> & {
    readonly id: StorageCleanupCategoryUsage["id"];
    readonly section: StorageCleanupCategoryUsage["section"];
    readonly title: string;
  },
): StorageCleanupCategoryUsage {
  return {
    id: input.id,
    section: input.section,
    title: input.title,
    description: input.description ?? `${input.title} description`,
    bytes: input.bytes ?? 0,
    reclaimableBytes: input.reclaimableBytes ?? 0,
    defaultSelected: input.defaultSelected ?? false,
    impact: input.impact ?? "none",
    availability: input.availability ?? "ready",
    ...(input.disabledReason ? { disabledReason: input.disabledReason } : {}),
    targetCount: input.targetCount ?? 0,
    targets: input.targets ?? [],
    warnings: input.warnings ?? [],
  };
}

function usageReport(input: Partial<StorageUsageReport> = {}): StorageUsageReport {
  const categories = input.categories ?? [
    category({
      id: "purgeDeletedThreads",
      section: "database",
      title: "Purge deleted threads",
      bytes: 0,
      reclaimableBytes: 0,
      defaultSelected: true,
      availability: "disabled",
      disabledReason: "There are no deleted threads to purge.",
    }),
    category({
      id: "providerLogsForTerminalThreads",
      section: "logs",
      title: "Prune logs for terminal threads",
      bytes: 2 * GIB,
      reclaimableBytes: 2 * GIB,
      defaultSelected: true,
      targetCount: 1,
      targets: [
        {
          id: "/tmp/provider/orphan.log",
          label: "orphan.log",
          path: "/tmp/provider/orphan.log",
          bytes: 2 * GIB,
          safeToDelete: true,
        },
      ],
    }),
    category({
      id: "legacyT3Diverged",
      section: "legacy",
      title: "Delete legacy diverged snapshots",
      bytes: 33 * GIB,
      reclaimableBytes: 0,
      impact: "high",
      availability: "disabled",
      disabledReason: "Disabled because custom F5_HOME or F5_STATE_DIR is in effect.",
    }),
  ];

  return {
    scanId: "scan-storage",
    confirmationNonce: "nonce-storage",
    nonceExpiresAt: "2026-05-08T12:05:00.000Z",
    scannedAt: NOW_ISO,
    stateDir: "/tmp/f5/userdata",
    totalUsedBytes: 47 * GIB,
    reclaimableBytes: categories.reduce((total, entry) => total + entry.reclaimableBytes, 0),
    databaseBytes: 5 * GIB,
    worktreesBytes: 7 * GIB,
    logsBytes: 2 * GIB,
    attachmentsBytes: 128 * 1024 * 1024,
    legacyBytes: 33 * GIB,
    threadCount: 12,
    archivedThreadCount: 3,
    deletedThreadCount: 0,
    providerLogSegmentCount: 4,
    envOverrideActive: Boolean(input.envOverrideActive),
    ...(input.legacyCleanupDisabledReason
      ? { legacyCleanupDisabledReason: input.legacyCleanupDisabledReason }
      : {}),
    categories,
    warnings: [],
    ...input,
  };
}

function cleanupResult(): StorageCleanupResult {
  return {
    operationId: "operation-storage",
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    reclaimedBytes: 2 * GIB,
    results: [
      {
        categoryId: "providerLogsForTerminalThreads",
        status: "Cleaned",
        reclaimedBytes: 2 * GIB,
        perTargetReclaimed: [],
        warnings: [],
      },
    ],
    warnings: [],
    cancelled: false,
  };
}

function createNativeApiMock(
  report: StorageUsageReport,
  result: StorageCleanupResult = cleanupResult(),
) {
  const getUsage = vi.fn(async () => report);
  const cleanup = vi.fn(async () => result);
  const cancelCleanup = vi.fn(async () => undefined);
  const confirm = vi.fn(async () => true);
  const onInvalidated = vi.fn(() => () => undefined);
  const onCleanupProgress = vi.fn(() => () => undefined);

  nativeApiRef.current = {
    storage: {
      getUsage,
      cleanup,
      cancelCleanup,
      onInvalidated,
      onCleanupProgress,
    },
    dialogs: {
      confirm,
    },
  } as unknown as NativeApi;

  return { getUsage, cleanup, cancelCleanup, confirm, onInvalidated, onCleanupProgress };
}

async function renderWithQueryClient(element: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  );
  return { screen, queryClient };
}

async function renderStorageSettings(report = usageReport(), result?: StorageCleanupResult) {
  const nativeApi = createNativeApiMock(report, result);
  const rendered = await renderWithQueryClient(<StorageSettings />);
  await vi.waitFor(() => {
    expect(nativeApi.getUsage).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Total used");
  });
  return { ...rendered, nativeApi };
}

function getDisabledState(element: Element | null) {
  return (
    element?.hasAttribute("disabled") ||
    element?.hasAttribute("data-disabled") ||
    element?.getAttribute("aria-disabled") === "true"
  );
}

describe("StorageSettings", () => {
  afterEach(() => {
    nativeApiRef.current = undefined;
    document.body.innerHTML = "";
  });

  it("renders usage sizes from the native API response", async () => {
    const { screen, queryClient } = await renderStorageSettings();

    try {
      expect(document.body.textContent).toContain("47 GB");
      expect(document.body.textContent).toContain("2 GB");
      expect(document.body.textContent).toContain("12");
      expect(document.body.textContent).toContain("3 archived");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("disables purge deleted threads when there are no deleted threads", async () => {
    const { screen, queryClient } = await renderStorageSettings();

    try {
      const checkbox = document.querySelector('[aria-label="Purge deleted threads"]');
      expect(getDisabledState(checkbox)).toBe(true);
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("shows the documented legacy disabled copy when env overrides are active", async () => {
    const { screen, queryClient } = await renderStorageSettings(
      usageReport({
        envOverrideActive: true,
        legacyCleanupDisabledReason:
          "Disabled because custom F5_HOME or F5_STATE_DIR is in effect.",
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Disabled because custom F5_HOME or F5_STATE_DIR is in effect.",
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("renders the worktrees section and keeps dirty targets disabled", async () => {
    const { screen, queryClient } = await renderStorageSettings(
      usageReport({
        categories: [
          category({
            id: "inactiveF5Worktrees",
            section: "worktrees",
            title: "Delete inactive F5 worktrees",
            bytes: 7 * GIB,
            reclaimableBytes: 0,
            impact: "high",
            targetCount: 1,
            targets: [
              {
                id: "/tmp/f5/worktrees/project/dirty",
                label: "project/dirty",
                path: "/tmp/f5/worktrees/project/dirty",
                bytes: 7 * GIB,
                safeToDelete: false,
                disabledReason: "Worktree has uncommitted changes.",
              },
            ],
          }),
        ],
      }),
    );

    try {
      expect(document.body.textContent).toContain("Worktrees (7 GB)");
      expect(document.body.textContent).toContain("project/dirty");
      expect(document.body.textContent).toContain("Worktree has uncommitted changes.");
      const reclaimButtons = Array.from(document.querySelectorAll("button")).filter((button) =>
        button.textContent?.includes("Reclaim"),
      );
      expect(reclaimButtons.some((button) => getDisabledState(button))).toBe(true);
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("sends selected legacy worktree target ids for selected cleanup", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings(
      usageReport({
        categories: [
          category({
            id: "legacyT3Worktrees",
            section: "legacy",
            title: "Delete legacy worktrees",
            description: "Removes unreferenced legacy T3 Git worktrees.",
            bytes: 768 * 1024 * 1024,
            reclaimableBytes: 768 * 1024 * 1024,
            impact: "high",
            targetCount: 3,
            targets: [
              {
                id: "legacy-a",
                label: "f3-code/t3code-a",
                path: "/tmp/.t3/worktrees/f3-code/t3code-a",
                bytes: 512 * 1024 * 1024,
                safeToDelete: true,
              },
              {
                id: "legacy-b",
                label: "f3-code/t3code-b",
                path: "/tmp/.t3/worktrees/f3-code/t3code-b",
                bytes: 256 * 1024 * 1024,
                safeToDelete: true,
              },
              {
                id: "legacy-live",
                label: "f3-code/t3code-live",
                path: "/tmp/.t3/worktrees/f3-code/t3code-live",
                bytes: 1024 * 1024 * 1024,
                safeToDelete: false,
                disabledReason: "Referenced by a live thread.",
              },
            ],
          }),
        ],
      }),
    );

    try {
      await expect.element(page.getByRole("button", { name: "Reclaim selected" })).toBeDisabled();
      const targetCheckbox = document.querySelector<HTMLElement>(
        '[aria-label="Select f3-code/t3code-a"]',
      );
      expect(targetCheckbox).not.toBeNull();
      targetCheckbox?.click();
      await expect
        .element(page.getByRole("button", { name: "Reclaim selected" }))
        .not.toBeDisabled();
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      const reclaimButtons = Array.from(document.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "Reclaim",
      );
      reclaimButtons.at(-1)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      await vi.waitFor(() => {
        expect(nativeApi.cleanup).toHaveBeenCalledTimes(1);
      });
      expect(nativeApi.cleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          categoryIds: ["legacyT3Worktrees"],
          targetSelections: [{ categoryId: "legacyT3Worktrees", targetIds: ["legacy-a"] }],
        }),
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("shows cleanup warnings when selected worktree cleanup does not reclaim storage", async () => {
    const warningResult: StorageCleanupResult = {
      operationId: "operation-storage",
      startedAt: NOW_ISO,
      completedAt: NOW_ISO,
      reclaimedBytes: 0,
      results: [
        {
          categoryId: "legacyT3Worktrees",
          status: "Failed",
          reclaimedBytes: 0,
          perTargetReclaimed: [],
          warnings: [
            {
              path: "/tmp/.t3/worktrees/f3-code/t3code-a",
              reason: "git worktree remove failed",
            },
          ],
        },
      ],
      warnings: [
        {
          path: "/tmp/.t3/worktrees/f3-code/t3code-a",
          reason: "git worktree remove failed",
        },
      ],
      cancelled: false,
    };
    const { screen, queryClient } = await renderStorageSettings(
      usageReport({
        categories: [
          category({
            id: "legacyT3Worktrees",
            section: "legacy",
            title: "Delete legacy worktrees",
            description: "Removes unreferenced legacy T3 Git worktrees.",
            bytes: 512 * 1024 * 1024,
            reclaimableBytes: 512 * 1024 * 1024,
            impact: "high",
            targetCount: 1,
            targets: [
              {
                id: "legacy-a",
                label: "f3-code/t3code-a",
                path: "/tmp/.t3/worktrees/f3-code/t3code-a",
                bytes: 512 * 1024 * 1024,
                safeToDelete: true,
              },
            ],
          }),
        ],
      }),
      warningResult,
    );

    try {
      document.querySelector<HTMLElement>('[aria-label="Select f3-code/t3code-a"]')?.click();
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      const reclaimButtons = Array.from(document.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "Reclaim",
      );
      reclaimButtons.at(-1)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Last cleanup result");
        expect(document.body.textContent).toContain("git worktree remove failed");
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("requires typed DELETE confirmation for cleanup actions over 1 GB", async () => {
    const onConfirm = vi.fn();
    const action = {
      title: "Prune logs for terminal threads",
      categories: [
        category({
          id: "providerLogsForTerminalThreads",
          section: "logs",
          title: "Prune logs for terminal threads",
          bytes: 2 * GIB,
          reclaimableBytes: 2 * GIB,
        }),
      ],
    };
    const screen = await render(
      <StorageActionConfirmDialog
        action={action}
        open
        pending={false}
        lastResult={null}
        onOpenChange={() => undefined}
        onConfirm={onConfirm}
      />,
    );

    try {
      await expect.element(page.getByText("Type DELETE to confirm")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Reclaim" })).toBeDisabled();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      await expect.element(page.getByRole("button", { name: "Reclaim" })).not.toBeDisabled();
      await page.getByRole("button", { name: "Reclaim" }).click();
      expect(onConfirm).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("requires typed DELETE confirmation for high-impact legacy actions under 1 GB", async () => {
    const onConfirm = vi.fn();
    const action = {
      title: "Delete legacy caches",
      categories: [
        category({
          id: "legacyT3Caches",
          section: "legacy",
          title: "Delete legacy caches",
          bytes: 1024,
          reclaimableBytes: 1024,
          impact: "high",
        }),
      ],
    };
    const screen = await render(
      <StorageActionConfirmDialog
        action={action}
        open
        pending={false}
        lastResult={null}
        onOpenChange={() => undefined}
        onConfirm={onConfirm}
      />,
    );

    try {
      await expect.element(page.getByText("Type DELETE to confirm")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Reclaim" })).toBeDisabled();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      await page.getByRole("button", { name: "Reclaim" }).click();
      expect(onConfirm).toHaveBeenCalledWith("DELETE");
    } finally {
      await screen.unmount();
    }
  });

  it("uses the storage dialog as the only cleanup confirmation", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();

    try {
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      const reclaimButtons = Array.from(document.querySelectorAll("button")).filter((button) =>
        button.textContent?.includes("Reclaim"),
      );
      reclaimButtons.at(-1)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => {
        expect(nativeApi.cleanup).toHaveBeenCalledTimes(1);
      });
      expect(nativeApi.confirm).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("does not call storage.getUsage while the Storage category is hidden", async () => {
    const nativeApi = createNativeApiMock(usageReport());
    const { screen, queryClient } = await renderWithQueryClient(
      <SettingsLayout category="general" onCategoryChange={() => undefined} />,
    );

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("General settings mock");
      });
      expect(nativeApi.getUsage).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
});
