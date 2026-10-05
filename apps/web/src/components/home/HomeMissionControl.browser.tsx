import "../../index.css";

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

const NOW_ISO = new Date().toISOString();
// Older than every thread so thread activity, not creation order, picks the
// default project.
const PROJECT_CREATED_AT = "2026-01-01T00:00:00.000Z";

const getProjectSettings = vi.fn(async () => {
  throw new Error("offline");
});
const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));

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
      server: { getProjectSettings },
      orchestration: { dispatchCommand },
    } as unknown as NativeApi;
  });

  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    dispatchCommand.mockClear();
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
