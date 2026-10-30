import "../../index.css";
import { emptyDiskSpaceStatus } from "../../test/emptyAppRpc";

import { ProjectId, ThreadId, type NativeApi } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useComposerFocusRequestStore } from "../../composerFocusRequestStore";
import { useStore } from "../../store";
import type { Project, Thread } from "../../types";
import { useWorkflowCreateDialogStore } from "../../workflowCreateDialogStore";
import { SidebarProvider } from "../ui/sidebar";
import { HomeMissionControl } from "./HomeMissionControl";
import { toastManager } from "../ui/toast";

const NOW_ISO = new Date().toISOString();
// Older than every thread so thread activity, not creation order, picks the
// default project.
const PROJECT_CREATED_AT = "2026-01-01T00:00:00.000Z";

const getProjectSettings = vi.fn(async () => {
  throw new Error("offline");
});
const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
const ensureScratch = vi.fn<NativeApi["projects"]["ensureScratch"]>();

function makeProject(id: string, name: string): Project {
  return {
    id: ProjectId.makeUnsafe(id),
    name,
    cwd: `/repo/${id}`,
    model: "gpt-5.4",
    createdAt: PROJECT_CREATED_AT,
    expanded: true,
    scripts: [],
    memories: [],
    skills: [],
  };
}

function makeThread(projectId: Project["id"], id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId,
    title: `Thread ${id}`,
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
    estimatedThinkingTokens: null,
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
    ...overrides,
  };
}

const PROJECT_A = makeProject("project-a", "Alpha");
const PROJECT_B = makeProject("project-b", "Beta");
const SCRATCH: Project = {
  ...makeProject("scratch", "No project"),
  kind: "scratch",
  cwd: "/state/scratch",
};

function scratchSuccess() {
  ensureScratch.mockImplementation(async () => {
    setTimeout(() =>
      useStore.setState((state) => ({
        projects: [...state.projects, SCRATCH],
      })),
    );
    return { projectId: SCRATCH.id };
  });
}

async function pickNoProject() {
  await page.getByRole("combobox", { name: "Project" }).click();
  await page.getByTestId("home-picker-no-project").click();
}

const APPROVAL_THREAD = makeThread(PROJECT_A.id, "thread-approval", {
  title: "Needs an approval",
  activities: [
    {
      id: "activity-approval" as never,
      tone: "approval",
      kind: "approval.requested",
      summary: "Needs approval",
      payload: { requestId: "request-1", requestKind: "command" },
      turnId: null,
      createdAt: NOW_ISO,
    },
  ],
});

const WORKING_THREAD = makeThread(PROJECT_B.id, "thread-working", {
  title: "Busy refactor",
  session: {
    provider: "codex",
    status: "running",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    orchestrationStatus: "running",
  },
});

const IDLE_THREAD = makeThread(PROJECT_A.id, "thread-idle", { title: "Quiet thread" });

function ThreadRouteStub() {
  const { threadId } = useParams({ strict: false }) as { threadId?: string };
  return <div data-testid="thread-route">{threadId}</div>;
}

function seedStores(threads: ReadonlyArray<Thread>) {
  useStore.setState({
    projects: [PROJECT_A, PROJECT_B],
    threads: [...threads],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    investigationWorkflows: [],
    threadsHydrated: true,
  });
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  useComposerFocusRequestStore.setState({ request: null });
  useWorkflowCreateDialogStore.setState({ projectId: null });
}

async function renderHome(threads: ReadonlyArray<Thread> = []) {
  seedStores(threads);
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
    component: HomeMissionControl,
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$threadId",
    component: ThreadRouteStub,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
  });
  const pushedPaths: string[] = [];
  const unsubscribe = router.history.subscribe(({ location }) => {
    pushedPaths.push(location.pathname);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("region", { name: "Home" })).toBeInTheDocument();
  return {
    router,
    pushedPaths,
    cleanup: async () => {
      unsubscribe();
      queryClient.clear();
      await screen.unmount();
    },
  };
}

