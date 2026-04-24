import "../index.css";

import {
  CodeReviewWorkflowId,
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  PlanningWorkflowId,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useStore } from "../store";
import { resetWsConnectionStateForTests } from "../wsConnectionState";

vi.mock("./DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children ?? null,
}));

vi.mock("./DiffPanel", () => ({
  DIFF_PANEL_UNSAFE_CSS: "",
  buildFileDiffRenderKey: () => "mock-file-diff-key",
  getRenderablePatch: () => "",
  resolveFileDiffPath: (filePath: string) => filePath,
  default: ({ mode = "inline" }: { mode?: string }) => (
    <div data-testid={`mock-diff-panel-${mode}`}>Mock diff panel</div>
  ),
}));

const PROJECT_ID = "project-thread-recency" as ProjectId;
const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;
const THREAD_C = "thread-c" as ThreadId;
const THREAD_D = "thread-d" as ThreadId;
const PLANNING_WORKFLOW_ID = PlanningWorkflowId.makeUnsafe("workflow-1");
const CODE_REVIEW_WORKFLOW_ID = CodeReviewWorkflowId.makeUnsafe("review-workflow-1");
const NOW_ISO = "2026-04-14T10:00:00.000Z";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

type SnapshotThread = OrchestrationReadModel["threads"][number];

let fixture: TestFixture;

const wsLink = ws.link(/ws(s)?:\/\/.*/);

function createBaseServerConfig(keybindings = createDefaultCycleBindings()): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings,
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
    availableEditors: [],
  };
}

function createDefaultCycleBindings(): ServerConfig["keybindings"] {
  return [
    {
      command: "thread.switchRecentNext",
      shortcut: {
        key: "tab",
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        modKey: false,
      },
    },
    {
      command: "thread.switchRecentPrevious",
      shortcut: {
        key: "tab",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        modKey: false,
      },
    },
  ];
}

function createSingleStepCycleBindings(): ServerConfig["keybindings"] {
  return [
    {
      command: "thread.switchRecentNext",
      shortcut: {
        key: "tab",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: false,
      },
    },
  ];
}

function createHeldModifierCycleBindings(): ServerConfig["keybindings"] {
  return [
    {
      command: "thread.switchRecentNext",
      shortcut: {
        key: "tab",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
        modKey: true,
      },
    },
  ];
}

function createSnapshotThread(
  overrides: Partial<SnapshotThread> & Pick<SnapshotThread, "id" | "title">,
): SnapshotThread {
  const { id, title, ...rest } = overrides;
  return {
    id,
    projectId: PROJECT_ID,
    title,
    model: "gpt-5",
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    archivedAt: null,
    createdAt: NOW_ISO,
    lastInteractionAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
    messages: [
      {
        id: `msg-${id}` as MessageId,
        role: "user",
        text: `hello from ${id}`,
        turnId: null,
        streaming: false,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
    activities: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    compaction: null,
    checkpoints: [],
    session: {
      threadId: id,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW_ISO,
    },
    ...rest,
  };
}

function createSnapshot(
  threads: SnapshotThread[] = [
    createSnapshotThread({ id: THREAD_A, title: "Thread A" }),
    createSnapshotThread({ id: THREAD_B, title: "Thread B" }),
    createSnapshotThread({ id: THREAD_C, title: "Thread C" }),
    createSnapshotThread({ id: THREAD_D, title: "Thread D" }),
  ],
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5",
        scripts: [],
        memories: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threads,
    updatedAt: NOW_ISO,
  };
}

function createPlanningWorkflow(
  overrides: {
    id?: string;
    title?: string;
    projectId?: ProjectId;
    branchAThreadId?: ThreadId;
    branchBThreadId?: ThreadId;
    archivedAt?: string | null;
  } = {},
): OrchestrationReadModel["planningWorkflows"][number] {
  const branchAThreadId = overrides.branchAThreadId ?? ("workflow-branch-a" as ThreadId);
  const branchBThreadId = overrides.branchBThreadId ?? ("workflow-branch-b" as ThreadId);
  return {
    id: PlanningWorkflowId.makeUnsafe(overrides.id ?? PLANNING_WORKFLOW_ID),
    projectId: overrides.projectId ?? PROJECT_ID,
    title: overrides.title ?? "Feature workflow",
    slug: "feature-workflow",
    requirementPrompt: "Build the feature workflow summary page.",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    branchA: {
      branchId: "a",
      authorSlot: { provider: "codex", model: "gpt-5" },
      authorThreadId: branchAThreadId,
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "authoring",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW_ISO,
    },
    branchB: {
      branchId: "b",
      authorSlot: { provider: "codex", model: "gpt-5" },
      authorThreadId: branchBThreadId,
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW_ISO,
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5" },
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      updatedAt: NOW_ISO,
    },
    implementation: null,
    totalCostUsd: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: overrides.archivedAt ?? null,
    deletedAt: null,
  };
}

function createCodeReviewWorkflow(
  overrides: {
    id?: string;
    title?: string;
    projectId?: ProjectId;
    reviewerAThreadId?: ThreadId;
    reviewerBThreadId?: ThreadId;
    archivedAt?: string | null;
  } = {},
): OrchestrationReadModel["codeReviewWorkflows"][number] {
  const reviewerAThreadId = overrides.reviewerAThreadId ?? ("reviewer-a" as ThreadId);
  const reviewerBThreadId = overrides.reviewerBThreadId ?? ("reviewer-b" as ThreadId);
  return {
    id: CodeReviewWorkflowId.makeUnsafe(overrides.id ?? CODE_REVIEW_WORKFLOW_ID),
    projectId: overrides.projectId ?? PROJECT_ID,
    title: overrides.title ?? "Review workflow",
    slug: "review-workflow",
    reviewPrompt: "Review the implementation branch.",
    branch: null,
    reviewerA: {
      label: "Reviewer A",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: reviewerAThreadId,
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW_ISO,
    },
    reviewerB: {
      label: "Reviewer B",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: reviewerBThreadId,
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW_ISO,
    },
    consolidation: {
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW_ISO,
    },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: overrides.archivedAt ?? null,
    deletedAt: null,
  };
}

function buildFixture(
  snapshot: OrchestrationReadModel = createSnapshot(),
  keybindings: ServerConfig["keybindings"] = createDefaultCycleBindings(),
): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(keybindings),
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_A,
    },
  };
}

