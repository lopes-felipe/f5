import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  DEFAULT_UNIFIED_SETTINGS,
  ProjectId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { ScheduledRouteContent } from "./ScheduledRouteContent";
import { parseScheduledSearch } from "./scheduledSearch";
import { useScheduledInvalidation } from "../../hooks/useScheduledInvalidation";
import { useStore } from "../../store";
import { TooltipProvider } from "../ui/tooltip";
import { createTestServerProvider } from "../../testServerProvider";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listRuns: vi.fn(),
  create: vi.fn(),
  changed: [] as Array<() => void>,
}));
vi.mock("../../notifications", () => ({
  useNotificationPermissionState: () => "granted",
  requestNotificationPermission: vi.fn(),
}));
vi.mock("../../nativeApi", () => {
  const api = {
    scheduledTasks: {
      list: mocks.list,
      listRuns: mocks.listRuns,
      create: mocks.create,
      onChanged: (listener: () => void) => {
        mocks.changed.push(listener);
        return () => {
          mocks.changed = mocks.changed.filter((entry) => entry !== listener);
        };
      },
    },
  };
  return { ensureNativeApi: () => api, readNativeApi: () => api };
});
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
vi.mock("../../wsConnectionState", () => ({
  useWsConnectionState: () => ({ synchronized: false }),
}));

const projectId = ProjectId.makeUnsafe("project");
const otherId = ProjectId.makeUnsafe("other");
const conversation = ThreadId.makeUnsafe("conversation");
const project = (id: ProjectId, name: string, cwd: string) => ({
  id,
  name,
  cwd,
  model: "gpt-5.6-sol",
  defaultModel: "gpt-5.6-sol",
  createdAt: "2026-01-01T00:00:00Z",
  expanded: true,
  scripts: [],
  memories: [],
  skills: [],
});
const task = {
  id: "task",
  projectId,
  name: "Daily check",
  prompt: "Check",
  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspace: { kind: "projectRoot" },
  cron: "0 9 * * *",
  timezone: "UTC",
  scheduleSource: "0 9 * * *",
  maxRuns: null,
  oneShotAt: null,
  notify: "all",
  enabled: true,
  version: 1,
  createdBy: "user",
  authority: { kind: "user" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  nextRunAt: null,
  lastRunAt: null,
  runsConsumed: 0,
} as ScheduledTask;

let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.changed = [];
  mocks.list.mockResolvedValue({
    tasks: [{ task, latestRun: null, activeRun: null }],
    revision: 0,
  });
  mocks.listRuns.mockResolvedValue({ runs: [], nextCursor: null });
  useStore.setState({
    projects: [project(projectId, "Project", "/repo"), project(otherId, "Other", "/other")],
    threads: [
      {
        id: conversation,
        projectId: otherId,
        title: "Release notes",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ] as never,
    threadsHydrated: true,
  });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

function Root() {
  useScheduledInvalidation();
  return <Outlet />;
}
async function setup(url: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData<unknown>(serverConfigQueryOptions().queryKey, {
    providers: [createTestServerProvider("codex")],
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
  for (const [id, cwd] of [
    [projectId, "/repo"],
    [otherId, "/other"],
  ] as const) {
    client.setQueryData<unknown>(gitBranchesQueryOptions({ cwd, autoRefresh: false }).queryKey, {
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
      isRepo: true,
      hasOriginRemote: false,
    });
    client.setQueryData<unknown>(projectSettingsQueryOptions(id).queryKey, {
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
  }
  const rootRoute = createRootRoute({ component: Root });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/scheduled",
        validateSearch: parseScheduledSearch,
        component: ScheduledRouteContent,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/$threadId",
        component: () => <p>Conversation</p>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  active = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}
const filter = () => page.getByRole("combobox", { name: "Project filter" });
const taskCard = () => page.getByRole("heading", { name: "Daily check" });

it("keeps the project filter in the URL across back and forward", async () => {
  const router = await setup("/scheduled");
  await expect.element(taskCard()).toBeVisible();
  await expect.element(page.getByRole("option", { name: "All projects (1)" })).toBeInTheDocument();
  await filter().selectOptions("other");
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ projectId: "other" }));
  await expect.element(page.getByText("No scheduled tasks in this project.")).toBeVisible();
  await expect.element(taskCard()).not.toBeInTheDocument();
  router.history.back();
  await expect.element(taskCard()).toBeVisible();
  await expect.element(filter()).toHaveValue("");
  router.history.forward();
  await expect.element(filter()).toHaveValue("other");
  await expect.element(taskCard()).not.toBeInTheDocument();
});

it("lets a task link win over a project filter and a conversation", async () => {
  const router = await setup(`/scheduled?taskId=task&projectId=other&threadId=${conversation}`);
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ taskId: "task" }));
  await expect.element(taskCard()).toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("opens an edit request once and clears only the edit flag", async () => {
  const router = await setup("/scheduled?taskId=task&edit=true");
  await expect.element(page.getByRole("dialog", { name: "Edit scheduled task" })).toBeVisible();
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ taskId: "task" }));
});

