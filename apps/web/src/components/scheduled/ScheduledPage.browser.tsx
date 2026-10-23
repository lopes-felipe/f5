import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_UNIFIED_SETTINGS, ProjectId, type ScheduledTask } from "@t3tools/contracts";
import { ScheduledPage } from "./ScheduledPage";
import { useStore } from "../../store";
import { TooltipProvider } from "../ui/tooltip";
import { createTestServerProvider } from "../../testServerProvider";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";

const mocks = vi.hoisted(() => ({
  permission: "default" as "default" | "granted" | "denied",
  list: vi.fn(),
  setEnabled: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
  request: vi.fn().mockResolvedValue("granted"),
}));
vi.mock("../../notifications", () => ({
  useNotificationPermissionState: () => mocks.permission,
  requestNotificationPermission: mocks.request,
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    scheduledTasks: {
      list: mocks.list,
      setEnabled: mocks.setEnabled,
      onChanged: () => () => {},
    },
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: mocks.update }),
}));
vi.mock("../../wsConnectionState", () => ({
  useWsConnectionState: () => ({ synchronized: false }),
}));
let active: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission = "default";
});
async function setup() {
  const id = ProjectId.makeUnsafe("project");
  useStore.setState({
    projects: [
      {
        id,
        name: "Project",
        cwd: "/repo",
        model: "gpt-5.6-sol",
        defaultModel: "gpt-5.6-sol",
        createdAt: "2026-01-01T00:00:00Z",
        expanded: true,
        scripts: [],
        memories: [],
        skills: [],
      },
    ],
  });
  const task = {
    id: "task",
    projectId: id,
    name: "Daily check",
    prompt: "Check",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    workspace: { kind: "projectRoot" },
    cron: "0 9 * * *",
    timezone: "UTC",
    scheduleSource: "daily",
    maxRuns: null,
    oneShotAt: null,
    notify: "all",
    enabled: false,
    version: 4,
    createdBy: "user",
    authority: { kind: "user" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    nextRunAt: null,
    lastRunAt: null,
    runsConsumed: 0,
  } as ScheduledTask;
  mocks.list.mockResolvedValue({
    tasks: [{ task, latestRun: null, activeRun: null }],
    revision: 0,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData<unknown>(serverConfigQueryOptions().queryKey, {
    providers: [createTestServerProvider("codex")],
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
  client.setQueryData<unknown>(
    gitBranchesQueryOptions({ cwd: "/repo", autoRefresh: false }).queryKey,
    {
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
      isRepo: true,
      hasOriginRemote: false,
    },
  );
  client.setQueryData<unknown>(projectSettingsQueryOptions(id).queryKey, {
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
  active = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ScheduledPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("switch", { name: "Enable Daily check" })).toBeVisible();
}
it("uses settings switches for global and individual enablement", async () => {
  await setup();
  await expect.element(page.getByRole("switch", { name: "Scheduler enabled" })).toBeChecked();
  await page.getByRole("switch", { name: "Scheduler enabled" }).click();
  expect(mocks.update).toHaveBeenCalledWith({
    scheduledTasks: { ...DEFAULT_UNIFIED_SETTINGS.scheduledTasks, enabled: false },
  });
  await page.getByRole("switch", { name: "Enable Daily check" }).click();
  expect(mocks.setEnabled).toHaveBeenCalledWith({ id: "task", expectedVersion: 4, enabled: true });
  await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
});
it("explains browser notifications and only requests permission from the button", async () => {
  await setup();
  await expect
    .element(
      page.getByText(
        "Receive system notifications when runs finish, fail or need your attention. Each task has its own notification preference.",
      ),
    )
    .toBeVisible();
  expect(mocks.request).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Allow notifications" }).click();
  expect(mocks.request).toHaveBeenCalledOnce();
});
it("shows granted permission without another request button", async () => {
  mocks.permission = "granted";
  await setup();
  await expect.element(page.getByText("Allowed", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Allow notifications" }))
    .not.toBeInTheDocument();
  expect(mocks.request).not.toHaveBeenCalled();
});
it("shows blocked permission guidance instead of an ineffective request button", async () => {
  mocks.permission = "denied";
  await setup();
  await expect
    .element(
      page.getByText("Notifications are blocked. Allow them in your browser’s site settings."),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Allow notifications" }))
    .not.toBeInTheDocument();
});
it("closes Edit scheduled task with the top-right X without saving", async () => {
  await setup();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect.element(page.getByRole("dialog", { name: "Edit scheduled task" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(page.getByRole("switch", { name: "Enable Daily check" })).toBeVisible();
  expect(mocks.setEnabled).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});
