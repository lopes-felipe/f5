import { toastManager } from "../../ui/toast";
import "../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type NativeApi,
  type StorageAutomationAuditResult,
  type StorageAutomationDryRunResult,
  type StorageCleanupCategoryUsage,
  type StorageCleanupResult,
  type StorageUsageReport,
  type StorageStatus,
  type StorageCleanupStatus,
  type StorageCleanupRequest,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { TestRouterContext } from "../../../test/routerContext";
import { SettingsLayout } from "../SettingsLayout";
import { StorageActionConfirmDialog } from "../StorageActionConfirmDialog";
import { StorageSettings } from "./StorageSettings";
import {
  noteWsConnectionOpened,
  noteWsSynchronized,
  resetWsConnectionStateForTests,
} from "../../../wsConnectionState";

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
vi.mock("./AppearanceSettings", () => ({
  AppearanceSettings: () => <div>Appearance settings mock</div>,
}));
vi.mock("./ConversationSettings", () => ({
  ConversationSettings: () => <div>Conversation settings mock</div>,
}));
vi.mock("./KeyboardSettings", () => ({
  KeyboardSettings: () => <div>Keyboard settings mock</div>,
}));
vi.mock("./NotificationsSettings", () => ({
  NotificationsSettings: () => <div>Notifications settings mock</div>,
}));
vi.mock("./ProvidersSettings", () => ({
  ProvidersSettings: () => <div>Providers settings mock</div>,
}));
// Project scope reuses the sub-agent controls from this module.
vi.mock("./ThreadsSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ThreadsSettings")>()),
  ThreadsSettings: () => <div>Threads settings mock</div>,
}));
vi.mock("./ToolsSettings", () => ({
  ToolsSettings: () => <div>Tools settings mock</div>,
}));
vi.mock("./BrowserComputerSettings", () => ({
  BrowserComputerSettings: () => <div>BrowserComputer settings mock</div>,
}));
vi.mock("./ProjectsSettings", () => ({
  ProjectsSettings: () => <div>Projects settings mock</div>,
}));
vi.mock("./ProjectSettings", () => ({
  ProjectSettings: () => <div>Project settings mock</div>,
}));
vi.mock("./GitSettings", () => ({
  GitSettings: () => <div>Git settings mock</div>,
}));
vi.mock("./AccountsSettings", () => ({
  AccountsSettings: () => <div>Accounts settings mock</div>,
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
    measurement: "complete",
    eligibleThreadCount: 0,
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
    scannedAt: NOW_ISO,
    stateDir: "/tmp/f5/userdata",
    totalUsedBytes: 47 * GIB,
    reclaimableBytes: categories.reduce((total, entry) => total + entry.reclaimableBytes, 0),
    databaseBytes: 5 * GIB,
    worktreesBytes: 7 * GIB,
    logsBytes: 2 * GIB,
    attachmentsBytes: 128 * 1024 * 1024,
    legacyBytes: 33 * GIB,
    providerHomesBytes: 0,
    otherBytes: 0,
    providerHomes: [],
    warningsTruncated: false,
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
  let status: StorageStatus = {
    backendEpoch: "backend-test",
    revision: 1,
    updatedAt: NOW_ISO,
    scan: { state: "idle", phase: null, entriesVisited: 0, startedAt: null, error: null },
    cleanup: null,
  };
  const getUsage = vi.fn(async () => ({
    report,
    confirmation: {
      scanId: report.scanId,
      nonce: "nonce-storage",
      expiresAt: "2099-05-08T12:05:00.000Z",
    },
    status,
  }));
  const getStatus = vi.fn(async () => status);
  const getTargets = vi.fn(async () => ({
    targets: [] as StorageCleanupCategoryUsage["targets"],
    targetCount: 0,
    nextCursor: null,
  }));
  const cleanup = vi.fn(async (request?: StorageCleanupRequest): Promise<StorageCleanupStatus> => {
    const operation: StorageCleanupStatus = {
      operationId: request?.operationId ?? result.operationId,
      state: "succeeded" as const,
      completedAt: result.completedAt,
      startedAt: result.startedAt,
      result: { ...result, operationId: request?.operationId ?? result.operationId },
      progress: null,
      error: null,
      omittedCount: 0,
    };
    status = { ...status, revision: status.revision + 1, cleanup: operation };
    return operation;
  });
  const cancelCleanup = vi.fn(async () => undefined);
  const confirm = vi.fn(async () => true);
  const onInvalidated = vi.fn(() => () => undefined);
  const statusListeners = new Set<(status: StorageStatus) => void>();
  const onStatusUpdated = vi.fn((listener: (status: StorageStatus) => void) => {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  });
  const emitStatus = (next: StorageStatus) => {
    status = next;
    for (const listener of statusListeners) listener(next);
  };
  const getOperation = vi.fn(async ({ operationId }: { operationId: string }) => {
    if (status.cleanup?.operationId !== operationId) throw new Error("operation_unknown");
    return { status: status.cleanup, results: [], nextCursor: null };
  });
  const automationDryRun = vi.fn(
    async (): Promise<StorageAutomationDryRunResult> => ({
      storageCleanupEnabled: true,
      generatedAt: NOW_ISO,
      targets: [
        {
          job: "worktree-cleanup",
          target: "f5/feature-a",
          projectId: null,
          threadId: null,
          action: "remove",
          reason: "idle for 31 days",
        },
        {
          job: "worktree-cleanup",
          target: "f5/feature-b",
          projectId: null,
          threadId: null,
          action: "skip",
          reason: "idle for 40 days, but ignored files other than node_modules/ (.env)",
        },
      ],
    }),
  );
  const automationAudit = vi.fn(
    async (): Promise<StorageAutomationAuditResult> => ({
      entries: [
        {
          auditId: "audit-1",
          source: "automatic",
          category: null,
          reasonCode: null,
          summary: null,
          operationId: "op-1",
          job: "auto-pull",
          policyVersion: 1,
          target: "Project f5",
          projectId: null,
          threadId: null,
          beforeRef: "a".repeat(40),
          afterRef: "b".repeat(40),
          result: "pulled",
          reason: "fast-forwarded main",
          createdAt: NOW_ISO,
        },
      ],
    }),
  );
  // Deep-merges storageCleanup like the server, since the UI sends only changed fields.
  const updateSettings = vi.fn(async (patch: Record<string, unknown>) => ({
    ...DEFAULT_SERVER_SETTINGS,
    ...patch,
    storageCleanup: {
      ...DEFAULT_SERVER_SETTINGS.storageCleanup,
      ...(patch.storageCleanup as object | undefined),
    },
  }));

  nativeApiRef.current = {
    storage: {
      getUsage,
      getStatus,
      getTargets,
      getOperation,
      getDiskSpace: async () => ({
        level: "ok",
        checkedAt: NOW_ISO,
        lowThresholdBytes: 0,
        criticalThresholdBytes: 0,
        volumes: [],
        reclaimable: [],
      }),
      onDiskSpaceUpdated: () => () => {},
      cleanup,
      cancelCleanup,
      onInvalidated,
      onStatusUpdated,
      automationDryRun,
      automationAudit,
    },
    server: {
      getConfig: vi.fn(async () => ({ settings: DEFAULT_SERVER_SETTINGS })),
      updateSettings,
    },
    dialogs: {
      confirm,
    },
  } as unknown as NativeApi;

  return {
    getUsage,
    getStatus,
    getTargets,
    getOperation,
    emitStatus,
    cleanup,
    cancelCleanup,
    confirm,
    onInvalidated,
    onStatusUpdated,
    automationDryRun,
    automationAudit,
    updateSettings,
  };
}

async function renderWithQueryClient(element: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <TestRouterContext>{element}</TestRouterContext>
    </QueryClientProvider>,
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

function pressEnter(element: Element) {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function getDisabledState(element: Element | null) {
  return (
    element?.hasAttribute("disabled") ||
    element?.hasAttribute("data-disabled") ||
    element?.getAttribute("aria-disabled") === "true"
  );
}

describe("StorageSettings", () => {
  it.each(["conversations", "action"] as const)(
    "resets archive consent when reviewed %s change without changing IDs or sizes",
    async (change) => {
      const dialog = (updated: boolean) => (
        <StorageActionConfirmDialog
          action={{
            title: "Archive and remove",
            confirmation: { scanId: "scan", nonce: "nonce", expiresAt: "2099-01-01T00:00:00.000Z" },
            categories: [
              category({
                id: "inactiveF5Worktrees",
                section: "worktrees",
                title: "Idle worktrees",
                impact: "low",
                bytes: 10,
                reclaimableBytes: 10,
                targets: ["a", "b"].map((id) => ({
                  id,
                  label: id,
                  bytes: 5,
                  safeToDelete: true,
                  ...(updated && change === "action" && id === "a"
                    ? {}
                    : { action: "archiveAndRemove" as const }),
                  affectedThreads: [
                    {
                      threadId: ThreadId.makeUnsafe(
                        updated && change === "conversations" ? id + "-new" : id,
                      ),
                      title: id,
                    },
                  ],
                })),
              }),
            ],
          }}
          open
          pending={false}
          lastResult={null}
          onOpenChange={() => {}}
          onConfirm={() => {}}
        />
      );
      const screen = await render(dialog(false));
      try {
        const consent = page.getByRole("checkbox", { name: "Archive the listed conversations" });
        const reclaim = page.getByRole("button", { name: "Reclaim", exact: true });
        await consent.click();
        await expect.element(consent).toBeChecked();
        await expect.element(reclaim).not.toBeDisabled();
        await screen.rerender(dialog(true));
        await expect.element(consent).not.toBeChecked();
        await expect.element(reclaim).toBeDisabled();
      } finally {
        await screen.unmount();
      }
    },
  );
  it("reviews idle conversations and sends explicit archive-and-remove consent", async () => {
    const report = usageReport({
      categories: [
        category({
          id: "inactiveF5Worktrees",
          section: "worktrees",
          title: "Idle worktrees",
          impact: "high",
          targetCount: 1,
          bytes: 1000,
          reclaimableBytes: 1000,
          targets: [
            {
              id: "idle",
              path: "/worktrees/idle",
              label: "Idle checkout",
              bytes: 1000,
              safeToDelete: true,
              action: "archiveAndRemove",
              affectedThreads: [
                { threadId: ThreadId.makeUnsafe("idle-thread"), title: "Keep this conversation" },
              ],
            },
          ],
        }),
      ],
    });
    const { nativeApi, screen, queryClient } = await renderStorageSettings(report);
    try {
      await page.getByRole("button", { name: "Archive and remove" }).click();
      await expect.element(page.getByText("Keep this conversation", { exact: true })).toBeVisible();
      await page.getByPlaceholder("DELETE", { exact: true }).fill("DELETE");
      const archiveConsent = document.querySelector<HTMLElement>(
        '[aria-label="Archive the listed conversations"]',
      )!;
      const reclaim = page
        .getByRole("dialog")
        .getByRole("button", { name: "Reclaim", exact: true });
      await expect.element(reclaim).toBeDisabled();
      archiveConsent.click();
      const dialog = document.querySelector('[role="dialog"]')!;
      const confirm = [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Reclaim",
      )!;
      confirm.click();
      await vi.waitFor(() =>
        expect(nativeApi.cleanup).toHaveBeenCalledWith(
          expect.objectContaining({
            options: { archiveIdleThreads: true },
            targetSelections: [{ categoryId: "inactiveF5Worktrees", targetIds: ["idle"] }],
          }),
        ),
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
  it("keeps machine candidates unselected and displays the observed disk-space change separately", async () => {
    const report = usageReport({
      categories: [
        category({
          id: "bunDownloadCache",
          section: "machine",
          title: "Bun download cache",
          targetCount: 1,
          defaultSelected: false,
          bytes: 1000,
          reclaimableBytes: 1000,
          targets: [{ id: "cache", label: "Download cache", bytes: 1000, safeToDelete: true }],
        }),
      ],
    });
    const { screen, nativeApi, queryClient } = await renderStorageSettings(report, {
      ...cleanupResult(),
      volumeChanges: [
        { path: "/volume", freeBeforeBytes: 1000, freeAfterBytes: 1500, netFreeBytes: 500 },
      ],
    });
    try {
      await expect.element(page.getByRole("button", { name: "Reclaim selected" })).toBeDisabled();
      expect(nativeApi.cleanup).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Bun download cache");
      document.querySelector<HTMLElement>('[aria-label="Select Download cache"]')!.click();
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      const dialog = document.querySelector('[role="dialog"]')!;
      [...dialog.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Reclaim")!
        .click();
      await expect.element(page.getByText(/Observed net free-space change:/)).toBeVisible();
      await expect.element(page.getByText(/Estimated storage removed:/)).toBeVisible();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
  it("persists explicit machine discovery and repository folders on the server", async () => {
    const { screen, nativeApi, queryClient } = await renderStorageSettings();
    try {
      await page.getByRole("switch", { name: "Scan machine cleanup candidates" }).click();
      await page
        .getByRole("textbox", { name: "Repository search folders" })
        .fill("/work/repos\n/work/other");
      await page.getByRole("button", { name: "Save and rescan" }).click();
      await vi.waitFor(() =>
        expect(nativeApi.updateSettings).toHaveBeenCalledWith({
          storageDiscovery: {
            machineCleanupEnabled: true,
            repositoryRoots: ["/work/repos", "/work/other"],
          },
        }),
      );
      await vi.waitFor(() => expect(nativeApi.getUsage).toHaveBeenCalledWith({ force: true }));
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
  it("keeps a selected target beyond the first 500 after reconnecting to the same scan", async () => {
    const targets = Array.from({ length: 501 }, (_, id) => ({
      id: `log-${id}`,
      label: `log-${id}.log`,
      bytes: 1000 - id,
      safeToDelete: true,
    }));
    const report = usageReport({
      categories: [
        category({
          id: "providerLogsForTerminalThreads",
          section: "logs",
          title: "Provider logs",
          bytes: 500000,
          reclaimableBytes: 500000,
          targetCount: 501,
          targets: targets.slice(0, 500),
        }),
      ],
    });
    const { screen, queryClient, nativeApi } = await renderStorageSettings(report);
    nativeApi.getTargets.mockResolvedValue({
      targets: targets.slice(500),
      targetCount: 501,
      nextCursor: null,
    });
    try {
      await page.getByRole("button", { name: "Inspect 501 targets" }).click();
      await page.getByRole("button", { name: "Load 100 more targets" }).click();
      await page.getByRole("checkbox", { name: /log-500\.log/ }).click();
      const refreshed = { ...(await nativeApi.getStatus()), revision: 2 };
      nativeApi.emitStatus(refreshed);
      noteWsConnectionOpened();
      noteWsSynchronized();
      await vi.waitFor(() => expect(nativeApi.getUsage.mock.calls.length).toBeGreaterThan(1));
      await queryClient.invalidateQueries({ queryKey: ["storage", "usage"] });
      await expect.element(page.getByRole("checkbox", { name: /log-500\.log/ })).toBeChecked();
      await page.getByRole("button", { name: "Reclaim selected", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Reclaim", exact: true }).click();
      await vi.waitFor(() =>
        expect(nativeApi.cleanup).toHaveBeenCalledWith(
          expect.objectContaining({
            targetSelections: [
              { categoryId: "providerLogsForTerminalThreads", targetIds: ["log-500"] },
            ],
          }),
        ),
      );
    } finally {
      await screen.unmount();
      resetWsConnectionStateForTests();
      queryClient.clear();
    }
  });

  it("recovers a lost cleanup acknowledgement using the same operation id", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();
    nativeApi.cleanup.mockRejectedValueOnce(new Error("WebSocket connection closed."));
    try {
      noteWsConnectionOpened();
      noteWsSynchronized();
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      await page.getByRole("dialog").getByRole("button", { name: "Reclaim", exact: true }).click();
      await vi.waitFor(() => expect(nativeApi.cleanup).toHaveBeenCalledTimes(2));
      expect(nativeApi.cleanup.mock.calls[1]?.[0]).toEqual(nativeApi.cleanup.mock.calls[0]?.[0]);
      expect(nativeApi.getOperation).toHaveBeenCalledWith({
        operationId: nativeApi.cleanup.mock.calls[0]?.[0]?.operationId,
      });
      await expect.element(page.getByRole("button", { name: "Rescan", exact: true })).toBeEnabled();
    } finally {
      await screen.unmount();
      resetWsConnectionStateForTests();
      queryClient.clear();
    }
  });
  it("keeps another window's active cleanup while resolving our earlier completion", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();
    let ownId = "";
    nativeApi.cleanup.mockImplementationOnce(async (request) => {
      ownId = request!.operationId;
      const operation: StorageCleanupStatus = {
        operationId: ownId,
        state: "running",
        startedAt: NOW_ISO,
        completedAt: null,
        result: null,
        error: null,
        omittedCount: 0,
        progress: null,
      };
      nativeApi.emitStatus({ ...(await nativeApi.getStatus()), revision: 2, cleanup: operation });
      return operation;
    });
    try {
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      await page.getByRole("dialog").getByRole("button", { name: "Reclaim", exact: true }).click();
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
      const completed: StorageCleanupStatus = {
        operationId: ownId,
        state: "succeeded",
        startedAt: NOW_ISO,
        completedAt: NOW_ISO,
        result: { ...cleanupResult(), operationId: ownId },
        error: null,
        omittedCount: 0,
        progress: null,
      };
      nativeApi.getOperation.mockResolvedValueOnce({
        status: completed,
        results: [],
        nextCursor: null,
      });
      nativeApi.emitStatus({
        ...(await nativeApi.getStatus()),
        revision: 3,
        cleanup: {
          ...completed,
          operationId: "other-window",
          state: "running",
          completedAt: null,
          result: null,
          progress: {
            operationId: "other-window",
            phase: "deleting",
            message: "Other window is cleaning",
            completedTargets: 1,
            totalTargets: 10,
          },
        },
      });
      await vi.waitFor(() => expect(document.body.textContent).toContain("Last cleanup result"));
      await expect.element(page.getByText("Other window is cleaning")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Reclaim selected" })).toBeDisabled();
      expect(nativeApi.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
  it("does not become busy again when acceptance arrives after a completed status push", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();
    let acknowledge!: (operation: StorageCleanupStatus) => void;
    nativeApi.cleanup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    try {
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      await page.getByRole("dialog").getByRole("button", { name: "Reclaim", exact: true }).click();
      await vi.waitFor(() => expect(nativeApi.cleanup).toHaveBeenCalledTimes(1));
      const request = nativeApi.cleanup.mock.calls[0]![0]!;
      const completed: StorageCleanupStatus = {
        operationId: request.operationId,
        state: "succeeded",
        startedAt: NOW_ISO,
        completedAt: NOW_ISO,
        result: { ...cleanupResult(), operationId: request.operationId },
        progress: null,
        error: null,
        omittedCount: 0,
      };
      nativeApi.emitStatus({ ...(await nativeApi.getStatus()), revision: 2, cleanup: completed });
      await expect.element(page.getByRole("button", { name: "Rescan", exact: true })).toBeEnabled();
      acknowledge({ ...completed, state: "queued", completedAt: null, result: null });
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
      await expect.element(page.getByRole("button", { name: "Rescan", exact: true })).toBeEnabled();
      expect(nativeApi.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
  it("shows unavailable provider usage while leaving accessible cleanup usable", async () => {
    const { screen, queryClient } = await renderStorageSettings(
      usageReport({ providerHomesMeasurement: "unavailable" }),
    );
    try {
      await expect
        .element(page.getByRole("heading", { name: "Provider homes (Unavailable)" }))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "Reclaim selected" })).toBeEnabled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
  it("recovers from backend restart after accepting cleanup without replaying the request", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();
    const toast = vi.spyOn(toastManager, "add");
    nativeApi.cleanup.mockImplementationOnce(async (request) => {
      const operation: StorageCleanupStatus = {
        operationId: request!.operationId,
        state: "running",
        startedAt: NOW_ISO,
        completedAt: null,
        result: null,
        error: null,
        omittedCount: 0,
        progress: {
          operationId: request!.operationId,
          phase: "deleting",
          message: "Removing reviewed targets",
          completedTargets: 0,
          totalTargets: 10,
        },
      };
      nativeApi.emitStatus({ ...(await nativeApi.getStatus()), revision: 2, cleanup: operation });
      return operation;
    });
    try {
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      await page.getByRole("dialog").getByRole("button", { name: "Reclaim", exact: true }).click();
      await expect.element(page.getByText("Removing reviewed targets")).toBeVisible();
      nativeApi.emitStatus({
        backendEpoch: "restarted-backend",
        revision: 0,
        updatedAt: "2099-01-01T00:00:00.000Z",
        cleanup: null,
        scan: { state: "idle", phase: null, entriesVisited: 0, error: null, startedAt: null },
      });
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "F5 restarted. The previous cleanup status is unavailable.",
          }),
        ),
      );
      await expect.element(page.getByRole("button", { name: "Rescan", exact: true })).toBeEnabled();
      await expect.element(page.getByRole("button", { name: "Reclaim selected" })).toBeEnabled();
      expect(nativeApi.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      toast.mockRestore();
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("resolves a missing acknowledged operation after reconnect and releases local pending state", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();
    const toast = vi.spyOn(toastManager, "add");
    nativeApi.cleanup.mockImplementationOnce(async (request) => {
      const operation: StorageCleanupStatus = {
        operationId: request!.operationId,
        state: "running",
        startedAt: NOW_ISO,
        completedAt: null,
        result: null,
        error: null,
        omittedCount: 0,
        progress: null,
      };
      nativeApi.emitStatus({ ...(await nativeApi.getStatus()), revision: 2, cleanup: operation });
      return operation;
    });
    try {
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      await page.getByRole("dialog").getByRole("button", { name: "Reclaim", exact: true }).click();
      await vi.waitFor(() => expect(nativeApi.cleanup).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
      nativeApi.emitStatus({ ...(await nativeApi.getStatus()), revision: 3, cleanup: null });
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: "The previous cleanup is no longer available." }),
        ),
      );
      expect(nativeApi.getOperation).toHaveBeenCalledTimes(1);
      await expect.element(page.getByRole("button", { name: "Rescan", exact: true })).toBeEnabled();
      expect(nativeApi.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      toast.mockRestore();
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("keeps Cancel usable before acceptance and repeats it after the acknowledgement", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();
    type Accepted = Awaited<ReturnType<typeof nativeApi.cleanup>>;
    let acknowledge!: (operation: Accepted) => void;
    nativeApi.cleanup.mockImplementationOnce(
      () =>
        new Promise<Accepted>((resolve) => {
          acknowledge = resolve;
        }),
    );
    try {
      await page.getByRole("button", { name: "Reclaim selected" }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      await page.getByRole("dialog").getByRole("button", { name: "Reclaim", exact: true }).click();
      await vi.waitFor(() => expect(nativeApi.cleanup).toHaveBeenCalledTimes(1));
      const request = (
        nativeApi.cleanup.mock.calls as unknown as [[{ operationId: string }]]
      )[0][0];
      await expect.element(page.getByRole("dialog").getByText("Starting…")).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect(nativeApi.cancelCleanup).toHaveBeenCalledWith({ operationId: request.operationId });
      const result = { ...cleanupResult(), operationId: request.operationId };
      acknowledge({
        operationId: request.operationId,
        state: "succeeded",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        result,
        progress: null,
        error: null,
        omittedCount: 0,
      });
      await vi.waitFor(() => expect(nativeApi.cancelCleanup).toHaveBeenCalledTimes(2));
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
  afterEach(() => {
    nativeApiRef.current = undefined;
    document.body.innerHTML = "";
  });

  it("renders orphan attachments without selecting them by default", async () => {
    const { screen, queryClient } = await renderStorageSettings(
      usageReport({
        categories: [
          category({
            id: "orphanAttachments",
            section: "attachments",
            title: "Delete orphaned attachments",
            bytes: 4096,
            reclaimableBytes: 4096,
            targets: [
              {
                id: "orphan",
                label: "unowned.png",
                path: "/tmp/attachments/unowned.png",
                bytes: 4096,
                safeToDelete: true,
              },
            ],
            targetCount: 1,
          }),
        ],
      }),
    );
    try {
      await expect.element(page.getByRole("heading", { name: /^Attachments/ })).toBeInTheDocument();
      await expect.element(page.getByRole("checkbox", { name: /unowned\.png/ })).not.toBeChecked();
      await expect
        .element(page.getByRole("button", { name: "Reclaim selected", exact: true }))
        .toBeDisabled();
      await page.getByRole("checkbox", { name: /unowned\.png/ }).click();
      await expect
        .element(page.getByRole("button", { name: "Reclaim selected", exact: true }))
        .not.toBeDisabled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
  it("toasts a rejected cleanup, closes its dialog, and refreshes usage", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();
    const toast = vi.spyOn(toastManager, "add");
    nativeApi.cleanup.mockRejectedValueOnce(new Error("Storage changed since review."));
    try {
      await page.getByRole("button", { name: "Reclaim selected", exact: true }).click();
      await page.getByPlaceholder("DELETE").fill("DELETE");
      await page.getByRole("button", { name: "Reclaim", exact: true }).click();
      await vi.waitFor(() => {
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Cleanup failed",
            description: "Storage changed since review.",
          }),
        );
        expect(nativeApi.getUsage.mock.calls.length).toBeGreaterThan(1);
      });
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      toast.mockRestore();
      queryClient.clear();
      await screen.unmount();
    }
  });
  it("requires DELETE for a large database even when few bytes can be reclaimed", async () => {
    const screen = await render(
      <StorageActionConfirmDialog
        action={{
          title: "Compact database",
          confirmation: { scanId: "scan", nonce: "nonce", expiresAt: "2099-01-01T00:00:00.000Z" },
          categories: [
            category({
              id: "databaseVacuum",
              section: "database",
              title: "Compact database",
              bytes: 2 * GIB,
              reclaimableBytes: 4096,
            }),
          ],
        }}
        open
        pending={false}
        lastResult={null}
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />,
    );
    try {
      await expect.element(page.getByPlaceholder("DELETE")).toBeInTheDocument();
      await expect.element(page.getByText(/F5 stays responsive/)).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("saves automatic cleanup settings and previews targets with exact skip reasons", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();

    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain("Auto-pull: Pulled"));
      expect(document.body.textContent).toContain("fast-forwarded main");

      await page.getByRole("switch", { name: "Automatic storage cleanup" }).click();
      await vi.waitFor(() =>
        expect(nativeApi.updateSettings).toHaveBeenCalledWith({
          storageCleanup: { enabled: true },
        }),
      );

      await page.getByRole("button", { name: "Preview what would run" }).click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Would remove: idle for 31 days");
        expect(document.body.textContent).toContain(
          "Skipped: idle for 40 days, but ignored files other than node_modules/ (.env)",
        );
      });
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("rejects an out-of-range retention without saving it", async () => {
    const { screen, queryClient, nativeApi } = await renderStorageSettings();

    try {
      const input = page.getByRole("textbox", {
        name: "Keep preview screenshots and recordings for",
      });
      await input.fill("9999");
      pressEnter(input.element());
      await vi.waitFor(() => expect(input.element().getAttribute("aria-invalid")).toBe("true"));
      expect(nativeApi.updateSettings).not.toHaveBeenCalled();
      await input.fill("14");
      pressEnter(input.element());
      await vi.waitFor(() =>
        expect(nativeApi.updateSettings).toHaveBeenCalledWith({
          storageCleanup: { previewArtifactRetentionDays: 14 },
        }),
      );
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
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

  it("selects missing worktree entries by default but never external worktrees", async () => {
    const { screen, queryClient } = await renderStorageSettings(
      usageReport({
        categories: [
          category({
            id: "externalWorktrees",
            section: "worktrees",
            title: "Delete external worktrees",
            bytes: 64 * 1024 * 1024,
            reclaimableBytes: 64 * 1024 * 1024,
            impact: "high",
            targetCount: 1,
            targets: [
              {
                id: "/tmp/elsewhere/feature",
                label: "~/elsewhere/feature",
                projectName: "f5",
                path: "/tmp/elsewhere/feature",
                bytes: 64 * 1024 * 1024,
                safeToDelete: true,
                detail: "External · feature · Discards 1 changed file: mockServiceWorker.js",
              },
            ],
          }),
          category({
            id: "staleWorktreeRegistrations",
            section: "worktrees",
            title: "Prune missing worktree entries",
            defaultSelected: true,
            targetCount: 1,
            targets: [
              {
                id: "/tmp/gone",
                label: "/tmp/gone",
                path: "/tmp/gone",
                bytes: 0,
                safeToDelete: true,
                detail: "Missing folder · gone",
              },
            ],
          }),
        ],
      }),
    );

    try {
      await expect
        .element(page.getByRole("checkbox", { name: "Select ~/elsewhere/feature" }))
        .not.toBeChecked();
      await expect.element(page.getByRole("checkbox", { name: "Select /tmp/gone" })).toBeChecked();
      expect(document.body.textContent).toContain(
        "f5 · External · feature · Discards 1 changed file: mockServiceWorker.js",
      );
      expect(document.body.textContent).toContain("Missing folder · gone");
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
      await page.getByText("Advanced legacy cleanup").click();
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
      await page.getByText("Advanced legacy cleanup").click();
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
      confirmation: {
        scanId: "scan-storage",
        nonce: "nonce-storage",
        expiresAt: "2099-05-08T12:05:00.000Z",
      },
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
      confirmation: {
        scanId: "scan-storage",
        nonce: "nonce-storage",
        expiresAt: "2099-05-08T12:05:00.000Z",
      },
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