function resolveWsRpc(body: { _tag: string; threadId?: string }): unknown {
  const tag = body._tag;
  // After e513502 (lazy thread detail loading) the client first calls
  // `getStartupSnapshot` and then `getThreadTailDetails` per-thread instead of
  // the legacy `getSnapshot`. We respond to the new methods as well so these
  // tests hydrate the store.
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot) {
    const detailThreadId =
      typeof (body as { detailThreadId?: string }).detailThreadId === "string"
        ? ((body as { detailThreadId?: string }).detailThreadId as ThreadId)
        : null;
    const thread = detailThreadId
      ? fixture.snapshot.threads.find((entry) => entry.id === detailThreadId)
      : null;
    return {
      snapshot: fixture.snapshot,
      threadTailDetails: thread
        ? {
            threadId: detailThreadId,
            messages: thread.messages,
            checkpoints: thread.checkpoints,
            commandExecutions: [],
            tasks: thread.tasks,
            tasksTurnId: thread.tasksTurnId,
            tasksUpdatedAt: thread.tasksUpdatedAt,
            sessionNotes: null,
            threadReferences: [],
            hasOlderMessages: false,
            hasOlderCheckpoints: false,
            hasOlderCommandExecutions: false,
            oldestLoadedMessageCursor:
              thread.messages[0] === undefined
                ? null
                : {
                    createdAt: thread.messages[0].createdAt,
                    messageId: thread.messages[0].id,
                  },
            oldestLoadedCheckpointTurnCount: thread.checkpoints[0]?.checkpointTurnCount ?? null,
            oldestLoadedCommandExecutionCursor: null,
            detailSequence: fixture.snapshot.snapshotSequence,
          }
        : null,
    };
  }
  if (tag === ORCHESTRATION_WS_METHODS.getThreadTailDetails) {
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    const thread = fixture.snapshot.threads.find((t) => t.id === threadId);
    return {
      threadId,
      messages: thread?.messages ?? [],
      checkpoints: thread?.checkpoints ?? [],
      commandExecutions: [],
      tasks: thread?.tasks ?? [],
      tasksTurnId: thread?.tasksTurnId ?? null,
      tasksUpdatedAt: thread?.tasksUpdatedAt ?? null,
      sessionNotes: null,
      threadReferences: [],
      hasOlderMessages: false,
      hasOlderCheckpoints: false,
      hasOlderCommandExecutions: false,
      oldestLoadedMessageCursor:
        thread?.messages[0] === undefined
          ? null
          : {
              createdAt: thread.messages[0].createdAt,
              messageId: thread.messages[0].id,
            },
      oldestLoadedCheckpointTurnCount: thread?.checkpoints[0]?.checkpointTurnCount ?? null,
      oldestLoadedCommandExecutionCursor: null,
      detailSequence: fixture.snapshot.snapshotSequence,
    };
  }
  if (tag === ORCHESTRATION_WS_METHODS.getThreadHistoryPage) {
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    return {
      threadId,
      messages: [],
      checkpoints: [],
      commandExecutions: [],
      hasOlderMessages: false,
      hasOlderCheckpoints: false,
      hasOlderCommandExecutions: false,
      oldestLoadedMessageCursor: null,
      oldestLoadedCheckpointTurnCount: null,
      oldestLoadedCommandExecutionCursor: null,
      detailSequence: fixture.snapshot.snapshotSequence,
    };
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return { entries: [], truncated: false };
  }

  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.send(
      JSON.stringify({
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverWelcome,
        data: fixture.welcome,
      }),
    );
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;

      let request: { id: string; body: { _tag: string; threadId?: string } };
      try {
        request = JSON.parse(event.data) as {
          id: string;
          body: { _tag: string; threadId?: string };
        };
      } catch {
        return;
      }

      const method = request.body?._tag;
      if (typeof method !== "string") return;
      client.send(
        JSON.stringify({
          id: request.id,
          result: resolveWsRpc(request.body),
        }),
      );
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function setViewport(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
    },
    { timeout: 4_000, interval: 16 },
  );
}