it("tells a missing task apart from one the filter hides", async () => {
  await setup("/scheduled?taskId=gone");
  await expect
    .element(page.getByText("This task is no longer available.", { exact: false }))
    .toBeVisible();
  expect(mocks.listRuns).toHaveBeenCalledWith(expect.objectContaining({ taskId: "gone" }));
  await active?.unmount();
  await setup("/scheduled?projectId=other");
  await expect.element(page.getByText("No scheduled tasks in this project.")).toBeVisible();
  await expect
    .element(page.getByText("This task is no longer available.", { exact: false }))
    .not.toBeInTheDocument();
});

it("waits for hydration before calling a filtered project unknown", async () => {
  useStore.setState({ threadsHydrated: false });
  const router = await setup("/scheduled?projectId=removed");
  await expect.element(page.getByText("Loading projects…")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Show all projects" }))
    .not.toBeInTheDocument();
  useStore.setState({ threadsHydrated: true });
  await expect.element(page.getByText("This project is no longer available.")).toBeVisible();
  await expect.element(filter()).toHaveValue("removed");
  await page.getByRole("button", { name: "Show all projects" }).click();
  await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
  await expect.element(taskCard()).toBeVisible();
});

it("opens a conversation request in thread mode and clears it from the URL", async () => {
  const router = await setup(`/scheduled?threadId=${conversation}`);
  await expect.element(page.getByRole("dialog", { name: "New scheduled task" })).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Workspace" })).toHaveValue("thread");
  await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await active?.unmount();
  const next = await setup("/scheduled?projectId=project&threadId=missing");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That conversation is no longer available.");
  await vi.waitFor(() => expect(next.state.location.search).toEqual({ projectId: "project" }));
});

it("follows a task created in another project while filtered", async () => {
  mocks.create.mockResolvedValue({ warnings: [] });
  const router = await setup("/scheduled?projectId=project");
  await expect.element(taskCard()).toBeVisible();
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByRole("textbox", { name: "Task name" }).fill("Elsewhere");
  await page.getByTestId("composer-editor").fill("Check");
  await page.getByRole("combobox", { name: "Project" }).selectOptions("other");
  await expect.element(page.getByRole("textbox", { name: "Task name" })).toHaveValue("Elsewhere");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("button", { name: "Save task" }).click();
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: "other" }));
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ projectId: "other" }));
});

it("links bound tasks to their conversation and explains removed ones", async () => {
  mocks.list.mockResolvedValue({
    tasks: [
      {
        task: { ...task, workspace: { kind: "thread", threadId: conversation } },
        latestRun: null,
        activeRun: null,
      },
      {
        task: {
          ...task,
          id: "removed",
          name: "Removed check",
          enabled: false,
          disabledReason: "thread_unavailable",
          workspace: { kind: "thread", threadId: ThreadId.makeUnsafe("gone") },
        },
        latestRun: null,
        activeRun: null,
      },
    ],
    revision: 0,
  });
  const router = await setup("/scheduled");
  await expect.element(page.getByText("Conversation removed")).toBeVisible();
  await expect.element(page.getByText("Disabled:", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Release notes" }).click();
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/${conversation}`));
});

it("refetches the task list when the server reports a change", async () => {
  await setup("/scheduled");
  await expect.element(taskCard()).toBeVisible();
  const calls = mocks.list.mock.calls.length;
  mocks.list.mockResolvedValue({
    tasks: [{ task: { ...task, name: "Renamed check" }, latestRun: null, activeRun: null }],
    revision: 1,
  });
  expect(mocks.changed).toHaveLength(1);
  mocks.changed[0]!();
  await expect.element(page.getByRole("heading", { name: "Renamed check" })).toBeVisible();
  expect(mocks.list.mock.calls.length).toBeGreaterThan(calls);
});
