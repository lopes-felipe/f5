import "../../index.css";
import { emptyDiskSpaceStatus } from "../../test/emptyAppRpc";

import {
  type DiskSpaceStatus,
  type NativeApi,
  type OrchestrationThreadPeeks,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useComposerFocusRequestStore } from "../../composerFocusRequestStore";
import { resetThreadRepliesForTests } from "../../lib/sendThreadReply";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { useStore } from "../../store";
import type { Project, Thread } from "../../types";
import { useWorkflowCreateDialogStore } from "../../workflowCreateDialogStore";
import {
  noteWsConnectionOpened,
  noteWsSynchronized,
  resetWsConnectionStateForTests,
} from "../../wsConnectionState";
import { SidebarProvider } from "../ui/sidebar";
import { resetHomeInlineStoreForTests } from "./homeInlineStore";
import { HomeMissionControl } from "./HomeMissionControl";
import { useHomeSelectionStore } from "./homeSelectionStore";
import { toastManager } from "../ui/toast";

// The preview loads after the queue. A test holds it back to press keys before it is there.
const previewGate = vi.hoisted(() => ({ pending: null as Promise<void> | null }));
vi.mock("./HomePreviewPane", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./HomePreviewPane")>();
  const { createElement, use } = await import("react");
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      if (previewGate.pending) use(previewGate.pending);
      return createElement(actual.default, props);
    },
  };
});

function holdPreview(): () => void {
  let release!: () => void;
  previewGate.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    previewGate.pending = null;
    release();
  };
}

const NOW_ISO = new Date().toISOString();
// Older than every thread so thread activity, not creation order, picks the
// default project.
const PROJECT_CREATED_AT = "2026-01-01T00:00:00.000Z";

const getProjectSettings = vi.fn(async () => {
  throw new Error("offline");
});
const dispatchCommand = vi.fn(async (_command: { type: string; threadId?: string }) => ({
  sequence: 1,
}));
const ensureScratch = vi.fn<NativeApi["projects"]["ensureScratch"]>();
const getThreadPeeks = vi.fn(
  async (_input: { threadIds: ReadonlyArray<string> }): Promise<OrchestrationThreadPeeks> => ({
    peeks: [],
  }),
);
interface TailDetailsFixture {
  readonly threadId: string;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly turnId: string | null;
    readonly streaming: boolean;
  }>;
  readonly checkpoints: ReadonlyArray<never>;
  readonly tasks: ReadonlyArray<never>;
  /** Left out, the pending requests cannot be read, as when the server is slow. */
  readonly activities?: Thread["activities"];
}
const emptyTailDetails = async (input: { threadId: string }): Promise<TailDetailsFixture> => ({
  threadId: input.threadId,
  messages: [],
  checkpoints: [],
  tasks: [],
});
const getThreadTailDetails = vi.fn(emptyTailDetails);
const getPrHubOverview = vi.fn(async () => ({ counts: { needs_you: 0 } }));
const getDiskSpace = vi.fn(async (): Promise<DiskSpaceStatus> => emptyDiskSpaceStatus);

type TurnSubmission = Parameters<NativeApi["nextTurnQueue"]["submit"]>[0];
type TurnSubmissionOutcome = Awaited<ReturnType<NativeApi["nextTurnQueue"]["submit"]>>;
const startedTurn = async (input: TurnSubmission): Promise<TurnSubmissionOutcome> =>
  ({ submissionId: input.submissionId, disposition: "started", sequence: 1 }) as never;
const submitTurn = vi.fn(startedTurn);
function queueSnapshot(threadId: string, overrides: object = {}) {
  return {
    threadId,
    items: [],
    revision: 7,
    paused: true,
    blockedKind: null,
    reasonCode: null,
    reasonDetail: null,
    maxItems: 20,
    quarantinedCount: 0,
    ...overrides,
  };
}
const listQueue = vi.fn(async (input: { threadId: string }) => queueSnapshot(input.threadId));
const resumedQueue = async (input: {
  threadId: string;
  paused: boolean;
  expectedRevision: number;
}) => queueSnapshot(input.threadId, { paused: input.paused, revision: input.expectedRevision + 1 });
const setQueuePaused = vi.fn(resumedQueue);
const noPausedQueues = async () => ({ threads: [] as ReadonlyArray<object> });
const queueSummary = vi.fn(noPausedQueues);
const listBranches = vi.fn(async (_input: { cwd: string }) => ({
  isRepo: true,
  branches: [{ name: "main", current: true }],
}));

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
  await page.getByTestId("project-picker-no-project").click();
}

function approvalActivity(requestId: string, payload: object = {}): Thread["activities"][number] {
  return {
    id: `activity-${requestId}` as never,
    tone: "approval",
    kind: "approval.requested",
    summary: "Needs approval",
    payload: {
      requestId,
      requestKind: "command",
      detail: "git push --force-with-lease",
      ...payload,
    },
    turnId: null,
    createdAt: NOW_ISO,
  };
}

const APPROVAL_THREAD = makeThread(PROJECT_A.id, "thread-approval", {
  title: "Needs an approval",
  activities: [approvalActivity("request-1")],
});

function endedTurn(id: string, state: "completed" | "error"): NonNullable<Thread["latestTurn"]> {
  return {
    turnId: `${id}-turn` as never,
    state,
    assistantMessageId: null,
    requestedAt: NOW_ISO,
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
  };
}

// Neither thread was visited since its turn ended, so both are unseen.
const FAILED_THREAD = makeThread(PROJECT_A.id, "thread-failed", {
  title: "Broken build",
  latestTurn: endedTurn("thread-failed", "error"),
  error: "Usage limit reached\nTry again after 6 pm.",
});

const DONE_THREAD = makeThread(PROJECT_B.id, "thread-done", {
  title: "Finished refactor",
  latestTurn: endedTurn("thread-done", "completed"),
});

/** Row titles in reading order, within `root`. */
function rowTitles(root: Element): Array<string | null> {
  return Array.from(root.querySelectorAll('[role="option"]'), (row) =>
    row.getAttribute("aria-label"),
  );
}