async function waitForPath(router: ReturnType<typeof getRouter>, pathname: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(router.state.location.pathname).toBe(pathname);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForSettingsCategory(
  router: ReturnType<typeof getRouter>,
  category: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect((router.state.location.search as { category?: string }).category).toBe(category);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForThreadsHydrated(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(useStore.getState().threadsHydrated).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function mountApp(options?: {
  initialEntries?: string[];
  keybindings?: ServerConfig["keybindings"];
  snapshot?: OrchestrationReadModel;
}): Promise<{
  cleanup: () => Promise<void>;
  host: HTMLDivElement;
  router: ReturnType<typeof getRouter>;
}> {
  fixture = buildFixture(options?.snapshot ?? createSnapshot(), options?.keybindings);
  await setViewport(1_440, 1_000);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: options?.initialEntries ?? [`/${THREAD_A}`],
    }),
  );
  const screen = await render(<RouterProvider router={router} />, {
    container: host,
  });

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
    host,
    router,
  };
}

async function seedRecentThreads(router: ReturnType<typeof getRouter>): Promise<void> {
  for (const threadId of [THREAD_B, THREAD_C, THREAD_D, THREAD_A]) {
    await router.navigate({
      to: "/$threadId",
      params: { threadId },
    });
    await waitForPath(router, `/${threadId}`);
    await waitForLayout();
  }
}

function dispatchWindowKeyboardEvent(
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
): {
  dispatched: boolean;
  event: KeyboardEvent;
} {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  return {
    dispatched: window.dispatchEvent(event),
    event,
  };
}

function defaultCycleKeyOptions(overrides: KeyboardEventInit = {}): KeyboardEventInit {
  return {
    key: "Tab",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function customHeldModifierKeyOptions(overrides: KeyboardEventInit = {}): KeyboardEventInit {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return {
    key: "Tab",
    ctrlKey: !isMac,
    metaKey: isMac,
    shiftKey: false,
    altKey: true,
    ...overrides,
  };
}

function queryPicker(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-slot='thread-cycle-picker-panel']");
}

function queryPickerBackdrop(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-slot='thread-cycle-picker-backdrop']");
}

function queryPickerOptions(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-slot='thread-cycle-picker-option']"),
  );
}

function queryHighlightedOption(): HTMLButtonElement | null {
  return (
    queryPickerOptions().find((option) => option.getAttribute("aria-selected") === "true") ?? null
  );
}

function readLiveRegionText(): string {
  return (
    document
      .querySelector<HTMLElement>("[data-slot='thread-cycle-picker-live-region']")
      ?.textContent?.trim() ?? ""
  );
}

async function waitForPickerVisible(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(queryPicker()).toBeTruthy();
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForPickerHidden(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(queryPicker()).toBeNull();
    },
    { timeout: 8_000, interval: 16 },
  );
}

