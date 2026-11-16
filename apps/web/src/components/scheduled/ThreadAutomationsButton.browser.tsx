import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { ProjectId, ThreadId, type ScheduledTask } from "@t3tools/contracts";
import { ThreadAutomationsButton } from "./ThreadAutomationsButton";

const mocks = vi.hoisted(() => ({ list: vi.fn(), setEnabled: vi.fn(), runNow: vi.fn() }));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    scheduledTasks: { list: mocks.list, setEnabled: mocks.setEnabled, runNow: mocks.runNow },
  }),
}));

const conversation = ThreadId.makeUnsafe("conversation");
const task = (id: string, overrides: Partial<Record<keyof ScheduledTask, unknown>> = {}) =>
  ({
    id,
    projectId: ProjectId.makeUnsafe("project"),
    name: `Task ${id}`,
    prompt: "Check",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspace: { kind: "thread", threadId: conversation },
    cron: "0 9 * * *",
    timezone: "UTC",
    scheduleSource: "0 9 * * *",
    maxRuns: null,
    oneShotAt: null,
    notify: "all",
    enabled: true,
    version: 2,
    createdBy: "user",
    authority: { kind: "user" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    nextRunAt: "2099-01-01T09:00:00.000Z",
    lastRunAt: null,
    runsConsumed: 0,
    ...overrides,
  }) as ScheduledTask;

let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.setEnabled.mockResolvedValue(undefined);
  mocks.runNow.mockResolvedValue(undefined);
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});
async function setup(tasks: ScheduledTask[]) {
  mocks.list.mockResolvedValue({
    tasks: tasks.map((entry) => ({ task: entry, latestRun: null, activeRun: null })),
    revision: 0,
  });
  const rootRoute = createRootRoute({
    component: () => <ThreadAutomationsButton threadId={conversation} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/scheduled",
        validateSearch: (search: Record<string, unknown>) => search,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  active = await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

it("lists only this conversation's automations and manages them in place", async () => {
  const router = await setup([
    task("bound"),
    task("other-thread", {
      workspace: { kind: "thread", threadId: ThreadId.makeUnsafe("elsewhere") },
    }),
    task("unbound", { workspace: { kind: "projectRoot" } }),
  ]);
  await page.getByRole("button", { name: "Automations: 1 automation" }).click();
  await expect.element(page.getByText("Task bound", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Task bound", { exact: true }))
    .toHaveAttribute("title", "Task bound · At 09:00 AM (UTC)");
  await expect.element(page.getByText("Task other-thread")).not.toBeInTheDocument();
  await expect.element(page.getByText("Task unbound")).not.toBeInTheDocument();
  await page.getByRole("switch", { name: "Enable Task bound" }).click();
  await vi.waitFor(() =>
    expect(mocks.setEnabled).toHaveBeenCalledWith({
      id: "bound",
      expectedVersion: 2,
      enabled: false,
    }),
  );
  await page.getByRole("button", { name: "Run now" }).click();
  await vi.waitFor(() =>
    expect(mocks.runNow).toHaveBeenCalledWith(expect.objectContaining({ taskId: "bound" })),
  );
  await page.getByRole("button", { name: "Manage" }).click();
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe("/scheduled");
    expect(router.state.location.search).toEqual({ taskId: "bound" });
  });
});

it("shows paused tasks and renders nothing without automations", async () => {
  await setup([task("paused", { enabled: false })]);
  await page.getByRole("button", { name: "Automations: 1 automation" }).click();
  await expect.element(page.getByText("At 09:00 AM (UTC) · Paused")).toBeVisible();
  await active?.unmount();
  await setup([task("unbound", { workspace: { kind: "projectRoot" } })]);
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalled());
  await expect.element(page.getByRole("button", { name: /^Automations/ })).not.toBeInTheDocument();
});