function selectedTitle(): string | null {
  return (
    document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("aria-label") ??
    null
  );
}

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
        getDiskSpace: () => getDiskSpace(),
        onDiskSpaceUpdated: () => () => {},
      },
      server: { getProjectSettings },
      projects: { ensureScratch },
      orchestration: { dispatchCommand, getThreadPeeks, getThreadTailDetails },
      prHub: { getOverview: () => getPrHubOverview(), onChanged: () => () => {} },
      scheduledTasks: { list: async () => ({ revision: 0, tasks: [] }) },
      nextTurnQueue: {
        submit: submitTurn,
        list: listQueue,
        setPaused: setQueuePaused,
        summary: () => queueSummary(),
      },
      git: { listBranches },
    } as unknown as NativeApi;
  });

  // Wide enough for the queue and the preview side by side; one test narrows it. The server
  // is reachable, or Home refuses to act.
  beforeEach(async () => {
    await page.viewport(1280, 800);
    noteWsConnectionOpened();
    noteWsSynchronized();
  });

  afterEach(() => {
    previewGate.pending = null;
    resetWsConnectionStateForTests();
    submitTurn.mockClear();
    submitTurn.mockImplementation(startedTurn);
    listQueue.mockClear();
    setQueuePaused.mockClear();
    listBranches.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
    dispatchCommand.mockClear();
    ensureScratch.mockReset();
    getProjectSettings.mockReset();
    getProjectSettings.mockRejectedValue(new Error("offline"));
    getThreadPeeks.mockClear();
    getThreadPeeks.mockImplementation(async () => ({ peeks: [] }));
    getThreadTailDetails.mockClear();
    getThreadTailDetails.mockImplementation(emptyTailDetails);
    getPrHubOverview.mockImplementation(async () => ({ counts: { needs_you: 0 } }));
    getDiskSpace.mockImplementation(async () => emptyDiskSpaceStatus);
    useHomeSelectionStore.setState({ selectedId: null, itemIds: [] });
    // A resumed queue leaves its snapshot behind, which outranks the next test's summary.
    useNextTurnQueueStore.setState({ summary: { threads: [] }, byThreadId: {} });
    resetHomeInlineStoreForTests();
    resetThreadRepliesForTests();
    dispatchCommand.mockImplementation(async () => ({ sequence: 1 }));
    setQueuePaused.mockImplementation(resumedQueue);
    listQueue.mockImplementation(async (input) => queueSnapshot(input.threadId));
    queueSummary.mockImplementation(noPausedQueues);
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
      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getDraftThreadByProjectId(SCRATCH.id);
        expect(draft).toBeTruthy();
        expect(useComposerDraftStore.getState().draftsByThreadId[draft!.threadId]?.prompt).toBe(
          "Do not steal focus",
        );
      });
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
      expect(page.getByTestId("project-picker-no-project").all()).toHaveLength(0);
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

  it("leads with the quick-start bar and says so when nothing needs the user", async () => {
    const view = await renderHome([IDLE_THREAD]);
    try {
      await expect.element(page.getByRole("form", { name: "Quick start" })).toBeInTheDocument();
      await expect
        .element(page.getByRole("combobox", { name: "Project" }))
        .toHaveTextContent("Alpha");
      // No greeting, and an idle thread is not queue material.
      expect(page.getByRole("heading", { level: 1 }).all()).toHaveLength(0);
      await expect.element(page.getByText("Nothing needs you")).toBeInTheDocument();
      expect(page.getByRole("listbox", { name: "Queue" }).all()).toHaveLength(0);
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

  describe("triage queue", () => {
    const QUEUE_THREADS = [
      APPROVAL_THREAD,
      FAILED_THREAD,
      DONE_THREAD,
      WORKING_THREAD,
      IDLE_THREAD,
    ];

    it("groups threads by what they need and describes each row", async () => {
      getThreadPeeks.mockImplementation(async ({ threadIds }) => ({
        peeks: threadIds.map((threadId) => ({
          threadId: ThreadId.makeUnsafe(threadId),
          lastUserText: `Prompt for ${threadId}`,
          lastAssistantText: `**Reply** for ${threadId}`,
          latestTurnDiff:
            threadId === DONE_THREAD.id ? { files: 3, additions: 48, deletions: 12 } : null,
        })),
      }));
      const view = await renderHome(QUEUE_THREADS);
      try {
        const queue = page.getByRole("listbox", { name: "Queue" });
        const group = (name: string) => queue.getByRole("group", { name });
        await expect
          .element(group("Needs a decision").getByRole("option", { name: "Needs an approval" }))
          .toHaveTextContent("git push --force-with-lease");
        // The unseen failure comes before the unread completion.
        await vi.waitFor(() =>
          expect(rowTitles(group("Ready for review").element())).toEqual([
            "Broken build",
            "Finished refactor",
          ]),
        );
        await expect
          .element(queue.getByRole("option", { name: "Broken build" }))
          .toHaveTextContent("Usage limit reached");
        await expect
          .element(queue.getByRole("option", { name: "Finished refactor" }))
          .toHaveTextContent(`Reply for ${DONE_THREAD.id} · 3 files +48 −12`);
        await expect
          .element(group("Running").getByRole("option", { name: "Busy refactor" }))
          .toHaveTextContent(`Prompt for ${WORKING_THREAD.id}`);
        // Idle threads stay in the sidebar.
        expect(queue.getByRole("option", { name: "Quiet thread" }).all()).toHaveLength(0);
        // One request covers every row.
        expect(getThreadPeeks).toHaveBeenCalledTimes(1);
        expect(getThreadPeeks.mock.calls[0]![0].threadIds).toHaveLength(4);
      } finally {
        await view.cleanup();
      }
    });

    it("selects the first item, shows its context and moves with the keyboard", async () => {
      const view = await renderHome(QUEUE_THREADS);
      try {
        const queue = page.getByRole("listbox", { name: "Queue" });
        await expect.element(queue).toHaveFocus();
        await expect.poll(selectedTitle).toBe("Needs an approval");
        const preview = page.getByRole("article", { name: "Needs an approval" });
        await expect.element(preview).toHaveTextContent("Command approval requested");
        await expect.element(preview).toHaveTextContent("git push --force-with-lease");

        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Broken build");
        await expect
          .element(page.getByRole("article", { name: "Broken build" }))
          .toHaveTextContent("Usage limit reached");
        await userEvent.keyboard("{ArrowDown}");
        await expect.poll(selectedTitle).toBe("Finished refactor");
        await userEvent.keyboard("k");
        await expect.poll(selectedTitle).toBe("Broken build");
        await userEvent.keyboard("{End}");
        await expect.poll(selectedTitle).toBe("Busy refactor");
        // The ends stop instead of wrapping.
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Busy refactor");
        await userEvent.keyboard("{Home}");
        await expect.poll(selectedTitle).toBe("Needs an approval");
        expect(dispatchCommand).not.toHaveBeenCalled();
      } finally {
        await view.cleanup();
      }
    });

    it("keeps the selection across a visit to a thread and when the queue reorders", async () => {
      const view = await renderHome(QUEUE_THREADS);
      try {
        await page.getByRole("option", { name: "Finished refactor" }).click();
        await expect.poll(selectedTitle).toBe("Finished refactor");
        // New activity moves another thread to the top of its group.
        useStore.setState((state) => ({
          threads: [
            ...state.threads,
            makeThread(PROJECT_A.id, "thread-approval-2", {
              title: "Second approval",
              activities: APPROVAL_THREAD.activities,
              lastInteractionAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          ],
        }));
        await expect
          .element(page.getByRole("option", { name: "Second approval" }))
          .toBeInTheDocument();
        await expect.poll(selectedTitle).toBe("Finished refactor");

        await view.router.navigate({ to: "/$threadId", params: { threadId: IDLE_THREAD.id } });
        await view.router.navigate({ to: "/" });
        await expect.poll(selectedTitle).toBe("Finished refactor");
      } finally {
        await view.cleanup();
      }
    });

    it("carries on at the next item when the opened thread has left the queue", async () => {
      const view = await renderHome(QUEUE_THREADS);
      try {
        await page.getByRole("option", { name: "Broken build" }).click();
        await userEvent.keyboard("o");
        await vi.waitFor(() =>
          expect(document.querySelector('[data-testid="thread-route"]')?.textContent).toBe(
            FAILED_THREAD.id,
          ),
        );
        // Seeing the failure clears it.
        useStore.setState((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === FAILED_THREAD.id
              ? { ...thread, lastVisitedAt: new Date(Date.now() + 60_000).toISOString() }
              : thread,
          ),
        }));
        await view.router.navigate({ to: "/" });
        await expect.poll(selectedTitle).toBe("Finished refactor");
        expect(page.getByRole("option", { name: "Broken build" }).all()).toHaveLength(0);
      } finally {
        await view.cleanup();
      }
    });

    it("opens the selected thread with O, Enter, a double click or the button", async () => {
      const view = await renderHome(QUEUE_THREADS);
      const expectRoute = (threadId: string) =>
        vi.waitFor(() =>
          expect(document.querySelector('[data-testid="thread-route"]')?.textContent).toBe(
            threadId,
          ),
        );
      const home = () => view.router.navigate({ to: "/" });
      try {
        await expect.element(page.getByRole("listbox", { name: "Queue" })).toHaveFocus();
        await userEvent.keyboard("o");
        await expectRoute(APPROVAL_THREAD.id);
        // A decision is answered in the composer, so opening it hands the composer focus.
        expect(useComposerFocusRequestStore.getState().request?.threadId).toBe(APPROVAL_THREAD.id);

        await home();
        useComposerFocusRequestStore.setState({ request: null });
        await page.getByRole("option", { name: "Finished refactor" }).click();
        await userEvent.keyboard("{Enter}");
        await expectRoute(DONE_THREAD.id);
        expect(useComposerFocusRequestStore.getState().request).toBeNull();

        await home();
        await userEvent.dblClick(page.getByRole("option", { name: "Busy refactor" }));
        await expectRoute(WORKING_THREAD.id);

        await home();
        await page.getByRole("option", { name: "Broken build" }).click();
        await page.getByRole("button", { name: /Open thread/ }).click();
        await expectRoute(FAILED_THREAD.id);
        expect(dispatchCommand).not.toHaveBeenCalled();
      } finally {
        await view.cleanup();
      }
    });

    it("settles with E and carries on at the item that followed", async () => {
      const view = await renderHome(QUEUE_THREADS);
      try {
        await page.getByRole("option", { name: "Broken build" }).click();
        await userEvent.keyboard("e");
        await vi.waitFor(() =>
          expect(dispatchCommand).toHaveBeenCalledWith(
            expect.objectContaining({ type: "thread.settle", threadId: FAILED_THREAD.id }),
          ),
        );
        // The server's event settles the thread; it then leaves the queue.
        useStore.setState((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === FAILED_THREAD.id ? { ...thread, settledAt: NOW_ISO } : thread,
          ),
        }));
        await expect.poll(selectedTitle).toBe("Finished refactor");
        expect(page.getByRole("option", { name: "Broken build" }).all()).toHaveLength(0);
        // Focus stays in Home, so the next key still works.
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Busy refactor");
      } finally {
        await view.cleanup();
      }
    });

    it("pins with P and offers the snooze times with H", async () => {
      const view = await renderHome(QUEUE_THREADS);
      try {
        await page.getByRole("option", { name: "Finished refactor" }).click();
        await userEvent.keyboard("p");
        await vi.waitFor(() =>
          expect(dispatchCommand).toHaveBeenCalledWith(
            expect.objectContaining({ type: "thread.pins.replace" }),
          ),
        );
        dispatchCommand.mockClear();

        await userEvent.keyboard("h");
        const tomorrow = page.getByRole("menuitem", { name: /Tomorrow/ });
        await expect.element(tomorrow).toBeVisible();
        // Keys pressed in the menu are the menu's: J must not move the queue under it.
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Finished refactor");
        await tomorrow.click();
        await vi.waitFor(() =>
          expect(dispatchCommand).toHaveBeenCalledWith(
            expect.objectContaining({ type: "thread.snooze", threadId: DONE_THREAD.id }),
          ),
        );
      } finally {
        await view.cleanup();
      }
    });

    it("leaves its keys alone while typing, and focuses the quick start with /", async () => {
      const view = await renderHome(QUEUE_THREADS);
      try {
        await expect.element(page.getByRole("listbox", { name: "Queue" })).toHaveFocus();
        await userEvent.keyboard("/");
        const input = page.getByRole("textbox", { name: "What should we work on?" });
        await expect.element(input).toHaveFocus();
        // The slash itself is not typed.
        await expect.element(input).toHaveValue("");

        await userEvent.keyboard("jeep");
        await expect.element(input).toHaveValue("jeep");
        await expect.poll(selectedTitle).toBe("Needs an approval");
        expect(dispatchCommand).not.toHaveBeenCalled();
        expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();
      } finally {
        await view.cleanup();
      }
    });

    it("ignores its keys when focus is outside Home", async () => {
      const view = await renderHome(QUEUE_THREADS);
      const outside = document.createElement("button");
      outside.textContent = "Elsewhere";
      document.body.append(outside);
      try {
        await expect.poll(selectedTitle).toBe("Needs an approval");
        outside.focus();
        await userEvent.keyboard("jeo");
        await expect.poll(selectedTitle).toBe("Needs an approval");
        expect(dispatchCommand).not.toHaveBeenCalled();
        expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();
      } finally {
        outside.remove();
        await view.cleanup();
      }
    });

    it("shows the reply in full once the thread's tail is read", async () => {
      getThreadTailDetails.mockImplementation(async ({ threadId }) => ({
        threadId,
        messages: [
          { id: "m1", role: "user", text: "Refactor the queue", turnId: "t1", streaming: false },
          {
            id: "m2",
            role: "assistant",
            text: "Done.\n\n- Split the store\n- Added tests",
            turnId: "t1",
            streaming: false,
          },
        ],
        checkpoints: [],
        tasks: [],
      }));
      const view = await renderHome(QUEUE_THREADS);
      try {
        await page.getByRole("option", { name: "Finished refactor" }).click();
        const preview = page.getByRole("article", { name: "Finished refactor" });
        await expect.element(preview.getByText("Refactor the queue")).toBeVisible();
        await expect
          .element(preview.getByRole("listitem").first())
          .toHaveTextContent("Split the store");
        // Previewing a thread does not load it into the store.
        expect(
          useStore.getState().threads.find((t) => t.id === DONE_THREAD.id)?.detailsLoaded,
        ).toBe(false);
      } finally {
        await view.cleanup();
      }
    });

    it("lists a thread whose queue is paused and a pinned thread once", async () => {
      useNextTurnQueueStore.setState({
        summary: {
          threads: [
            {
              threadId: IDLE_THREAD.id,
              queuedCount: 2,
              dispatchingCount: 0,
              failedCount: 0,
              scheduledResumeAt: null,
              paused: true,
            },
          ],
        },
      });
      const pinned = makeThread(PROJECT_B.id, "thread-pinned", {
        title: "Release checklist",
        pinnedAt: NOW_ISO,
        pinOrderKey: 1,
      });
      const pinnedApproval = { ...APPROVAL_THREAD, pinnedAt: NOW_ISO, pinOrderKey: 2 };
      const view = await renderHome([pinnedApproval, IDLE_THREAD, pinned]);
      try {
        const queue = page.getByRole("listbox", { name: "Queue" });
        await vi.waitFor(() =>
          expect(rowTitles(queue.element())).toEqual([
            "Needs an approval",
            "Quiet thread",
            "Release checklist",
          ]),
        );
        await expect
          .element(queue.getByRole("group", { name: "Pinned" }).getByRole("option"))
          .toHaveAccessibleName("Release checklist");
        await page.getByRole("option", { name: "Quiet thread" }).click();
        await expect
          .element(page.getByRole("article", { name: "Quiet thread" }))
          .toHaveTextContent("2 queued turns wait until the queue is resumed.");
        // A pinned thread cannot be settled.
        await page.getByRole("option", { name: "Release checklist" }).click();
        await expect.element(page.getByRole("button", { name: /Settle/ })).toBeDisabled();
        await userEvent.keyboard("e");
        expect(dispatchCommand).not.toHaveBeenCalled();
      } finally {
        await view.cleanup();
      }
    });

    it("takes turns between the queue and the preview in a narrow window", async () => {
      await page.viewport(600, 800);
      const view = await renderHome(QUEUE_THREADS);
      try {
        const queue = page.getByRole("listbox", { name: "Queue" });
        await expect.element(queue).toHaveFocus();
        expect(page.getByRole("article").all()).toHaveLength(0);

        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Broken build");
        await userEvent.keyboard("{Enter}");
        await expect.element(page.getByRole("article", { name: "Broken build" })).toBeVisible();
        expect(page.getByRole("listbox", { name: "Queue" }).all()).toHaveLength(0);
        expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();

        await page.getByRole("button", { name: "Back to queue" }).click();
        await expect.element(queue).toBeVisible();
        await page.getByRole("option", { name: "Finished refactor" }).click();
        await expect
          .element(page.getByRole("article", { name: "Finished refactor" }))
          .toBeVisible();
        await userEvent.keyboard("{Escape}");
        await expect.element(queue).toHaveFocus();
      } finally {
        await view.cleanup();
      }
    });

    it("keeps its keys while the preview stands alone in a narrow window", async () => {
      await page.viewport(600, 800);
      const view = await renderHome(QUEUE_THREADS);
      try {
        const queue = page.getByRole("listbox", { name: "Queue" });
        await expect.element(queue).toHaveFocus();
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Broken build");

        // Enter replaces the queue, which held focus, with the preview: the preview takes it.
        await userEvent.keyboard("{Enter}");
        await expect.element(page.getByRole("article", { name: "Broken build" })).toHaveFocus();
        await userEvent.keyboard("{Escape}");
        await expect.element(queue).toHaveFocus();
        await expect.poll(selectedTitle).toBe("Broken build");

        // J steps to the next item without going back to the queue.
        await userEvent.keyboard("{Enter}");
        await expect.element(page.getByRole("article", { name: "Broken build" })).toHaveFocus();
        await userEvent.keyboard("j");
        const done = page.getByRole("article", { name: "Finished refactor" });
        await expect.element(done).toHaveFocus();

        // Settling takes the focused button away with its item; the next preview has the keys.
        await done.getByRole("button", { name: /Settle/ }).click();
        await vi.waitFor(() =>
          expect(dispatchCommand).toHaveBeenCalledWith(
            expect.objectContaining({ type: "thread.settle", threadId: DONE_THREAD.id }),
          ),
        );
        useStore.setState((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === DONE_THREAD.id ? { ...thread, settledAt: NOW_ISO } : thread,
          ),
        }));
        await expect.element(page.getByRole("article", { name: "Busy refactor" })).toHaveFocus();
        await userEvent.keyboard("k");
        await expect.element(page.getByRole("article", { name: "Broken build" })).toHaveFocus();
        await userEvent.keyboard("{Escape}");
        await expect.element(queue).toHaveFocus();
        await expect.poll(selectedTitle).toBe("Broken build");
        expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();
      } finally {
        await view.cleanup();
      }
    });

    it("keeps J and K after a click in the preview, without giving it Enter or the arrows", async () => {
      const view = await renderHome(QUEUE_THREADS);
      try {
        await page.getByRole("option", { name: "Broken build" }).click();
        const preview = page.getByRole("article", { name: "Broken build" });
        // Reading: a click in the text, then on the pane's own header.
        for (const target of [
          preview.getByText("Usage limit reached"),
          preview.getByRole("heading", { name: "Broken build" }),
        ]) {
          await target.click();
          expect(preview.element().contains(document.activeElement)).toBe(true);
          await userEvent.keyboard("{Enter}");
          await userEvent.keyboard("{ArrowDown}");
          await userEvent.keyboard("{End}");
          await expect.poll(selectedTitle).toBe("Broken build");
          expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();
        }
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Finished refactor");
        await userEvent.keyboard("k");
        await expect.poll(selectedTitle).toBe("Broken build");
        expect(dispatchCommand).not.toHaveBeenCalled();
      } finally {
        await view.cleanup();
      }
    });

    it("does not offer to settle a thread the server would refuse", async () => {
      const view = await renderHome(QUEUE_THREADS);
      try {
        for (const [title, reason] of [
          ["Needs an approval", "Answer the approval to settle the thread"],
          ["Busy refactor", "A running thread cannot be settled"],
        ] as const) {
          await page.getByRole("option", { name: title }).click();
          const settle = page.getByRole("article", { name: title }).getByRole("button", {
            name: /Settle/,
          });
          await expect.element(settle).toBeDisabled();
          await expect.element(settle).toHaveAttribute("title", reason);
          await userEvent.keyboard("e");
        }
        // A finished thread still settles.
        await page.getByRole("option", { name: "Finished refactor" }).click();
        await userEvent.keyboard("e");
        await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(1));
        expect(dispatchCommand).toHaveBeenCalledWith(
          expect.objectContaining({ type: "thread.settle", threadId: DONE_THREAD.id }),
        );
      } finally {
        await view.cleanup();
      }
    });

    it("keeps running rows in place and reads no peeks again while their output streams", async () => {
      const runningTurn = (id: string, requestedAt: string): NonNullable<Thread["latestTurn"]> => ({
        turnId: `${id}-turn` as never,
        state: "running",
        assistantMessageId: null,
        requestedAt,
        startedAt: requestedAt,
        completedAt: null,
      });
      const older = {
        ...WORKING_THREAD,
        id: ThreadId.makeUnsafe("thread-stream-older"),
        title: "Older stream",
        latestTurn: runningTurn("thread-stream-older", "2026-03-09T09:00:00.000Z"),
        lastInteractionAt: "2026-03-09T09:00:00.000Z",
      };
      const newer = {
        ...WORKING_THREAD,
        id: ThreadId.makeUnsafe("thread-stream-newer"),
        title: "Newer stream",
        latestTurn: runningTurn("thread-stream-newer", "2026-03-09T10:00:00.000Z"),
        lastInteractionAt: "2026-03-09T10:00:00.000Z",
      };
      const earlierDone = {
        ...DONE_THREAD,
        id: ThreadId.makeUnsafe("thread-done-earlier"),
        title: "Earlier refactor",
        lastInteractionAt: "2026-03-09T08:00:00.000Z",
      };
      const view = await renderHome([older, newer, DONE_THREAD, earlierDone]);
      try {
        const queue = page.getByRole("listbox", { name: "Queue" });
        const rows = (name: string) => rowTitles(queue.getByRole("group", { name }).element());
        await vi.waitFor(() => expect(rows("Running")).toEqual(["Newer stream", "Older stream"]));
        await vi.waitFor(() => expect(getThreadPeeks).toHaveBeenCalledTimes(1));

        // Each streamed message moves its thread's activity past the other's.
        const touch = (threadId: string, at: string) =>
          useStore.setState((state) => ({
            threads: state.threads.map((thread) =>
              thread.id === threadId ? { ...thread, lastInteractionAt: at } : thread,
            ),
          }));
        touch(older.id, "2026-03-09T10:01:00.000Z");
        touch(newer.id, "2026-03-09T10:02:00.000Z");
        touch(older.id, "2026-03-09T10:03:00.000Z");
        // Rows that do trade places (review follows recency) read nothing either.
        touch(earlierDone.id, new Date(Date.now() + 60_000).toISOString());
        await vi.waitFor(() =>
          expect(rows("Ready for review")).toEqual(["Earlier refactor", "Finished refactor"]),
        );
        expect(rows("Running")).toEqual(["Newer stream", "Older stream"]);
        expect(getThreadPeeks).toHaveBeenCalledTimes(1);
      } finally {
        await view.cleanup();
      }
    });
  });

  describe("inline actions", () => {
    const approvalThread = (payload: object = {}, requestId = "request-1") =>
      makeThread(PROJECT_A.id, "thread-approval", {
        title: "Needs an approval",
        activities: [approvalActivity(requestId, payload)],
      });
    /** The server still waits on these requests. */
    const serverPending = (...activities: Thread["activities"]) =>
      getThreadTailDetails.mockImplementation(async (input) => ({
        ...(await emptyTailDetails(input)),
        activities,
      }));
    const approvalResponses = () =>
      dispatchCommand.mock.calls
        .map(([command]) => command)
        .filter((command) => command.type === "thread.approval.respond");
    const submittedCommand = (index = 0) => submitTurn.mock.calls[index]![0].command;
    const queue = () => page.getByRole("listbox", { name: "Queue" });
    const keyHints = () =>
      document.querySelector('[data-slot="home-key-hints"]')?.textContent ?? "";

    it("waits for the preview before Enter approves, then answers the request on screen", async () => {
      const thread = approvalThread();
      serverPending(...thread.activities);
      const showPreview = holdPreview();
      const view = await renderHome([thread, DONE_THREAD]);
      try {
        await expect.element(queue()).toHaveFocus();
        // The request is not on screen yet: Enter neither approves it nor opens the thread.
        await userEvent.keyboard("{Enter}");
        expect(page.getByRole("article").all()).toHaveLength(0);
        expect(dispatchCommand).not.toHaveBeenCalled();
        expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();

        showPreview();
        const preview = page.getByRole("article", { name: "Needs an approval" });
        await expect.element(preview).toHaveTextContent("git push --force-with-lease");
        await expect
          .element(preview.getByRole("button", { name: /Approve once/ }))
          .toHaveTextContent("↵");
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(approvalResponses()).toHaveLength(1));
        expect(approvalResponses()[0]).toMatchObject({
          threadId: thread.id,
          requestId: "request-1",
          decision: "accept",
        });
        await expect.element(preview.getByRole("status")).toHaveTextContent("Decision sent");
        expect(preview.getByRole("group", { name: "Approval" }).all()).toHaveLength(0);

        // Sent once: Enter has nothing left to act on, and the queue still has the keys.
        await expect.element(queue()).toHaveFocus();
        await userEvent.keyboard("{Enter}");
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Finished refactor");
        expect(approvalResponses()).toHaveLength(1);
        expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();
      } finally {
        await view.cleanup();
      }
    });

    it("offers each choice of the request and declines with D", async () => {
      const thread = approvalThread();
      const view = await renderHome([thread]);
      try {
        const choices = page.getByRole("group", { name: "Approval" });
        await expect.element(choices).toBeVisible();
        expect(
          Array.from(choices.element().querySelectorAll("button"), (button) =>
            button.textContent?.replace(/[↵D]$/, ""),
          ),
        ).toEqual(["Cancel turn", "Decline", "Always allow this session", "Approve once"]);
        await expect.element(queue()).toHaveFocus();
        await userEvent.keyboard("d");
        await vi.waitFor(() => expect(approvalResponses()).toHaveLength(1));
        expect(approvalResponses()[0]).toMatchObject({
          requestId: "request-1",
          decision: "decline",
        });
      } finally {
        await view.cleanup();
      }
    });

    it("answers the request that is shown when a click picks another choice", async () => {
      const thread = makeThread(PROJECT_A.id, "thread-approval", {
        title: "Needs an approval",
        activities: [
          approvalActivity("request-1"),
          {
            ...approvalActivity("request-2", { detail: "rm -rf build" }),
            createdAt: new Date(Date.now() + 1_000).toISOString(),
          },
        ],
      });
      const view = await renderHome([thread]);
      try {
        const preview = page.getByRole("article", { name: "Needs an approval" });
        await expect.element(preview).toHaveTextContent("1/2");
        await expect.element(preview).toHaveTextContent("git push --force-with-lease");
        await preview.getByRole("button", { name: "Always allow this session" }).click();
        await vi.waitFor(() => expect(approvalResponses()).toHaveLength(1));
        expect(approvalResponses()[0]).toMatchObject({
          requestId: "request-1",
          decision: "acceptForSession",
        });
      } finally {
        await view.cleanup();
      }
    });

    it("sends nothing for a request the server no longer waits on", async () => {
      const thread = approvalThread();
      // Answered from another window: the server has no pending request left.
      serverPending();
      const toast = vi.spyOn(toastManager, "add");
      const view = await renderHome([thread]);
      try {
        const preview = page.getByRole("article", { name: "Needs an approval" });
        await preview.getByRole("button", { name: /Approve once/ }).click();
        await expect
          .element(preview.getByRole("status"))
          .toHaveTextContent("This request was already answered.");
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: "This request was already answered." }),
        );
        expect(approvalResponses()).toHaveLength(0);
        expect(preview.getByRole("group", { name: "Approval" }).all()).toHaveLength(0);
      } finally {
        await view.cleanup();
      }
    });

    it("leaves Enter unbound when the provider asks for No as the default", async () => {
      const thread = approvalThread({ presentation: { defaultToNo: true } });
      const view = await renderHome([thread]);
      try {
        const approve = page.getByRole("button", { name: /Approve once/ });
        await expect.element(approve).toBeVisible();
        expect(approve.element().textContent).toBe("Approve once");
        // The hints name D, which declines, and not an Enter that would do nothing.
        await vi.waitFor(() => expect(keyHints()).toContain("deny"));
        expect(keyHints()).not.toContain("approve");
        await expect.element(queue()).toHaveFocus();
        await userEvent.keyboard("{Enter}");
        // A click is still a deliberate yes.
        await approve.click();
        await vi.waitFor(() => expect(approvalResponses()).toHaveLength(1));
        expect(dispatchCommand).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();
      } finally {
        await view.cleanup();
      }
    });

    it("refuses to act while the server connection is down", async () => {
      resetWsConnectionStateForTests();
      const view = await renderHome([approvalThread(), DONE_THREAD]);
      try {
        await expect.element(page.getByRole("button", { name: /Approve once/ })).toBeDisabled();
        await expect.element(page.getByRole("button", { name: /Decline/ })).toBeDisabled();
        await expect.element(queue()).toHaveFocus();
        await userEvent.keyboard("{Enter}");
        await userEvent.keyboard("d");
        await page.getByRole("option", { name: "Finished refactor" }).click();
        await page.getByRole("textbox", { name: "Reply" }).fill("Ship it");
        await expect.element(page.getByRole("button", { name: "Reply" })).toBeDisabled();
        await userEvent.keyboard("{Enter}");
        expect(dispatchCommand).not.toHaveBeenCalled();
        expect(submitTurn).not.toHaveBeenCalled();
        // Reading is not blocked: the thread still opens.
        await page.getByRole("button", { name: /Open thread/ }).click();
        await vi.waitFor(() =>
          expect(document.querySelector('[data-testid="thread-route"]')).toBeTruthy(),
        );
      } finally {
        await view.cleanup();
      }
    });

    it("answers a blocking question in place, with the answer shape its provider reads", async () => {
      const thread = makeThread(PROJECT_A.id, "thread-question", {
        title: "Pick a database",
        activities: [
          {
            id: "activity-question" as never,
            tone: "info",
            kind: "user-input.requested",
            summary: "Question",
            payload: {
              requestId: "input-1",
              questions: [
                {
                  id: "db",
                  header: "Database",
                  question: "Which database should the service use?",
                  options: [
                    { label: "Postgres", description: "Relational" },
                    { label: "SQLite", description: "Embedded" },
                  ],
                },
              ],
            },
            turnId: null,
            createdAt: NOW_ISO,
          },
        ],
      });
      const view = await renderHome([thread]);
      try {
        const preview = page.getByRole("article", { name: "Pick a database" });
        await expect.element(preview).toHaveTextContent("Which database should the service use?");
        const option = preview.getByRole("button", { name: /SQLite/ });
        await option.click();
        // The form's own keys stay in the form: E must not settle the thread from here.
        await userEvent.keyboard("e");
        await preview.getByRole("button", { name: "Send" }).click();
        await vi.waitFor(() =>
          expect(dispatchCommand).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "thread.user-input.respond",
              threadId: thread.id,
              requestId: "input-1",
              answers: { db: "SQLite" },
            }),
          ),
        );
        expect(dispatchCommand).toHaveBeenCalledTimes(1);
      } finally {
        await view.cleanup();
      }
    });

    const PLAN_THREAD = makeThread(PROJECT_A.id, "thread-plan", {
      title: "Plan the queue",
      interactionMode: "plan",
      runtimeMode: "approval-required",
      latestTurn: endedTurn("thread-plan", "completed"),
      proposedPlans: [
        {
          id: "plan-1" as never,
          turnId: "thread-plan-turn" as never,
          planMarkdown: "# Ship the queue\n\n1. Build it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
    });

    it("implements the plan on screen with Enter, in the thread's own settings", async () => {
      const view = await renderHome([PLAN_THREAD]);
      try {
        const preview = page.getByRole("article", { name: "Plan the queue" });
        await expect.element(preview).toHaveTextContent("Ship the queue");
        await expect.element(queue()).toHaveFocus();
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(1));
        expect(submitTurn.mock.calls[0]![0].intent).toBe("auto");
        expect(submittedCommand()).toMatchObject({
          type: "thread.turn.start",
          threadId: PLAN_THREAD.id,
          model: "gpt-5.4",
          runtimeMode: "approval-required",
          interactionMode: "default",
          sourceProposedPlan: { threadId: PLAN_THREAD.id, planId: "plan-1" },
          message: { text: "PLEASE IMPLEMENT THIS PLAN:\n# Ship the queue\n\n1. Build it" },
        });
        expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();
      } finally {
        await view.cleanup();
      }
    });

    it("revises a plan in plan mode from the reply box", async () => {
      const view = await renderHome([PLAN_THREAD]);
      try {
        await expect.element(queue()).toHaveFocus();
        await userEvent.keyboard("r");
        const box = page.getByRole("textbox", { name: "Revise plan" });
        await expect.element(box).toHaveFocus();
        // The key that focused the box is not typed into it.
        await expect.element(box).toHaveValue("");
        await userEvent.keyboard("Skip the migration{Enter}");
        await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(1));
        const command = submittedCommand();
        expect(command).toMatchObject({
          interactionMode: "plan",
          message: { text: "Skip the migration" },
        });
        expect(command.sourceProposedPlan).toBeUndefined();
        await expect.element(box).toHaveValue("");
      } finally {
        await view.cleanup();
      }
    });

    it("replies with the thread's own model and modes, and keeps the text when the send fails", async () => {
      const thread: Thread = {
        ...DONE_THREAD,
        model: "claude-opus-4-6",
        modelSelection: { instanceId: "claude", model: "claude-opus-4-6" } as never,
        runtimeMode: "approval-required",
      };
      submitTurn.mockImplementationOnce(
        async (input) =>
          ({
            submissionId: input.submissionId,
            disposition: "rejected",
            reasonCode: "provider_unavailable",
            detail: "The provider is signed out.",
          }) as never,
      );
      const toast = vi.spyOn(toastManager, "add");
      const view = await renderHome([thread]);
      try {
        const box = page.getByRole("textbox", { name: "Reply" });
        await box.fill("Looks good, open a PR");
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() =>
          expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
              title: "Could not send the message",
              description: "The provider is signed out.",
            }),
          ),
        );
        await expect.element(box).toHaveValue("Looks good, open a PR");

        await page.getByRole("button", { name: "Reply" }).click();
        await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(2));
        expect(submitTurn.mock.calls[1]![0].intent).toBe("auto");
        expect(submittedCommand(1)).toMatchObject({
          threadId: thread.id,
          model: "claude-opus-4-6",
          modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          message: { text: "Looks good, open a PR", attachments: [] },
        });
        await expect.element(box).toHaveValue("");
        // Escape hands the keys back to the queue.
        await box.click();
        await userEvent.keyboard("{Escape}");
        await expect.element(queue()).toHaveFocus();
      } finally {
        await view.cleanup();
      }
    });

    it("queues a message behind a running turn", async () => {
      const view = await renderHome([WORKING_THREAD]);
      try {
        const box = page.getByRole("textbox", { name: "Queue message" });
        await box.fill("Then run the tests");
        await page.getByRole("button", { name: "Queue message" }).click();
        await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(1));
        expect(submitTurn.mock.calls[0]![0].intent).toBe("queue-tail");
        expect(submittedCommand().message.text).toBe("Then run the tests");
      } finally {
        await view.cleanup();
      }
    });

    it("asks before sending to a thread whose branch changed under it", async () => {
      const thread: Thread = { ...DONE_THREAD, branch: "feature/queue" };
      const view = await renderHome([thread]);
      try {
        const box = page.getByRole("textbox", { name: "Reply" });
        await box.fill("Continue");
        await userEvent.keyboard("{Enter}");
        const dialog = page.getByRole("dialog", { name: "Thread branch changed" });
        await expect.element(dialog).toHaveTextContent("feature/queue");
        expect(listBranches).toHaveBeenCalledWith({ cwd: PROJECT_B.cwd });
        // Keys under the dialog are not Home's.
        await userEvent.keyboard("e");
        await dialog.getByRole("button", { name: "Cancel send" }).click();
        await expect.element(box).toHaveValue("Continue");
        expect(submitTurn).not.toHaveBeenCalled();
        expect(dispatchCommand).not.toHaveBeenCalled();
      } finally {
        await view.cleanup();
      }
    });

    it("resumes a paused queue at the revision the server has", async () => {
      useNextTurnQueueStore.setState({
        summary: {
          threads: [
            {
              threadId: IDLE_THREAD.id,
              queuedCount: 1,
              dispatchingCount: 0,
              failedCount: 0,
              scheduledResumeAt: null,
              paused: true,
            },
          ],
        },
      });
      const view = await renderHome([IDLE_THREAD]);
      try {
        await page.getByRole("button", { name: "Resume queue" }).click();
        await vi.waitFor(() =>
          expect(setQueuePaused).toHaveBeenCalledWith({
            threadId: IDLE_THREAD.id,
            paused: false,
            expectedRevision: 7,
          }),
        );
        // The summary read after it says no queue is paused: the row leaves.
        await expect.element(page.getByText("Nothing needs you")).toBeInTheDocument();
      } finally {
        await view.cleanup();
      }
    });

    it("does not approve or implement on Enter after a click in the preview", async () => {
      const thread = approvalThread();
      serverPending(...thread.activities);
      const view = await renderHome([thread, PLAN_THREAD]);
      try {
        const approval = page.getByRole("article", { name: "Needs an approval" });
        // Reading the request: a click in its text, then on the pane's own header.
        for (const target of [
          approval.getByText("git push --force-with-lease"),
          approval.getByRole("heading", { name: "Needs an approval" }),
        ]) {
          await target.click();
          expect(approval.element().contains(document.activeElement)).toBe(true);
          await userEvent.keyboard("{Enter}");
          await userEvent.keyboard("{ArrowDown}");
          await expect.poll(selectedTitle).toBe("Needs an approval");
        }
        // The letter keys still work from there.
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Plan the queue");
        const plan = page.getByRole("article", { name: "Plan the queue" });
        await plan.getByText("Build it").click();
        await userEvent.keyboard("{Enter}");
        await userEvent.keyboard("{ArrowUp}");
        await expect.poll(selectedTitle).toBe("Plan the queue");
        await userEvent.keyboard("k");
        await expect.poll(selectedTitle).toBe("Needs an approval");

        // One deliberate answer from the queue is the only thing that was sent.
        queue().element().focus();
        await userEvent.keyboard("d");
        await vi.waitFor(() => expect(approvalResponses()).toHaveLength(1));
        expect(approvalResponses()[0]).toMatchObject({ decision: "decline" });
        expect(submitTurn).not.toHaveBeenCalled();
        expect(document.querySelector('[data-testid="thread-route"]')).toBeNull();
      } finally {
        await view.cleanup();
      }
    });

    it("names Enter and D in the hints only where they act", async () => {
      const showPreview = holdPreview();
      const view = await renderHome([approvalThread(), PLAN_THREAD, WORKING_THREAD]);
      try {
        await expect.element(queue()).toHaveFocus();
        // Nothing is on screen to approve yet.
        expect(keyHints()).toContain("open");
        expect(keyHints()).not.toContain("approve");
        showPreview();
        await vi.waitFor(() => expect(keyHints()).toContain("approve"));
        expect(keyHints()).toContain("deny");

        await userEvent.keyboard("j");
        await vi.waitFor(() => expect(keyHints()).toContain("implement"));
        expect(keyHints()).not.toContain("deny");
        expect(keyHints()).toContain("settle");

        // A running thread opens with Enter and cannot be settled.
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Busy refactor");
        await vi.waitFor(() => expect(keyHints()).not.toContain("implement"));
        expect(keyHints()).not.toContain("settle");
        expect(keyHints()).toContain("queue message");
      } finally {
        await view.cleanup();
      }
    });

    it("sends one decision when the selection moves away and back during its round trip", async () => {
      const thread = approvalThread();
      serverPending(...thread.activities);
      let answer!: () => void;
      dispatchCommand.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = () => resolve({ sequence: 1 });
          }),
      );
      const view = await renderHome([thread, DONE_THREAD]);
      try {
        await expect.element(page.getByRole("group", { name: "Approval" })).toBeVisible();
        await expect.element(queue()).toHaveFocus();
        await userEvent.keyboard("d");
        await vi.waitFor(() => expect(approvalResponses()).toHaveLength(1));

        // Away and back: a new preview, and the server still lists the request as pending.
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Finished refactor");
        await userEvent.keyboard("k");
        await expect.poll(selectedTitle).toBe("Needs an approval");
        const preview = page.getByRole("article", { name: "Needs an approval" });
        await expect.element(preview.getByRole("button", { name: /Approve once/ })).toBeDisabled();
        await userEvent.keyboard("{Enter}");

        answer();
        await expect.element(preview.getByRole("status")).toHaveTextContent("Decision sent");
        await userEvent.keyboard("{Enter}");
        await userEvent.keyboard("j");
        await expect.poll(selectedTitle).toBe("Finished refactor");
        expect(approvalResponses()).toHaveLength(1);
        expect(approvalResponses()[0]).toMatchObject({ decision: "decline" });
      } finally {
        await view.cleanup();
      }
    });

    it("resends the same reply, not a second one, after its response was lost", async () => {
      // The server took the message; its answer never arrived.
      submitTurn.mockImplementationOnce(async () => {
        throw new Error("Request timed out: nextTurnQueue.submit");
      });
      const toast = vi.spyOn(toastManager, "add");
      const view = await renderHome([DONE_THREAD]);
      try {
        const box = page.getByRole("textbox", { name: "Reply" });
        await box.fill("Open a PR");
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() =>
          expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Could not send the message" }),
          ),
        );
        await expect.element(box).toHaveValue("Open a PR");

        await page.getByRole("button", { name: "Reply" }).click();
        await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(2));
        const [first, second] = submitTurn.mock.calls.map(([submission]) => submission);
        expect(second!.submissionId).toBe(first!.submissionId);
        expect(second!.command).toEqual(first!.command);
        await expect.element(box).toHaveValue("");
      } finally {
        await view.cleanup();
      }
    });

    it("keeps the reply as sent while it is in flight, in this preview and the next", async () => {
      let answer!: () => void;
      submitTurn.mockImplementationOnce(
        (input) =>
          new Promise((resolve) => {
            answer = () => resolve(startedTurn(input));
          }),
      );
      const view = await renderHome([FAILED_THREAD, DONE_THREAD]);
      try {
        await page.getByRole("option", { name: "Finished refactor" }).click();
        const box = page.getByRole("textbox", { name: "Reply" });
        await box.fill("Ship it");
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(1));
        // Typing now would be cleared with the sent text: the box does not take it.
        await expect.element(box).toHaveAttribute("readonly");
        await userEvent.keyboard(" and more");
        await expect.element(box).toHaveValue("Ship it");

        // The selection moves away and back: the new preview shows the same send in flight.
        await page.getByRole("option", { name: "Broken build" }).click();
        await expect.element(page.getByRole("textbox", { name: "Reply" })).toHaveValue("");
        await page.getByRole("option", { name: "Finished refactor" }).click();
        const again = page.getByRole("textbox", { name: "Reply" });
        await expect.element(again).toHaveValue("Ship it");
        await expect.element(again).toHaveAttribute("readonly");
        await expect.element(page.getByRole("button", { name: "Reply" })).toBeDisabled();

        answer();
        await expect.element(again).toHaveValue("");
        await expect.element(again).not.toHaveAttribute("readonly");
        expect(submitTurn).toHaveBeenCalledTimes(1);
      } finally {
        await view.cleanup();
      }
    });

    it("hands a reply that starts with a command to the thread's composer", async () => {
      const view = await renderHome([DONE_THREAD]);
      try {
        const box = page.getByRole("textbox", { name: "Reply" });
        await box.fill("/review the diff");
        await userEvent.keyboard("{Enter}");
        // The composer resolves commands and skills; Home would send them as plain words.
        await vi.waitFor(() =>
          expect(document.querySelector('[data-testid="thread-route"]')?.textContent).toBe(
            DONE_THREAD.id,
          ),
        );
        expect(submitTurn).not.toHaveBeenCalled();
        expect(useComposerDraftStore.getState().draftsByThreadId[DONE_THREAD.id]?.prompt).toBe(
          "/review the diff",
        );
        expect(useComposerFocusRequestStore.getState().request?.threadId).toBe(DONE_THREAD.id);
      } finally {
        await view.cleanup();
      }
    });

    it("explains the pause the server reports after a resume, not the one read before", async () => {
      const pausedSummary = {
        threads: [
          {
            threadId: IDLE_THREAD.id,
            queuedCount: 1,
            dispatchingCount: 0,
            failedCount: 0,
            scheduledResumeAt: null,
            paused: true,
          },
        ],
      };
      useNextTurnQueueStore.setState({ summary: pausedSummary });
      // The queue pauses again right away, for another reason.
      queueSummary.mockImplementation(async () => pausedSummary);
      listQueue.mockImplementation(async (input) =>
        queueSnapshot(input.threadId, {
          reasonCode: "turn_failed",
          reasonDetail: "The provider crashed.",
        }),
      );
      setQueuePaused.mockImplementation(async (input) =>
        queueSnapshot(input.threadId, {
          revision: input.expectedRevision + 1,
          reasonCode: "usage_limit_reset",
        }),
      );
      const view = await renderHome([IDLE_THREAD]);
      try {
        const preview = page.getByRole("article", { name: "Quiet thread" });
        await expect.element(preview).toHaveTextContent("The provider crashed.");
        await preview.getByRole("button", { name: "Resume queue" }).click();
        await expect.element(preview).toHaveTextContent("Waiting for the usage limit to reset.");
        await expect.element(preview).not.toHaveTextContent("The provider crashed.");
      } finally {
        await view.cleanup();
      }
    });

    it("keeps the keys working while the preview stands alone in a narrow window", async () => {
      await page.viewport(600, 800);
      const view = await renderHome([approvalThread(), DONE_THREAD]);
      try {
        await expect.element(queue()).toHaveFocus();
        // The first Enter only shows the request.
        await userEvent.keyboard("{Enter}");
        const preview = page.getByRole("article", { name: "Needs an approval" });
        await expect.element(preview).toHaveFocus();
        expect(dispatchCommand).not.toHaveBeenCalled();
        await userEvent.keyboard("j");
        await expect
          .element(page.getByRole("article", { name: "Finished refactor" }))
          .toHaveFocus();
        await userEvent.keyboard("k");
        await expect.element(preview).toHaveFocus();
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(approvalResponses()).toHaveLength(1));
        await userEvent.keyboard("{Escape}");
        await expect.element(queue()).toHaveFocus();
      } finally {
        await view.cleanup();
      }
    });
  });

  describe("status strip", () => {
    it("counts work on the other surfaces and never calls Home caught up over it", async () => {
      getPrHubOverview.mockImplementation(async () => ({ counts: { needs_you: 1423 } }));
      getDiskSpace.mockImplementation(async () => ({
        ...emptyDiskSpaceStatus,
        level: "low",
        volumes: [
          {
            path: "/data",
            roles: ["userdata"],
            freeBytes: 6 * 1024 ** 3,
            totalBytes: 460 * 1024 ** 3,
            level: "low",
          },
        ],
      }));
      const view = await renderHome([IDLE_THREAD]);
      try {
        const strip = page.getByRole("group", { name: "Elsewhere in F5" });
        await expect
          .element(strip.getByTestId("home-strip-prs"))
          .toHaveTextContent("1.4k PRs need you");
        await expect
          .element(strip.getByTestId("home-strip-disk"))
          .toHaveTextContent(/Disk 6.*free/);
        await expect.element(page.getByText("No threads need you")).toBeInTheDocument();
        expect(page.getByText("Nothing needs you").all()).toHaveLength(0);
        // The old banner is gone: low disk space is one chip.
        expect(page.getByRole("alert").all()).toHaveLength(0);
      } finally {
        await view.cleanup();
      }
    });

    it("renders nothing while every surface is quiet", async () => {
      const view = await renderHome([IDLE_THREAD]);
      try {
        await expect.element(page.getByText("Nothing needs you")).toBeInTheDocument();
        expect(document.querySelector('[data-slot="home-status-strip"]')?.childElementCount).toBe(
          0,
        );
      } finally {
        await view.cleanup();
      }
    });
  });
});