describe("HomeMissionControl", () => {
  beforeAll(() => {
    window.nativeApi = {
      storage: {
        getDiskSpace: async () => emptyDiskSpaceStatus,
        onDiskSpaceUpdated: () => () => {},
      },
      server: { getProjectSettings },
      projects: { ensureScratch },
      orchestration: { dispatchCommand },
    } as unknown as NativeApi;
  });

  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    dispatchCommand.mockClear();
    ensureScratch.mockReset();
    getProjectSettings.mockReset();
    getProjectSettings.mockRejectedValue(new Error("offline"));
    vi.restoreAllMocks();
  });

  it("starts a project-free draft from Home with a project present", async () => {
    scratchSuccess();
    const view = await renderHome([IDLE_THREAD]);
    try {
      await pickNoProject();
      await expect.element(page.getByRole("button", { name: "New workflow" })).toBeDisabled();
      await page
        .getByRole("textbox", { name: "What should we work on?" })
        .fill("Research solar energy");
      await page.getByRole("button", { name: "Start" }).click();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="thread-route"]')).toBeTruthy(),
      );
      const draft = useComposerDraftStore.getState().getDraftThreadByProjectId(SCRATCH.id);
      expect(draft).toMatchObject({ envMode: "local", branch: null, worktreePath: null });
      expect(useComposerDraftStore.getState().draftsByThreadId[draft!.threadId]?.prompt).toBe(
        "Research solar energy",
      );
      expect(view.pushedPaths).toEqual([`/${draft!.threadId}`]);
      expect(ensureScratch).toHaveBeenCalledTimes(1);
      expect(dispatchCommand).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  it("keeps the text after scratch creation fails, then succeeds on retry with one toast", async () => {
    ensureScratch.mockRejectedValueOnce(new Error("scratch unavailable"));
    const toast = vi.spyOn(toastManager, "add");
    const view = await renderHome([IDLE_THREAD]);
    try {
      await pickNoProject();
      const input = page.getByRole("textbox", { name: "What should we work on?" });
      await input.fill("Keep my research");
      await page.getByRole("button", { name: "Start" }).click();
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Could not start a thread without a project",
            description: "scratch unavailable",
          }),
        ),
      );
      expect(toast).toHaveBeenCalledTimes(1);
      expect(view.pushedPaths).toEqual([]);
      await expect.element(input).toHaveValue("Keep my research");
      scratchSuccess();
      await page.getByRole("button", { name: "Start" }).click();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="thread-route"]')).toBeTruthy(),
      );
      expect(ensureScratch).toHaveBeenCalledTimes(2);
    } finally {
      await view.cleanup();
    }
  });

  it("keeps an unfinished scratch draft reusable without navigating or focusing after leaving Home", async () => {
    let finish!: (result: { projectId: ProjectId }) => void;
    ensureScratch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = await renderHome([IDLE_THREAD]);
    try {
      await pickNoProject();
      await page
        .getByRole("textbox", { name: "What should we work on?" })
        .fill("Do not steal focus");
      await page.getByRole("button", { name: "Start" }).click();
      await vi.waitFor(() => expect(ensureScratch).toHaveBeenCalledTimes(1));
      await view.router.navigate({ to: "/$threadId", params: { threadId: "elsewhere" } });
      finish({ projectId: SCRATCH.id });
      setTimeout(() => useStore.setState((state) => ({ projects: [...state.projects, SCRATCH] })));
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().getDraftThreadByProjectId(SCRATCH.id)).toBeTruthy(),
      );
      expect(view.pushedPaths).toEqual(["/elsewhere"]);
      expect(useComposerFocusRequestStore.getState().request).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it("orders the no-project search option after matching projects and supports keyboard selection", async () => {
    const view = await renderHome([IDLE_THREAD]);
    try {
      useStore.setState({
        projects: [PROJECT_A, PROJECT_B, makeProject("prometheus", "prometheus")],
      });
      await page.getByRole("combobox", { name: "Project" }).click();
      const search = page.getByRole("combobox", { name: "Search projects" });
      await expect.element(page.getByRole("option").first()).toHaveTextContent("No project");
      await search.fill("pro");
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("combobox", { name: "Project" }))
        .toHaveTextContent("prometheus");
      await page.getByRole("combobox", { name: "Project" }).click();
      await search.fill("scr");
      await expect.element(page.getByRole("option")).toHaveTextContent("No project");
      await search.fill("bet");
      expect(page.getByTestId("home-picker-no-project").all()).toHaveLength(0);
      await userEvent.keyboard("{Escape}");
    } finally {
      await view.cleanup();
    }
  });

  it("wraps to the first no-project option with ArrowDown and Enter in an empty search", async () => {
    const view = await renderHome([IDLE_THREAD]);
    try {
      await page.getByRole("combobox", { name: "Project", exact: true }).click();
      await page.getByRole("option", { name: "Beta", exact: true }).click();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="combobox-popup"]')).toBeNull(),
      );
      await page.getByRole("combobox", { name: "Project", exact: true }).click();
      await expect
        .element(page.getByRole("option", { name: "No project", exact: true }))
        .toBeVisible();
      (
        page
          .getByRole("combobox", { name: "Search projects", exact: true })
          .element() as HTMLElement
      ).focus();
      await expect
        .element(page.getByRole("option", { name: "Beta", exact: true }))
        .toHaveAttribute("data-highlighted");
      await userEvent.keyboard("{ArrowDown}");
      await expect
        .element(page.getByRole("option", { name: "No project", exact: true }))
        .toHaveAttribute("data-highlighted");
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("combobox", { name: "Project", exact: true }))
        .toHaveTextContent("No project");
    } finally {
      await view.cleanup();
    }
  });

  it("scrolls a long project list to the keyboard-highlighted option", async () => {
    const view = await renderHome([IDLE_THREAD]);
    try {
      useStore.setState({
        projects: [
          PROJECT_A,
          ...Array.from({ length: 16 }, (_, index) =>
            makeProject(`project-${index}`, `Project ${index}`),
          ),
        ],
      });
      await page.getByRole("combobox", { name: "Project", exact: true }).click();
      const search = page.getByRole("combobox", { name: "Search projects", exact: true });
      (search.element() as HTMLElement).focus();
      await expect
        .element(page.getByRole("option", { name: "Alpha", exact: true }))
        .toHaveAttribute("data-highlighted");
      for (let index = 0; index < 16; index += 1) await userEvent.keyboard("{ArrowDown}");
      const last = page.getByRole("option", { name: "Project 15", exact: true });
      await expect.element(last).toHaveAttribute("data-highlighted");
      await vi.waitFor(() => {
        const item = last.element().getBoundingClientRect();
        const viewport = last.element().closest('[data-slot="scroll-area-viewport"]')!;
        const bounds = viewport.getBoundingClientRect();
        expect(viewport.scrollTop).toBeGreaterThan(0);
        // scrollTop rounds fractional CSS pixels.
        expect(item.top).toBeGreaterThanOrEqual(bounds.top - 1);
        expect(item.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
      });
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("combobox", { name: "Project", exact: true }))
        .toHaveTextContent("Project 15");
    } finally {
      await view.cleanup();
    }
  });

  it("defaults to the most recent visible context while preserving an explicit choice", async () => {
    const view = await renderHome([IDLE_THREAD]);
    try {
      useStore.setState({
        projects: [PROJECT_A, PROJECT_B, SCRATCH],
        threads: [
          IDLE_THREAD,
          makeThread(SCRATCH.id, "research", { lastInteractionAt: "2099-01-01T00:00:00Z" }),
        ],
      });
      await expect
        .element(page.getByRole("combobox", { name: "Project" }))
        .toHaveTextContent("No project");
      await page.getByRole("combobox", { name: "Project" }).click();
      await page.getByRole("option", { name: "Alpha", exact: true }).click();
      useStore.setState({ threads: [IDLE_THREAD] });
      await expect
        .element(page.getByRole("combobox", { name: "Project" }))
        .toHaveTextContent("Alpha");
      useStore.setState({ projects: [PROJECT_B, SCRATCH] });
      await expect
        .element(page.getByRole("combobox", { name: "Project" }))
        .toHaveTextContent("No project");
      useStore.setState({ projects: [], threads: [] });
      await expect
        .element(page.getByRole("combobox", { name: "Project" }))
        .toHaveTextContent("No project");
      await expect.element(page.getByRole("button", { name: "Start" })).toBeEnabled();
    } finally {
      await view.cleanup();
    }
  });

  it("leads with a greeting and the quick-start card, without the old stat strip", async () => {
    const view = await renderHome([IDLE_THREAD]);
    try {
      await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent(/^Good /);
      await expect.element(page.getByRole("form", { name: "Quick start" })).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("F5 Home");
      await expect
        .element(page.getByRole("combobox", { name: "Project" }))
        .toHaveTextContent("Alpha");
    } finally {
      await view.cleanup();
    }
  });

  it("starts a thread with the typed text prefilled and focused, without sending", async () => {
    const view = await renderHome([IDLE_THREAD]);
    try {
      await page
        .getByRole("textbox", { name: "What should we work on?" })
        .fill("Fix the login bug");
      await page.getByRole("button", { name: "Start" }).click();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="thread-route"]')).toBeTruthy();
      });
      const threadId = document.querySelector('[data-testid="thread-route"]')?.textContent ?? "";
      expect(view.pushedPaths).toEqual([`/${threadId}`]);
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId as ThreadId]?.prompt).toBe(
        "Fix the login bug",
      );
      expect(useComposerFocusRequestStore.getState().request?.threadId).toBe(threadId);
      expect(dispatchCommand).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  it("appends to an existing project draft without dropping its mentions", async () => {
    const view = await renderHome([IDLE_THREAD]);
    const draftThreadId = ThreadId.makeUnsafe("draft-existing");
    const draftStore = useComposerDraftStore.getState();
    draftStore.setProjectDraftThreadId(PROJECT_A.id, draftThreadId, {
      envMode: "local",
      worktreePath: null,
      branch: null,
      createdAt: NOW_ISO,
    });
    draftStore.setPrompt(draftThreadId, "@src/app.ts ", [
      { id: "mention-1", path: "src/app.ts", start: 0, end: 11 },
    ]);
    try {
      await page.getByRole("textbox", { name: "What should we work on?" }).fill("and add tests");
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="thread-route"]')?.textContent).toBe(
          draftThreadId,
        );
      });
      const draft = useComposerDraftStore.getState().draftsByThreadId[draftThreadId];
      expect(draft?.prompt).toBe("@src/app.ts \nand add tests");
      expect(draft?.mentions).toEqual([{ id: "mention-1", path: "src/app.ts", start: 0, end: 11 }]);
      expect(view.pushedPaths).toEqual([`/${draftThreadId}`]);
      expect(dispatchCommand).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  it("searches the project picker and starts work in the chosen project", async () => {
    const view = await renderHome([IDLE_THREAD]);
    try {
      await page.getByRole("combobox", { name: "Project" }).click();
      await page.getByRole("combobox", { name: "Search projects" }).fill("bet");
      await expect.element(page.getByRole("option", { name: "Beta" })).toBeVisible();
      expect(page.getByRole("option", { name: "Alpha" }).all()).toHaveLength(0);
      await page.getByRole("combobox", { name: "Search projects" }).fill("zzz");
      await expect.element(page.getByText("No matching projects.")).toBeVisible();
      await page.getByRole("combobox", { name: "Search projects" }).fill("bet");
      await page.getByRole("option", { name: "Beta" }).click();
      await expect
        .element(page.getByRole("combobox", { name: "Project" }))
        .toHaveTextContent("Beta");
      await page.getByRole("button", { name: "New workflow" }).click();
      expect(useWorkflowCreateDialogStore.getState().projectId).toBe(PROJECT_B.id);
    } finally {
      await view.cleanup();
    }
  });

  it("opens the workflow dialog for the selected project", async () => {
    const view = await renderHome([IDLE_THREAD]);
    try {
      await page.getByRole("button", { name: "New workflow" }).click();
      expect(useWorkflowCreateDialogStore.getState().projectId).toBe(PROJECT_A.id);
    } finally {
      await view.cleanup();
    }
  });

  it("groups threads into Needs you cards, Working rows and Recent rows", async () => {
    const view = await renderHome([APPROVAL_THREAD, WORKING_THREAD, IDLE_THREAD]);
    try {
      const needsYou = page.getByRole("region", { name: "Needs you" });
      await expect.element(needsYou).toBeInTheDocument();
      const card = document.querySelector<HTMLElement>('[data-slot="home-attention-card"]');
      expect(card?.dataset.status).toBe("pending-approval");
      await expect
        .element(needsYou.getByRole("button", { name: "Review approval" }))
        .toBeInTheDocument();

      await expect
        .element(page.getByRole("region", { name: "Working" }).getByText("Busy refactor"))
        .toBeInTheDocument();
      const recent = page.getByRole("region", { name: "Recent" });
      await expect.element(recent.getByText("Quiet thread")).toBeInTheDocument();
      // Idle rows carry no status chip.
      expect(recent.element().textContent).not.toContain("Idle");
    } finally {
      await view.cleanup();
    }
  });

  it("shows the full Needs you count and expands past the first eight cards", async () => {
    const approvals = Array.from({ length: 10 }, (_, index) =>
      makeThread(PROJECT_A.id, `thread-approval-${index}`, {
        title: `Approval ${index}`,
        activities: APPROVAL_THREAD.activities,
      }),
    );
    const view = await renderHome(approvals);
    try {
      const cards = () => document.querySelectorAll('[data-slot="home-attention-card"]').length;
      const needsYou = page.getByRole("region", { name: "Needs you" });
      await vi.waitFor(() => expect(cards()).toBe(8));
      await expect.element(needsYou.getByRole("heading", { level: 2 })).toHaveTextContent("10");

      await needsYou.getByRole("button", { name: /Show more/ }).click();
      await vi.waitFor(() => expect(cards()).toBe(10));
      await needsYou.getByRole("button", { name: /Show less/ }).click();
      await vi.waitFor(() => expect(cards()).toBe(8));
    } finally {
      await view.cleanup();
    }
  });

  it("moves focus through cards and rows with j and k", async () => {
    const view = await renderHome([APPROVAL_THREAD, WORKING_THREAD, IDLE_THREAD]);
    try {
      const rows = () =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-home-row-index]"));
      await vi.waitFor(() => expect(rows().length).toBe(3));
      (document.activeElement as HTMLElement | null)?.blur();

      await userEvent.keyboard("j");
      expect(document.activeElement).toBe(rows()[0]);
      await userEvent.keyboard("j");
      expect(document.activeElement).toBe(rows()[1]);
      await userEvent.keyboard("k");
      expect(document.activeElement).toBe(rows()[0]);
    } finally {
      await view.cleanup();
    }
  });

  it("deep-links a Needs you card into its thread and requests composer focus", async () => {
    const view = await renderHome([APPROVAL_THREAD]);
    try {
      await page.getByRole("button", { name: "Review approval" }).click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="thread-route"]')?.textContent).toBe(
          APPROVAL_THREAD.id,
        );
      });
      expect(useComposerFocusRequestStore.getState().request?.threadId).toBe(APPROVAL_THREAD.id);
      expect(dispatchCommand).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });
});