describe("ThreadRecencyController", () => {
  let documentHidden = false;
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    documentHidden = false;
    scrollIntoViewSpy = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoViewSpy,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => documentHidden,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (documentHidden ? "hidden" : "visible"),
    });
    resetWsConnectionStateForTests();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [],
      threads: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the picker on Ctrl+Tab and navigates only after the modifier is released", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await waitForPath(mounted.router, `/${THREAD_A}`);
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_A}`);
      expect(queryHighlightedOption()?.textContent).toContain("Thread D");
      expect(readLiveRegionText()).toBe("Thread D");
      expect(scrollIntoViewSpy).toHaveBeenCalled();

      dispatchWindowKeyboardEvent("keyup", {
        key: "Control",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/${THREAD_D}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the shared thread status pill for thread targets in the picker", async () => {
    const snapshot = createSnapshot([
      createSnapshotThread({ id: THREAD_A, title: "Thread A" }),
      createSnapshotThread({ id: THREAD_B, title: "Thread B" }),
      createSnapshotThread({ id: THREAD_C, title: "Thread C" }),
      createSnapshotThread({
        id: THREAD_D,
        title: "Thread D",
        session: {
          threadId: THREAD_D,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as never,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      }),
    ]);
    const mounted = await mountApp({ snapshot });

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      expect(queryHighlightedOption()?.textContent).toContain("Thread D");
      expect(queryHighlightedOption()?.textContent).toContain("Working");
    } finally {
      await mounted.cleanup();
    }
  });

  it("includes settings as a recent tab target and preserves the last visited category", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await waitForPath(mounted.router, `/${THREAD_A}`);

      await mounted.router.navigate({
        to: "/settings",
        search: { category: "providers" },
      });
      await waitForPath(mounted.router, "/settings");
      await waitForSettingsCategory(mounted.router, "providers");
      await waitForLayout();

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_B },
      });
      await waitForPath(mounted.router, `/${THREAD_B}`);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      expect(queryHighlightedOption()?.textContent).toContain("Settings");
      expect(queryHighlightedOption()?.textContent).toContain("Providers");

      dispatchWindowKeyboardEvent("keyup", {
        key: "Control",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });

      await waitForPickerHidden();
      await waitForPath(mounted.router, "/settings");
      await waitForSettingsCategory(mounted.router, "providers");
    } finally {
      await mounted.cleanup();
    }
  });

  it("advances multiple times before committing the highlighted thread", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      expect(queryHighlightedOption()?.textContent).toContain("Thread B");

      dispatchWindowKeyboardEvent("keyup", {
        key: "Control",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/${THREAD_B}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("includes planning and code-review workflow pages in the cycle order", async () => {
    const snapshot: OrchestrationReadModel = {
      ...createSnapshot(),
      planningWorkflows: [createPlanningWorkflow({ title: "Feature workflow" })],
      codeReviewWorkflows: [createCodeReviewWorkflow({ title: "Review workflow" })],
    };
    const mounted = await mountApp({ snapshot });

    try {
      await waitForThreadsHydrated();
      await waitForPath(mounted.router, `/${THREAD_A}`);

      await mounted.router.navigate({
        to: "/workflow/$workflowId",
        params: { workflowId: PLANNING_WORKFLOW_ID },
      });
      await waitForPath(mounted.router, `/workflow/${PLANNING_WORKFLOW_ID}`);
      await waitForLayout();

      await mounted.router.navigate({
        to: "/code-review/$workflowId",
        params: { workflowId: CODE_REVIEW_WORKFLOW_ID },
      });
      await waitForPath(mounted.router, `/code-review/${CODE_REVIEW_WORKFLOW_ID}`);
      await waitForLayout();

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_B },
      });
      await waitForPath(mounted.router, `/${THREAD_B}`);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      expect(queryHighlightedOption()?.textContent).toContain("Review workflow");
      expect(queryHighlightedOption()?.textContent).toContain("Review");

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await vi.waitFor(
        () => {
          expect(queryHighlightedOption()?.textContent).toContain("Feature workflow");
          expect(queryHighlightedOption()?.textContent).toContain("Feature");
        },
        { timeout: 8_000, interval: 16 },
      );

      dispatchWindowKeyboardEvent("keyup", {
        key: "Control",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/workflow/${PLANNING_WORKFLOW_ID}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("cycles backward with Ctrl+Shift+Tab", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions({ shiftKey: true }));
      await waitForPickerVisible();

      expect(queryHighlightedOption()?.textContent).toContain("Thread B");

      dispatchWindowKeyboardEvent("keyup", {
        key: "Control",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/${THREAD_B}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not navigate while the picker is visible", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_A}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("cancels the cycle on Escape and ignores the later modifier release", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      dispatchWindowKeyboardEvent("keydown", {
        key: "Escape",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });

      await waitForPickerHidden();
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_A}`);

      dispatchWindowKeyboardEvent("keyup", {
        key: "Control",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });
      await waitForLayout();

      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_A}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("commits the highlighted thread when the window blurs", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      window.dispatchEvent(new Event("blur"));

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/${THREAD_D}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("commits the highlighted thread when the document becomes hidden", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      documentHidden = true;
      document.dispatchEvent(new Event("visibilitychange"));

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/${THREAD_D}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("ends the cycle when navigation changes externally", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_C },
      });

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/${THREAD_C}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("ends the cycle when navigation changes externally to settings", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      await mounted.router.navigate({
        to: "/settings",
        search: { category: "providers" },
      });

      await waitForPickerHidden();
      await waitForPath(mounted.router, "/settings");
      await waitForSettingsCategory(mounted.router, "providers");
    } finally {
      await mounted.cleanup();
    }
  });

  it("navigates immediately for non-held single-step cycle bindings", async () => {
    const mounted = await mountApp({
      keybindings: createSingleStepCycleBindings(),
    });

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", {
        key: "Tab",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });

      await waitForPath(mounted.router, `/${THREAD_D}`);
      expect(queryPicker()).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does nothing when there is only one eligible thread", async () => {
    const mounted = await mountApp({
      snapshot: createSnapshot([createSnapshotThread({ id: THREAD_A, title: "Thread A" })]),
    });

    try {
      await waitForThreadsHydrated();
      await waitForPath(mounted.router, `/${THREAD_A}`);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForLayout();

      expect(queryPicker()).toBeNull();
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_A}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("updates gracefully when a thread disappears mid-cycle", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      fixture.snapshot = createSnapshot([
        createSnapshotThread({ id: THREAD_A, title: "Thread A" }),
        createSnapshotThread({ id: THREAD_C, title: "Thread C" }),
        createSnapshotThread({ id: THREAD_D, title: "Thread D" }),
      ]);
      useStore.getState().syncServerReadModel(fixture.snapshot);
      await waitForLayout();

      expect(queryPicker()).toBeTruthy();
      expect(queryPickerOptions()).toHaveLength(3);
      expect(queryHighlightedOption()?.textContent).toContain("Thread D");
    } finally {
      await mounted.cleanup();
    }
  });

  it("blocks non-cycle shortcuts while a cycle is active", async () => {
    const mounted = await mountApp();
    const bubbleListener = vi.fn();
    window.addEventListener("keydown", bubbleListener);

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      const result = dispatchWindowKeyboardEvent("keydown", {
        key: "n",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });

      expect(result.dispatched).toBe(false);
      expect(bubbleListener).not.toHaveBeenCalled();
      expect(queryPicker()).toBeTruthy();
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_A}`);
    } finally {
      window.removeEventListener("keydown", bubbleListener);
      await mounted.cleanup();
    }
  });

  it("supports held-modifier cycle bindings that include mod+alt", async () => {
    const mounted = await mountApp({
      keybindings: createHeldModifierCycleBindings(),
    });

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", customHeldModifierKeyOptions());
      await waitForPickerVisible();

      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_A}`);
      expect(queryHighlightedOption()?.textContent).toContain("Thread D");

      dispatchWindowKeyboardEvent("keyup", {
        key: navigator.platform.toLowerCase().includes("mac") ? "Meta" : "Control",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: true,
      });

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/${THREAD_D}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("commits the highlighted thread when the backdrop is clicked", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      queryPickerBackdrop()?.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
        }),
      );

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/${THREAD_D}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("commits the clicked picker row", async () => {
    const mounted = await mountApp();

    try {
      await waitForThreadsHydrated();
      await seedRecentThreads(mounted.router);

      dispatchWindowKeyboardEvent("keydown", defaultCycleKeyOptions());
      await waitForPickerVisible();

      const threadBOption = queryPickerOptions().find((option) =>
        option.textContent?.includes("Thread B"),
      );
      expect(threadBOption).toBeTruthy();

      threadBOption?.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
        }),
      );

      await waitForPickerHidden();
      await waitForPath(mounted.router, `/${THREAD_B}`);
    } finally {
      await mounted.cleanup();
    }
  });
});
