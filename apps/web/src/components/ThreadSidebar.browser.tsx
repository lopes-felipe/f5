import { resolveEmptyAppRpc } from "../test/emptyAppRpc";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { DEFAULT_SERVER_SETTINGS, type ProjectId as SettingsProjectId } from "@t3tools/contracts";
import { serverBootstrapFixture } from "../test/serverBootstrap";
import "../index.css";

import {
  AGENTS_WS_METHODS,
  SCHEDULED_TASK_WS_METHODS,
  CommandId,
  type DesktopBridge,
  ORCHESTRATION_WS_METHODS,
  PR_HUB_WS_METHODS,
  ProfileId,
  type MessageId,
  TurnId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  ThreadId,
  ScheduledTaskId,
  ScheduledTaskRunId,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import type { ReactNode } from "react";
import { page, userEvent } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../appSettings";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useShortcutsDialogStore } from "../shortcutsDialogStore";
import { COMPOSER_DRAFT_STORAGE_KEY, useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useRecoveryStateStore } from "../recoveryStateStore";
import { useNextTurnQueueStore } from "../nextTurnQueueStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { hasUnseenCompletion } from "../threadStatus";
import { useProfileState } from "../profileState";
import { createTestServerProvider } from "../testServerProvider";
import {
  createPlanningWorkflow as createPlanningWorkflowFixture,
  type CreatePlanningWorkflowOptions,
} from "../test/workflowFixtures";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { readThreadReferenceDrag } from "../lib/threadReferenceDrag";
import {
  THREAD_SIDEBAR_DEFAULT_WIDTH_PX,
  THREAD_SIDEBAR_MAX_WIDTH_PX,
  THREAD_SIDEBAR_MIN_WIDTH_PX,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "../threadSidebarWidth";
import { useWorkflowCreateDialogStore } from "../workflowCreateDialogStore";
import {
  noteWsConnectionClosed,
  noteWsConnectionOpened,
  noteWsSynchronized,
} from "../wsConnectionState";
import { toastManager } from "./ui/toast";

vi.mock("./DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children ?? null,
}));

vi.mock("./DiffPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DiffPanel")>();
  return {
    ...actual,
    default: ({ mode = "inline" }: { mode?: string }) => (
      <div data-testid={`mock-diff-panel-${mode}`}>Mock diff panel</div>
    ),
  };
});

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const THREAD_ID = "thread-sidebar-browser-test" as ThreadId;
const PROJECT_ID = "project-sidebar-browser-test" as ProjectId;
const NOW_ISO = "2026-03-11T12:00:00.000Z";
const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LONG_THREAD_TITLE =
  "A very long thread title that should stay intact and benefit from a wider sidebar during resize tests";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
  resolveWsRequest?: (
    body: WsRequestEnvelope["body"],
    client: TestWsClient,
  ) => MaybePromise<WsRequestResolution | null | undefined>;
}

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestWsClient {
  send: (data: string) => void;
  close: () => void;
}

type WsRequestResolution =
  | { type: "result"; result: unknown }
  | { type: "error"; message: string }
  | { type: "close" };

type MaybePromise<T> = T | Promise<T>;

let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const noopUnsubscribe = () => {};

const wsLink = ws.link(/ws(s)?:\/\/.*/);

type SnapshotThread = OrchestrationReadModel["threads"][number];

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function isPromiseLike<T>(value: MaybePromise<T> | null | undefined): value is Promise<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    customKeybindings: [],
    issues: [],
    providers: [createTestServerProvider("codex", { checkedAt: NOW_ISO })],
    availableEditors: [],
  };
}

function createShortcut(
  key: string,
  overrides: Partial<ServerConfig["keybindings"][number]["shortcut"]> = {},
) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function createSidebarShortcutBindings(): ServerConfig["keybindings"] {
  return [
    {
      command: "chat.new",
      shortcut: createShortcut("n"),
    },
    {
      command: "chat.newLocal",
      shortcut: createShortcut("l", { shiftKey: true }),
    },
    {
      command: "workflow.new",
      shortcut: createShortcut("n", { shiftKey: true }),
    },
  ];
}

function createSnapshotThread(
  overrides: Partial<SnapshotThread> & Pick<SnapshotThread, "id">,
): SnapshotThread {
  const { id, ...rest } = overrides;
  return {
    id,
    projectId: PROJECT_ID,
    title: LONG_THREAD_TITLE,
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
        id: `msg-${overrides.id}` as MessageId,
        role: "user",
        text: "hello",
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
  threads: SnapshotThread[] = [createSnapshotThread({ id: THREAD_ID })],
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
    investigationWorkflows: [],
    threads,
    updatedAt: NOW_ISO,
  };
}

function createSnapshotProject(
  id: ProjectId,
  title: string,
): OrchestrationReadModel["projects"][number] {
  return {
    id,
    title,
    workspaceRoot: `/repo/${id}`,
    defaultModel: "gpt-5",
    scripts: [],
    memories: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
  };
}

/** Summary fields that make a thread "Plan Ready" (activities only load with details). */
function createPlanReadyOverrides(
  key: string,
): Pick<SnapshotThread, "interactionMode" | "latestTurn" | "proposedPlans"> {
  const turnId = `turn-${key}` as never;
  return {
    interactionMode: "plan",
    latestTurn: {
      turnId,
      state: "completed",
      assistantMessageId: null,
      requestedAt: NOW_ISO,
      startedAt: NOW_ISO,
      completedAt: NOW_ISO,
    },
    proposedPlans: [
      {
        id: `plan-${key}` as never,
        turnId,
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
  };
}

function queryAttentionRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-testid^='attention-thread-row-']"),
  );
}

function createEmptySnapshot(): OrchestrationReadModel {
  return {
    ...createSnapshot([]),
    projects: [],
    threads: [],
  };
}

function createPlanningWorkflow(
  overrides: Omit<CreatePlanningWorkflowOptions, "projectId" | "now"> = {},
): OrchestrationReadModel["planningWorkflows"][number] {
  return createPlanningWorkflowFixture({
    projectId: PROJECT_ID,
    now: NOW_ISO,
    ...overrides,
  });
}

function buildFixture(snapshot: OrchestrationReadModel = createSnapshot()): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    // Tests select their route explicitly. The shared socket replays this
    // welcome across mounts, so a default bootstrap target would override Home.
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
    },
  };
}

function resolveWsRpc(body: WsRequestEnvelope["body"]): unknown {
  const emptyReply = resolveEmptyAppRpc(body);
  if (emptyReply !== undefined) return emptyReply;
  const tag = body._tag;
  if (tag === SCHEDULED_TASK_WS_METHODS.list) return { revision: 0, tasks: [] };
  if (tag === SCHEDULED_TASK_WS_METHODS.listRuns) return { runs: [], nextCursor: null };

  if (tag === AGENTS_WS_METHODS.getSnapshot) {
    return { entries: [], generatedAt: NOW_ISO };
  }
  // After e513502 (lazy thread detail loading) the client first calls
  // `getStartupSnapshot` and then `getThreadTailDetails` per-thread instead of
  // the legacy `getSnapshot`. Respond to the new methods as well so the
  // store hydrates and the sidebar rows render.
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
      // Match the server: null confirms the thread is absent, so the thread
      // route redirects home instead of waiting for metadata that never comes.
      thread: thread
        ? { ...thread, messages: [], activities: [], checkpoints: [], proposedPlans: [] }
        : null,
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
  if (tag === PR_HUB_WS_METHODS.getOverview) {
    return {
      status: "ok",
      viewerLogin: null,
      host: "github.com",
      counts: { needs_you: 0 },
      coverage: [],
      revision: "0",
      lastPolledAt: null,
    };
  }
  if (tag === WS_METHODS.projectsCloneList) return [];
  if (tag === WS_METHODS.serverGetProjectSettings) {
    const project = fixture.snapshot.projects.find((p) => p.id === body.projectId);
    return resolveProjectSettings({
      projectId: body.projectId as SettingsProjectId,
      global: fixture.serverConfig.settings ?? DEFAULT_SERVER_SETTINGS,
      legacyEnvMode: project?.defaultEnvMode ?? null,
    });
  }
  if (tag === WS_METHODS.serverMigrateClientSetting) {
    fixture.serverConfig = {
      ...fixture.serverConfig,
      settings: {
        ...(fixture.serverConfig.settings ?? DEFAULT_SERVER_SETTINGS),
        [body.key as string]: body.value,
      },
    };
    return { applied: true, currentValue: body.value };
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
  if (tag === WS_METHODS.projectsSearchContents) {
    return {
      requestId: body.requestId,
      matches: [],
      truncated: false,
      indexedPathCount: 0,
      indexTruncated: false,
    };
  }
  if (tag === WS_METHODS.projectsCancelContentSearch) {
    return { cancelled: false };
  }
  if (tag === WS_METHODS.globalSearchQuery) {
    return { results: [] };
  }
  if (tag === WS_METHODS.filesystemBrowse) {
    return { parentPath: "/", entries: [] };
  }
  if (tag === WS_METHODS.worktreesGetTransition) return null;

  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.send(
      JSON.stringify({
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverWelcome,
        data: { ...fixture.welcome, bootstrap: serverBootstrapFixture },
      }),
    );
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;

      let request: WsRequestEnvelope;
      try {
        request = JSON.parse(event.data) as WsRequestEnvelope;
      } catch {
        return;
      }

      const method = request.body?._tag;
      if (typeof method !== "string") return;
      wsRequests.push(request.body);

      const sendError = (error: unknown) => {
        client.send(
          JSON.stringify({
            id: request.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      };

      const sendResolution = (resolution: WsRequestResolution | null | undefined) => {
        if (resolution?.type === "close") {
          client.close();
          return;
        }
        if (resolution?.type === "error") {
          client.send(
            JSON.stringify({
              id: request.id,
              error: {
                message: resolution.message,
              },
            }),
          );
          return;
        }
        client.send(
          JSON.stringify({
            id: request.id,
            result: resolution?.type === "result" ? resolution.result : resolveWsRpc(request.body),
          }),
        );
      };

      let resolution: MaybePromise<WsRequestResolution | null | undefined>;
      try {
        resolution = fixture.resolveWsRequest?.(request.body, client);
      } catch (error) {
        sendError(error);
        return;
      }

      if (isPromiseLike(resolution)) {
        void resolution.then(sendResolution).catch(sendError);
        return;
      }

      sendResolution(resolution);
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

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    { timeout: 8_000, interval: 16 },
  );

  if (!element) {
    throw new Error(errorMessage);
  }

  return element;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitForPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  message: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), message).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );

  return pathname;
}

function querySidebarRoot(side: "left" | "right"): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot='sidebar'][data-side='${side}']`);
}

function querySidebarContainer(side: "left" | "right"): HTMLElement | null {
  return (
    querySidebarRoot(side)?.querySelector<HTMLElement>("[data-slot='sidebar-container']") ?? null
  );
}

function querySidebarRail(side: "left" | "right"): HTMLButtonElement | null {
  return (
    querySidebarRoot(side)?.querySelector<HTMLButtonElement>("[data-slot='sidebar-rail']") ?? null
  );
}

function querySidebarThreadRowsByTitle(title: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-slot='sidebar-menu-sub-button']"),
  ).filter((element) => element.textContent?.includes(title) ?? false);
}

function querySidebarThreadRowByTitle(title: string): HTMLElement | null {
  return querySidebarThreadRowsByTitle(title)[0] ?? null;
}

function querySidebarSubButtons(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-slot='sidebar-menu-sub-button']"),
  );
}

function expectSidebarTitleOrder(titles: readonly string[]): void {
  let previousIndex = -1;
  const subButtons = querySidebarSubButtons();

  for (const title of titles) {
    const nextIndex = subButtons.findIndex(
      (element, index) => index > previousIndex && (element.textContent?.includes(title) ?? false),
    );
    expect(
      nextIndex,
      `Expected sidebar item "${title}" after index ${previousIndex}.`,
    ).toBeGreaterThan(previousIndex);
    previousIndex = nextIndex;
  }
}

function querySidebarButtonByText(text: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>("button")).find(
      (element) => element.textContent?.trim() === text,
    ) ?? null
  );
}

function queryProjectButton(projectName: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>("[data-slot='sidebar-menu-button']")).find(
      (element) => element.textContent?.includes(projectName) ?? false,
    ) ?? null
  );
}

function queryButtonByAriaLabel(label: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (element) => element.getAttribute("aria-label") === label,
    ) ?? null
  );
}

async function waitForSidebarThreadRow(title: string): Promise<HTMLElement> {
  return waitForElement(
    () => querySidebarThreadRowByTitle(title),
    `Expected sidebar row titled "${title}" to render.`,
  );
}

function queryMainInset(): HTMLElement | null {
  return document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']");
}

function readSidebarWidth(side: "left" | "right"): number {
  const container = querySidebarContainer(side);
  if (!container) {
    throw new Error(`${side} sidebar container is unavailable.`);
  }

  return container.getBoundingClientRect().width;
}

function readMainInsetWidth(): number {
  const mainInset = queryMainInset();
  if (!mainInset) {
    throw new Error("Main inset is unavailable.");
  }

  return mainInset.getBoundingClientRect().width;
}

async function hoverSidebar(side: "left" | "right"): Promise<void> {
  const container = querySidebarContainer(side);
  if (!container) {
    throw new Error(`${side} sidebar container is unavailable.`);
  }

  container.dispatchEvent(
    new MouseEvent("mouseenter", {
      bubbles: false,
      cancelable: false,
    }),
  );
  await waitForLayout();
}

async function unhoverSidebar(side: "left" | "right"): Promise<void> {
  const container = querySidebarContainer(side);
  if (!container) {
    throw new Error(`${side} sidebar container is unavailable.`);
  }

  container.dispatchEvent(
    new MouseEvent("mouseleave", {
      bubbles: false,
      cancelable: false,
    }),
  );
  await waitForLayout();
}

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  position: { x: number; y: number },
  buttons: number,
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons,
      clientX: position.x,
      clientY: position.y,
    }),
  );
}

function beginResize(rail: HTMLButtonElement): { startX: number; y: number } {
  const rect = rail.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  dispatchPointerEvent(rail, "pointerdown", { x: startX, y }, 1);
  return { startX, y };
}

async function moveResize(
  rail: HTMLButtonElement,
  gesture: { startX: number; y: number },
  nextX: number,
): Promise<void> {
  dispatchPointerEvent(rail, "pointermove", { x: nextX, y: gesture.y }, 1);
  await waitForLayout();
}

async function endResize(
  rail: HTMLButtonElement,
  gesture: { startX: number; y: number },
  endX: number,
): Promise<void> {
  dispatchPointerEvent(rail, "pointerup", { x: endX, y: gesture.y }, 0);
  await waitForLayout();
}

async function mountApp(options: {
  configureFixture?: (fixture: TestFixture) => void;
  height?: number;
  initialEntries: string[];
  width: number;
}): Promise<{
  cleanup: () => Promise<void>;
  host: HTMLDivElement;
  router: ReturnType<typeof getRouter>;
}> {
  fixture = buildFixture();
  options.configureFixture?.(fixture);
  await setViewport(options.width, options.height ?? 1_100);
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
      initialEntries: options.initialEntries,
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

async function dispatchShortcut(options: { key: string; shiftKey?: boolean }): Promise<void> {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: options.key,
      metaKey: isMac,
      ctrlKey: !isMac,
      shiftKey: options.shiftKey ?? false,
      altKey: false,
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitForLayout();
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: [
      ...snapshot.threads,
      createSnapshotThread({
        id: threadId,
        title: "New thread",
        createdAt: "2026-03-11T12:05:00.000Z",
        lastInteractionAt: "2026-03-11T12:05:00.000Z",
        updatedAt: "2026-03-11T12:05:00.000Z",
      }),
    ],
    updatedAt: "2026-03-11T12:05:00.000Z",
  };
}

function seedPersistedDraftStorage(threadId: ThreadId): void {
  localStorage.setItem(
    COMPOSER_DRAFT_STORAGE_KEY,
    JSON.stringify({
      state: {
        draftsByThreadId: {},
        draftThreadsByThreadId: {
          [threadId]: {
            projectId: PROJECT_ID,
            createdAt: "2026-03-10T08:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            envMode: "local",
          },
        },
        projectDraftThreadIdByProjectId: {
          [PROJECT_ID]: threadId,
        },
      },
      version: 1,
    }),
  );
}

function seedAppSettings(settings: Record<string, unknown>): void {
  // Hydrate from the real parsed defaults so new schema fields don't cause
  // the decode to fail silently (which would otherwise fall back to the
  // unconfigured defaults, ignoring the overrides provided here).
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      ...parsePersistedAppSettings(null),
      // Fixtures are dated March 2026, so aging would fold every thread; aging tests opt in.
      sidebarOlderThreadDays: 0,
      ...settings,
    }),
  );
}

/** A project's shelf segment ("3 scheduled", "1 settled"...), optionally within one shelf. */
function queryShelfSegment(
  bucket: "scheduled" | "snoozed" | "settled" | "archived",
  scope: ParentNode = document,
): HTMLButtonElement | null {
  return scope.querySelector<HTMLButtonElement>(
    `[data-testid="sidebar-shelf"] button[data-shelf-bucket="${bucket}"]`,
  );
}

function installDesktopBridgeMock(
  overrides: Partial<
    Pick<
      DesktopBridge,
      "pickFolder" | "showContextMenu" | "confirm" | "openExternal" | "openThreadInNewWindow"
    >
  > = {},
): void {
  const idleUpdateState = {
    channel: "stable" as const,
    enabled: false,
    status: "idle" as const,
    currentVersion: "0.0.0",
    hostArch: "arm64" as const,
    appArch: "arm64" as const,
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
  const desktopBridge = {
    getWsUrl: () => null,
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => {},
    showContextMenu: async () => null,
    openExternal: async () => true,
    onMenuAction: () => noopUnsubscribe,
    getUpdateState: async () => idleUpdateState,
    downloadUpdate: async () => ({
      accepted: false,
      completed: false,
      state: idleUpdateState,
    }),
    installUpdate: async () => ({
      accepted: false,
      completed: false,
      state: idleUpdateState,
    }),
    onUpdateState: () => noopUnsubscribe,
    ...overrides,
  } satisfies Partial<DesktopBridge>;

  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: desktopBridge as DesktopBridge,
  });
}

describe("Thread sidebar", () => {
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
    seedAppSettings({});
    wsRequests.length = 0;
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useWorkflowCreateDialogStore.setState({ projectId: null });
    useRecoveryStateStore.getState().reset();
    useCommandPaletteStore.setState({
      open: false,
      mode: "command",
      openIntent: null,
    });
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
    });
    useThreadSelectionStore.getState().clearSelection();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useRecoveryStateStore.getState().reset();
    useCommandPaletteStore.setState({
      open: false,
      mode: "command",
      openIntent: null,
    });
    useShortcutsDialogStore.setState({ open: false });
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
  });

  it.each(["settled", "snoozed"] as const)(
    "hides running-terminal indicators on %s rows",
    async (section) => {
      const terminal = useTerminalStateStore.getState();
      terminal.ensureTerminal(THREAD_ID, "default");
      terminal.setTerminalActivity(THREAD_ID, "default", true);
      const mounted = await mountApp({
        width: 1400,
        initialEntries: [`/${THREAD_ID}`],
        configureFixture: (next) => {
          next.snapshot = createSnapshot([
            createSnapshotThread({
              id: THREAD_ID,
              title: "Parked conversation",
              ...(section === "settled"
                ? { settledAt: NOW_ISO, settledBy: "user" as const }
                : { snoozedUntil: "2099-01-01T00:00:00.000Z", snoozedAt: NOW_ISO }),
            }),
          ]);
        },
      });
      try {
        const row = page.elementLocator(await waitForSidebarThreadRow("Parked conversation"));
        await expect
          .element(
            row.getByRole("button", {
              name: "Terminal process running. Show terminal",
            }),
          )
          .not.toBeInTheDocument();
      } finally {
        terminal.clearTerminalState(THREAD_ID);
        await mounted.cleanup();
      }
    },
  );

  it("keeps settled threads in a shelf bucket and reachable by their existing route", async () => {
    const mounted = await mountApp({
      width: 1400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (next) => {
        next.snapshot = createSnapshot([
          createSnapshotThread({
            id: THREAD_ID,
            title: "Settled conversation",
            settledAt: NOW_ISO,
            settledBy: "user",
          }),
        ]);
      },
    });
    try {
      const segment = await waitForElement(
        () => queryShelfSegment("settled"),
        "The shelf should offer the settled bucket.",
      );
      expect(segment.textContent).toContain("1 settled");
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
      // The open thread is settled, so its bucket opens on its own.
      await expect.poll(() => segment.getAttribute("aria-expanded")).toBe("true");
      await expect.poll(() => querySidebarThreadRowsByTitle("Settled conversation").length).toBe(1);
      segment.click();
      await expect.poll(() => querySidebarThreadRowsByTitle("Settled conversation").length).toBe(0);
      segment.click();
      await expect.poll(() => querySidebarThreadRowsByTitle("Settled conversation").length).toBe(1);
      const row = page.getByTestId(`thread-row-${THREAD_ID}`);
      await row.hover();
      await page
        .getByRole("button", { name: "Unsettle Settled conversation", exact: true })
        .click();
      await expect
        .poll(() =>
          wsRequests.some(
            (body) =>
              body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (body.command as { type?: string } | undefined)?.type === "thread.unsettle",
          ),
        )
        .toBe(true);
      useStore.getState().syncServerReadModel(
        createSnapshot([
          createSnapshotThread({
            id: THREAD_ID,
            title: "Settled conversation",
            settledAt: null,
            settledBy: null,
          }),
        ]),
      );
      await expect.poll(() => queryShelfSegment("settled")).toBeNull();
      expect(querySidebarThreadRowsByTitle("Settled conversation")).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("groups existing Scheduled threads in the project shelf with status indicators", async () => {
    const scheduled = (id: string, extra: Partial<SnapshotThread> = {}) =>
      createSnapshotThread({
        id: id as ThreadId,
        title: id,
        scheduledOrigin: {
          taskId: ScheduledTaskId.makeUnsafe("task"),
          runId: ScheduledTaskRunId.makeUnsafe(id),
        },
        ...extra,
      });
    const working = scheduled("Scheduled working", {
      session: {
        ...createSnapshotThread({ id: "Scheduled working" as ThreadId }).session!,
        status: "running",
        activeTurnId: "scheduled-turn" as never,
      },
    });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({ id: THREAD_ID, title: "Normal conversation" }),
          working,
          scheduled("Scheduled attention", createPlanReadyOverrides("scheduled")),
          scheduled("Scheduled archived", { archivedAt: NOW_ISO }),
          scheduled("Scheduled snoozed", { snoozedUntil: "2099-01-01T00:00:00.000Z" }),
        ]);
      },
    });
    try {
      await waitForSidebarThreadRow("Normal conversation");
      const toggle = await waitForElement(
        () => queryShelfSegment("scheduled"),
        "The shelf should offer the scheduled bucket",
      );
      const folder = toggle.closest<HTMLElement>('[data-testid="sidebar-shelf"]')!;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.textContent).toContain("4 scheduled");
      expect(toggle.textContent).toContain("Needs attention: 1");
      expect(toggle.textContent).toContain("Running: 1");
      expect(querySidebarThreadRowByTitle("Scheduled working")).toBeNull();
      // Archived and snoozed runs stay inside the scheduled bucket.
      expect(queryShelfSegment("archived")).toBeNull();
      expect(queryShelfSegment("snoozed")).toBeNull();
      toggle.click();
      for (const title of ["Scheduled working", "Scheduled attention", "Scheduled snoozed"]) {
        const row = await waitForElement(
          () =>
            [...folder.querySelectorAll<HTMLElement>('[data-slot="sidebar-menu-sub-button"]')].find(
              (row) => row.textContent?.includes(title),
            ) ?? null,
          "Canonical scheduled row should render",
        );
        expect(folder.contains(row)).toBe(true);
        if (title !== "Scheduled snoozed")
          expect(document.querySelectorAll(`[data-testid="thread-row-${title}"]`)).toHaveLength(1);
      }
      expect(querySidebarThreadRowByTitle("Scheduled archived")).toBeNull();
      const archivedToggle = [...folder.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Archived",
      )!;
      expect(archivedToggle.getAttribute("aria-expanded")).toBe("false");
      archivedToggle.click();
      await waitForSidebarThreadRow("Scheduled archived");
      expect(folder.querySelector('[aria-label="Unarchive Scheduled archived"]')).not.toBeNull();
      archivedToggle.click();
      await vi.waitFor(() => expect(querySidebarThreadRowByTitle("Scheduled archived")).toBeNull());
      expect(querySidebarThreadRowByTitle("Scheduled working")).not.toBeNull();
      toggle.click();
      await vi.waitFor(() => expect(querySidebarThreadRowByTitle("Scheduled working")).toBeNull());
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the Scheduled folder for a selected run beyond the preview and keeps show-more local", async () => {
    seedAppSettings({ sidebarThreadPreviewCount: 5 });
    const selectedId = "scheduled-run-0" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${selectedId}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({ id: THREAD_ID, title: "Normal conversation" }),
          ...Array.from({ length: 8 }, (_, index) =>
            createSnapshotThread({
              id: `scheduled-run-${index}` as ThreadId,
              title: `Scheduled run ${index}`,
              scheduledOrigin: {
                taskId: ScheduledTaskId.makeUnsafe("task"),
                runId: ScheduledTaskRunId.makeUnsafe(`run-${index}`),
              },
            }),
          ),
        ]);
      },
    });
    try {
      const selected = await waitForSidebarThreadRow("Scheduled run 0");
      const folder = selected.closest<HTMLElement>('[data-testid="sidebar-shelf"]')!;
      expect(folder).not.toBeNull();
      expect(queryShelfSegment("scheduled", folder)?.getAttribute("aria-expanded")).toBe("true");
      expect(folder.querySelectorAll("[data-thread-item]")).toHaveLength(6);
      const more = [...folder.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Show all 8"),
      )!;
      more.click();
      await vi.waitFor(() => expect(folder.querySelectorAll("[data-thread-item]")).toHaveLength(8));
      const less = [...folder.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Show less"),
      )!;
      less.click();
      await vi.waitFor(() => expect(folder.querySelectorAll("[data-thread-item]")).toHaveLength(6));
      queryShelfSegment("scheduled", folder)!.click();
      await vi.waitFor(() => expect(querySidebarThreadRowByTitle("Scheduled run 0")).toBeNull());
      expect(querySidebarThreadRowByTitle("Normal conversation")).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([false, true])(
    "keeps Scheduled archive previews independent and reveals selected archives (%s)",
    async (selectArchive) => {
      seedAppSettings({ sidebarThreadPreviewCount: 5 });
      const selectedId = "archived-scheduled-0" as ThreadId;
      const scheduled = (archived: boolean, index: number) =>
        createSnapshotThread({
          id: `${archived ? "archived" : "active"}-scheduled-${index}` as ThreadId,
          title: `${archived ? "Archived" : "Active"} scheduled ${index}`,
          lastInteractionAt: `2026-03-11T11:${String(index).padStart(2, "0")}:00.000Z`,
          archivedAt: archived ? NOW_ISO : null,
          scheduledOrigin: {
            taskId: ScheduledTaskId.makeUnsafe("task"),
            runId: ScheduledTaskRunId.makeUnsafe(`${archived}-${index}`),
          },
        });
      const mounted = await mountApp({
        width: 1_400,
        initialEntries: [`/${selectArchive ? selectedId : THREAD_ID}`],
        configureFixture: (nextFixture) => {
          nextFixture.snapshot = createSnapshot([
            createSnapshotThread({ id: THREAD_ID, title: "Normal conversation" }),
            createSnapshotThread({
              id: "normal-archive" as ThreadId,
              title: "Normal archive",
              archivedAt: NOW_ISO,
            }),
            ...Array.from({ length: 8 }, (_, index) => scheduled(false, index)),
            ...Array.from({ length: 8 }, (_, index) => scheduled(true, index)),
          ]);
        },
      });
      try {
        await waitForSidebarThreadRow(
          selectArchive ? "Archived scheduled 0" : "Normal conversation",
        );
        const toggle = queryShelfSegment("scheduled")!;
        const folder = toggle.closest<HTMLElement>('[data-testid="sidebar-shelf"]')!;
        if (!selectArchive) toggle.click();
        const currentRows = () =>
          folder.querySelectorAll('[data-testid^="thread-row-active-scheduled-"]');
        const archivedRows = () =>
          folder.querySelectorAll('[data-testid^="thread-row-archived-scheduled-"]');
        await vi.waitFor(() => expect(currentRows()).toHaveLength(5));
        const archivedToggle = [...folder.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.trim() === "Archived",
        )!;
        expect(archivedToggle.getAttribute("aria-expanded")).toBe(String(selectArchive));
        expect(archivedRows()).toHaveLength(selectArchive ? 6 : 0);
        if (!selectArchive) archivedToggle.click();
        await vi.waitFor(() => expect(archivedRows()).toHaveLength(selectArchive ? 6 : 5));
        const moreButtons = () =>
          [...folder.querySelectorAll<HTMLButtonElement>("button")].filter(
            (button) => button.textContent?.trim() === "Show all 8",
          );
        expect(moreButtons()).toHaveLength(2);
        moreButtons()[0]!.click();
        await vi.waitFor(() => expect(currentRows()).toHaveLength(8));
        expect(archivedRows()).toHaveLength(selectArchive ? 6 : 5);
        moreButtons()[0]!.click();
        await vi.waitFor(() => expect(archivedRows()).toHaveLength(8));
        archivedToggle.click();
        await vi.waitFor(() => expect(archivedRows()).toHaveLength(0));
        expect(currentRows()).toHaveLength(8);
        expect(querySidebarThreadRowByTitle("Normal archive")).toBeNull();
        // The project's own archive is another shelf bucket; opening it closes Scheduled.
        const otherArchiveToggle = queryShelfSegment("archived", folder)!;
        expect(otherArchiveToggle.textContent).toContain("1 archived");
        expect(otherArchiveToggle.getAttribute("aria-expanded")).toBe("false");
        otherArchiveToggle.click();
        await waitForSidebarThreadRow("Normal archive");
        expect(archivedRows()).toHaveLength(0);
        expect(currentRows()).toHaveLength(0);
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each(["sidebar", "header"] as const)(
    "opens the source scheduler editor from the %s thread menu",
    async (surface) => {
      const taskId = ScheduledTaskId.makeUnsafe("source-task");
      const task = {
        id: taskId,
        projectId: PROJECT_ID,
        name: "Daily source task",
        prompt: "Check project",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        runtimeMode: "approval-required",
        workspace: { kind: "projectRoot" },
        cron: "0 9 * * *",
        timezone: "UTC",
        scheduleSource: "daily",
        maxRuns: null,
        oneShotAt: null,
        notify: "all",
        enabled: false,
        version: 1,
        createdBy: "user",
        authority: { kind: "user" },
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        nextRunAt: null,
        lastRunAt: null,
        runsConsumed: 0,
      };
      const nativeMenu = vi.fn(
        async (
          _items: ReadonlyArray<{ id: string; label: string }>,
          _position?: { x: number; y: number },
        ) => "edit-schedule",
      );
      if (surface === "sidebar")
        installDesktopBridgeMock({
          showContextMenu: nativeMenu as DesktopBridge["showContextMenu"],
        });
      const mounted = await mountApp({
        width: 1_400,
        initialEntries: [`/${THREAD_ID}`],
        configureFixture: (nextFixture) => {
          nextFixture.snapshot = createSnapshot([
            createSnapshotThread({
              id: THREAD_ID,
              title: "Renamed execution",
              scheduledOrigin: { taskId, runId: ScheduledTaskRunId.makeUnsafe("run") },
            }),
          ]);
          nextFixture.resolveWsRequest = (body) =>
            body._tag === SCHEDULED_TASK_WS_METHODS.list
              ? {
                  type: "result",
                  result: { revision: 0, tasks: [{ task, latestRun: null, activeRun: null }] },
                }
              : null;
        },
      });
      try {
        await waitForSidebarThreadRow("Renamed execution");
        if (surface === "sidebar") {
          await page.getByTestId(`thread-row-${THREAD_ID}`).click({ button: "right" });
          await vi.waitFor(() => expect(nativeMenu).toHaveBeenCalled());
          expect(nativeMenu.mock.calls[0]![0]).toEqual(
            expect.arrayContaining([
              {
                id: "scheduled-origin",
                label: "Scheduled task: Daily source task",
                disabled: true,
              },
              { id: "edit-schedule", label: "Edit scheduled task…" },
              { id: "rename", label: "Rename thread", separatorBefore: true, icon: "pencil" },
            ]),
          );
        } else {
          await page.getByRole("button", { name: "Thread actions", exact: true }).click();
          await expect
            .element(
              page.getByRole("menuitem", {
                name: "Scheduled task: Daily source task",
                exact: true,
              }),
            )
            .toBeDisabled();
          await page.getByRole("menuitem", { name: "Edit scheduled task…", exact: true }).click();
        }
        await expect
          .element(page.getByRole("dialog", { name: "Edit scheduled task" }))
          .toBeVisible();
        await expect
          .element(page.getByRole("textbox", { name: "Task name" }))
          .toHaveValue("Daily source task");
        expect(mounted.router.state.location.pathname).toBe("/scheduled");
        await vi.waitFor(() => expect(mounted.router.state.location.search).toEqual({ taskId }));
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps removed source scheduling attribution without offering editing", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({
            id: THREAD_ID,
            title: "Retained run",
            scheduledOrigin: {
              taskId: ScheduledTaskId.makeUnsafe("removed"),
              runId: ScheduledTaskRunId.makeUnsafe("run"),
            },
          }),
        ]);
      },
    });
    try {
      await waitForSidebarThreadRow("Retained run");
      await page.getByRole("button", { name: "Thread actions", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Scheduled task removed", exact: true }))
        .toBeDisabled();
      await expect
        .element(page.getByRole("menuitem", { name: "Edit scheduled task…", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitem", { name: "Rename thread", exact: true }))
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("marks every Scheduled execution read from the folder menu, including hidden runs", async () => {
    seedAppSettings({ sidebarThreadPreviewCount: 5 });
    const completed = {
      turnId: TurnId.makeUnsafe("completed"),
      state: "completed" as const,
      requestedAt: NOW_ISO,
      startedAt: NOW_ISO,
      completedAt: "2026-03-11T12:05:00.000Z",
      assistantMessageId: null,
    };
    const run = (index: number) =>
      createSnapshotThread({
        id: `bulk-read-run-${index}` as ThreadId,
        title: `Bulk read run ${index}`,
        latestTurn: completed,
        scheduledOrigin: {
          taskId: ScheduledTaskId.makeUnsafe("bulk-read-task"),
          runId: ScheduledTaskRunId.makeUnsafe(`run-${index}`),
        },
      });
    const initialThreads = [
      createSnapshotThread({ id: THREAD_ID, title: "Open conversation" }),
      createSnapshotThread({
        id: "other-unread" as ThreadId,
        title: "Other unread",
        latestTurn: completed,
      }),
      ...Array.from({ length: 8 }, (_, index) => run(index)),
    ];
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot(initialThreads);
      },
    });
    try {
      const toggle = await waitForElement(
        () => queryShelfSegment("scheduled"),
        "Scheduled shelf segment should appear",
      );
      const folder = toggle.closest<HTMLElement>('[data-testid="sidebar-shelf"]')!;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(folder.textContent).toContain("Unread: 8");
      toggle.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 200,
          clientY: 200,
        }),
      );
      await page.getByRole("menuitem", { name: "Mark all as read", exact: true }).click();
      await vi.waitFor(() => {
        const runs = useStore.getState().threads.filter((thread) => thread.scheduledOrigin);
        expect(runs).toHaveLength(8);
        expect(runs.every((thread) => !hasUnseenCompletion(thread))).toBe(true);
        expect(folder.textContent).not.toContain("Unread:");
      });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(
        hasUnseenCompletion(
          useStore.getState().threads.find((thread) => thread.id === "other-unread")!,
        ),
      ).toBe(true);
      window.dispatchEvent(new Event("beforeunload"));
      const persisted = JSON.parse(localStorage.getItem("t3code:renderer-state:v8")!);
      for (let index = 0; index < 8; index++)
        expect(
          Date.parse(persisted.lastVisitedAtByThreadId[`bulk-read-run-${index}`]),
        ).toBeGreaterThanOrEqual(Date.parse(completed.completedAt));
      useStore.getState().syncServerReadModel(createSnapshot([...initialThreads, run(8)]));
      await vi.waitFor(() => expect(folder.textContent).toContain("Unread: 1"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not invalidate an in-flight startup snapshot for a rejected profile welcome", async () => {
    const startupResponse = createDeferred<WsRequestResolution>();
    let socket: TestWsClient | undefined;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body, client) => {
          if (body._tag !== ORCHESTRATION_WS_METHODS.getStartupSnapshot) return null;
          socket = client;
          return startupResponse.promise;
        };
      },
    });
    const previousProfile = useProfileState.getState();
    try {
      // The startup request can take over a second to arrive on a loaded runner.
      await vi.waitFor(() => expect(socket).toBeDefined(), { timeout: 8_000, interval: 16 });
      const profile = {
        id: ProfileId.makeUnsafe("1".repeat(32)),
        slug: "one",
        name: "One",
        port: 3773,
        isDefault: true,
        status: "ready" as const,
        createdAt: NOW_ISO,
        stateDir: "/test/profile",
        isActive: true,
        providerAccounts: [],
      };
      useProfileState.setState({ active: profile, mismatch: false });
      socket!.send(
        JSON.stringify({
          type: "push",
          sequence: 2,
          channel: WS_CHANNELS.serverWelcome,
          data: {
            ...fixture.welcome,
            bootstrap: serverBootstrapFixture,
            profile: { ...profile, id: "2".repeat(32) },
          },
        }),
      );
      await vi.waitFor(() => expect(useProfileState.getState().mismatch).toBe(true));
      startupResponse.resolve({
        type: "result",
        result: { snapshot: fixture.snapshot, threadTailDetails: null },
      });
      await vi.waitFor(() => expect(useStore.getState().threadsHydrated).toBe(true));
      expect(
        wsRequests.filter(
          (request) => request._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot,
        ),
      ).toHaveLength(1);
    } finally {
      useProfileState.setState(previousProfile);
      await mounted.cleanup();
    }
  });

  it("shows startup skeletons until the initial snapshot and recovery complete", async () => {
    seedAppSettings({ onboardingLiteStatus: "dismissed" });
    const emptySnapshot = createEmptySnapshot();
    const startupResponse = createDeferred<WsRequestResolution>();
    let socket: TestWsClient | undefined;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = emptySnapshot;
        nextFixture.welcome = { cwd: "/repo/project", projectName: "Project" };
        nextFixture.resolveWsRequest = (body, client) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot) {
            socket = client;
            return startupResponse.promise;
          }
          return null;
        };
      },
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="startup-sidebar-skeleton"]'),
        "Sidebar startup skeleton should render while the startup snapshot is pending.",
      );
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="home-startup-skeleton"]'),
        "Home startup skeleton should render while the startup snapshot is pending.",
      );
      expect(document.body.textContent).not.toContain("No projects yet");
      expect(document.body.textContent).not.toContain("Add a project to get started.");

      // The shared transport can replay a previous fixture's bootstrap thread.
      // Publish this empty server's welcome before completing its recovery.
      await vi.waitFor(() => expect(socket).toBeDefined());
      socket!.send(
        JSON.stringify({
          type: "push",
          sequence: 3,
          channel: WS_CHANNELS.serverWelcome,
          data: { ...fixture.welcome, bootstrap: serverBootstrapFixture },
        }),
      );
      startupResponse.resolve({
        type: "result",
        result: {
          snapshot: emptySnapshot,
          threadTailDetails: null,
        },
      });

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="startup-sidebar-skeleton"]')).toBeNull();
        expect(document.querySelector('[data-testid="home-startup-skeleton"]')).toBeNull();
        expect(document.body.textContent).toContain("No projects yet");
        expect(document.querySelector('[data-slot="home-quick-start"]')).not.toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([false, true])(
    "starts and reuses a scratch draft from primary sidebar actions (projects: %s)",
    async (hasProjects) => {
      seedAppSettings({ onboardingLiteStatus: "dismissed" });
      localStorage.setItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, String(THREAD_SIDEBAR_MIN_WIDTH_PX));
      const scratchProjectId = "5c7a0e3b-0d2f-5a51-8f00-000000000001" as ProjectId;
      let ensureCalls = 0;
      const mounted = await mountApp({
        width: 1_400,
        initialEntries: ["/"],
        configureFixture: (nextFixture) => {
          nextFixture.snapshot = hasProjects
            ? { ...createEmptySnapshot(), projects: [createSnapshotProject(PROJECT_ID, "Alpha")] }
            : createEmptySnapshot();
          nextFixture.welcome = {
            cwd: nextFixture.welcome.cwd,
            projectName: nextFixture.welcome.projectName,
          };
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: createSidebarShortcutBindings(),
          };
          nextFixture.resolveWsRequest = (body) => {
            if (body._tag !== WS_METHODS.projectsEnsureScratch) return null;
            ensureCalls += 1;
            // The project.created event lands after the reply, as it would over the socket.
            setTimeout(() =>
              useStore.setState((state) => ({
                projects: [
                  ...state.projects,
                  {
                    id: scratchProjectId,
                    kind: "scratch",
                    name: "No project",
                    cwd: "/state/scratch",
                    model: "gpt-5",
                    createdAt: NOW_ISO,
                    expanded: true,
                    scripts: [],
                    memories: [],
                  },
                ],
              })),
            );
            return { type: "result", result: { projectId: scratchProjectId } };
          };
        },
      });

      try {
        if (!hasProjects) {
          await expect.element(page.getByText("No projects yet", { exact: true })).toBeVisible();
        }
        const start = await waitForElement(() => {
          const button = document.querySelector<HTMLButtonElement>(
            hasProjects
              ? '[data-testid="sidebar-new-scratch-thread"]'
              : '[data-testid="sidebar-new-thread"]',
          );
          return button && !button.disabled ? button : null;
        }, "The sidebar offers a thread without a project.");
        const primary = document.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-new-thread"]',
        )!;
        expect(readSidebarWidth("left")).toBe(THREAD_SIDEBAR_MIN_WIDTH_PX);
        const label = primary.querySelector<HTMLSpanElement>("span.flex-1")!;
        expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
        const shortcut = primary.querySelector("kbd")!;
        expect(shortcut.textContent).toBeTruthy();
        expect(shortcut.getBoundingClientRect().right).toBeLessThanOrEqual(
          primary.getBoundingClientRect().right,
        );
        start.click();
        start.click();
        await vi.waitFor(() => expect(ensureCalls).toBe(1), { timeout: 8_000 });
        await vi.waitFor(() => {
          const drafts = Object.values(useComposerDraftStore.getState().draftThreadsByThreadId);
          expect(drafts).toEqual([
            expect.objectContaining({
              projectId: scratchProjectId,
              branch: null,
              worktreePath: null,
              envMode: "local",
            }),
          ]);
        });
        expect(ensureCalls).toBe(1);
        await vi.waitFor(() => expect(document.body.textContent).not.toContain("No projects yet"));
        if (!hasProjects)
          expect(document.querySelector('[data-testid="sidebar-new-scratch-thread"]')).toBeNull();
        const tree = document.querySelector('[role="tree"][aria-label="Threads and projects"]')!;
        const first = tree.querySelector('[role="treeitem"]')!;
        expect(first.textContent).toContain("No project");
        expect(first.hasAttribute("aria-roledescription")).toBe(false);
        if (hasProjects) {
          useStore.getState().setProjectExpanded(scratchProjectId, false);
          await expect
            .element(page.elementLocator(first))
            .toHaveAttribute("aria-expanded", "false");
          document
            .querySelector<HTMLButtonElement>('[data-testid="sidebar-new-scratch-thread"]')!
            .click();
          await vi.waitFor(() =>
            expect(
              Object.values(useComposerDraftStore.getState().draftThreadsByThreadId),
            ).toHaveLength(1),
          );
          expect(ensureCalls).toBe(1);
          await expect.element(page.elementLocator(first)).toHaveAttribute("aria-expanded", "true");
        }
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("navigates between the static scratch group and sortable projects with arrow keys", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createEmptySnapshot(),
          projects: [
            createSnapshotProject(PROJECT_ID, "Alpha"),
            {
              ...createSnapshotProject("scratch-project" as ProjectId, "No project"),
              kind: "scratch",
              workspaceRoot: "/state/scratch",
            },
          ],
        };
        nextFixture.welcome = {
          cwd: nextFixture.welcome.cwd,
          projectName: nextFixture.welcome.projectName,
        };
      },
    });
    try {
      const scratch = await waitForElement(
        () => queryProjectButton("No project"),
        "The scratch group renders.",
      );
      scratch.focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(queryProjectButton("Alpha"));
      await userEvent.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(scratch);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders live project rows instead of the sidebar skeleton before startup hydration", async () => {
    const startupResponse = createDeferred<WsRequestResolution>();
    useStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          name: "Project",
          cwd: "/repo/project",
          model: "gpt-5",
          createdAt: NOW_ISO,
          expanded: true,
          scripts: [],
          memories: [],
        },
      ],
      threads: [],
      threadsHydrated: false,
    });

    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot) {
            return startupResponse.promise;
          }
          return null;
        };
      },
    });

    try {
      await waitForElement(
        () => queryProjectButton("Project"),
        "Project row should render from live state before startup hydration.",
      );
      expect(document.querySelector('[data-testid="startup-sidebar-skeleton"]')).toBeNull();
      const scratch = document.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-new-scratch-thread"]',
      )!;
      expect(scratch.disabled).toBe(true);
      scratch.click();
      expect(wsRequests.some((body) => body._tag === WS_METHODS.projectsEnsureScratch)).toBe(false);
    } finally {
      startupResponse.resolve({
        type: "result",
        result: {
          snapshot: fixture.snapshot,
          threadTailDetails: null,
        },
      });
      await mounted.cleanup();
    }
  });

  it.each([false, true])(
    "blocks scratch shortcuts before synchronization (disconnected: %s)",
    async (disconnected) => {
      const startupResponse = createDeferred<WsRequestResolution>();
      const mounted = await mountApp({
        width: 1_400,
        initialEntries: ["/"],
        configureFixture: (nextFixture) => {
          nextFixture.snapshot = createEmptySnapshot();
          nextFixture.welcome = {
            cwd: nextFixture.welcome.cwd,
            projectName: nextFixture.welcome.projectName,
          };
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              ...createSidebarShortcutBindings(),
              { command: "chat.newScratch", shortcut: createShortcut("s", { shiftKey: true }) },
            ],
          };
          nextFixture.resolveWsRequest = (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot
              ? startupResponse.promise
              : null;
        },
      });
      try {
        const toast = vi.spyOn(toastManager, "add");
        await waitForElement(
          () =>
            wsRequests.some((body) => body._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot)
              ? document.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-thread"]')
              : null,
          "Startup snapshot is pending.",
        );
        if (disconnected) noteWsConnectionClosed();
        await expect.element(page.getByTestId("sidebar-new-thread")).toBeDisabled();
        await dispatchShortcut({ key: "n" });
        await dispatchShortcut({ key: "s", shiftKey: true });
        expect(wsRequests.some((body) => body._tag === WS_METHODS.projectsEnsureScratch)).toBe(
          false,
        );
        expect(Object.values(useComposerDraftStore.getState().draftThreadsByThreadId)).toHaveLength(
          0,
        );
        expect(toast).not.toHaveBeenCalled();
      } finally {
        // The fixture reuses its transport across mounts; restore the simulated connection.
        if (disconnected) {
          noteWsConnectionOpened();
          noteWsSynchronized();
        }
        startupResponse.resolve({
          type: "result",
          result: { snapshot: fixture.snapshot, threadTailDetails: null },
        });
        await mounted.cleanup();
      }
    },
  );

  it("suppresses the sidebar skeleton while the add-project path entry is open", async () => {
    const startupResponse = createDeferred<WsRequestResolution>();
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createEmptySnapshot();
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot) {
            return startupResponse.promise;
          }
          return null;
        };
      },
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="startup-sidebar-skeleton"]'),
        "Sidebar startup skeleton should render before opening the add-project form.",
      );

      const addProjectButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Add project"]'),
        "Add project button should render.",
      );
      addProjectButton.click();

      await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="/path/to/project"]'),
        "Project path entry should render.",
      );
      expect(document.querySelector('[data-testid="startup-sidebar-skeleton"]')).toBeNull();
    } finally {
      startupResponse.resolve({
        type: "result",
        result: {
          snapshot: fixture.snapshot,
          threadTailDetails: null,
        },
      });
      await mounted.cleanup();
    }
  });

  it("shows the planning workflow startup skeleton before loaded-missing copy", async () => {
    const emptySnapshot = createEmptySnapshot();
    const startupResponse = createDeferred<WsRequestResolution>();
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/workflow/missing-workflow"],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = emptySnapshot;
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot) {
            return startupResponse.promise;
          }
          return null;
        };
      },
    });

    try {
      await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="startup-workflow-skeleton"][data-kind="planning"]',
          ),
        "Planning workflow startup skeleton should render while startup is pending.",
      );
      expect(document.body.textContent).not.toContain("Workflow not found.");

      startupResponse.resolve({
        type: "result",
        result: {
          snapshot: emptySnapshot,
          threadTailDetails: null,
        },
      });

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="startup-workflow-skeleton"]')).toBeNull();
        expect(document.body.textContent).toContain("Workflow not found.");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the code review workflow startup skeleton before loaded-missing copy", async () => {
    const emptySnapshot = createEmptySnapshot();
    const startupResponse = createDeferred<WsRequestResolution>();
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/code-review/missing-review-workflow"],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = emptySnapshot;
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot) {
            return startupResponse.promise;
          }
          return null;
        };
      },
    });

    try {
      await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="startup-workflow-skeleton"][data-kind="code-review"]',
          ),
        "Code review workflow startup skeleton should render while startup is pending.",
      );
      expect(document.body.textContent).not.toContain("Workflow not found.");

      startupResponse.resolve({
        type: "result",
        result: {
          snapshot: emptySnapshot,
          threadTailDetails: null,
        },
      });

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="startup-workflow-skeleton"]')).toBeNull();
        expect(document.body.textContent).toContain("Workflow not found.");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("resizes immediately, preserves the width across routes, and resets on double-click", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: createSidebarShortcutBindings(),
        };
      },
    });

    try {
      const wrapper = await waitForElement(
        () => mounted.host.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']"),
        "Sidebar wrapper should render.",
      );
      expect(queryMainInset()).toBeTruthy();
      expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("256px");

      const rail = await waitForElement(
        () => querySidebarRail("left"),
        "Left sidebar rail should render.",
      );
      const beforeSidebarWidth = readSidebarWidth("left");
      const beforeMainWidth = readMainInsetWidth();
      const gesture = beginResize(rail);

      await moveResize(rail, gesture, gesture.startX + 120);

      const duringSidebarWidth = readSidebarWidth("left");
      const duringMainWidth = readMainInsetWidth();
      expect(duringSidebarWidth).toBeGreaterThan(beforeSidebarWidth + 80);
      expect(duringMainWidth).toBeLessThan(beforeMainWidth - 80);

      await endResize(rail, gesture, gesture.startX + 120);
      expect(localStorage.getItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY)).toBeTruthy();

      await mounted.router.navigate({ to: "/" });
      await waitForLayout();
      await waitForElement(() => queryMainInset(), "Home route main inset should render.");

      expect(readSidebarWidth("left")).toBeCloseTo(duringSidebarWidth, 0);

      rail.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 }));
      await vi.waitFor(() => {
        expect(readSidebarWidth("left")).toBeCloseTo(THREAD_SIDEBAR_DEFAULT_WIDTH_PX, 0);
        expect(localStorage.getItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY)).toBe(
          String(THREAD_SIDEBAR_DEFAULT_WIDTH_PX),
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the persisted width on mount and clamps persisted values into range", async () => {
    localStorage.setItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, "320");
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: createSidebarShortcutBindings(),
        };
      },
    });

    try {
      const wrapper = await waitForElement(
        () => mounted.host.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']"),
        "Sidebar wrapper should render.",
      );
      expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("320px");
      expect(readSidebarWidth("left")).toBeCloseTo(320, 0);
    } finally {
      await mounted.cleanup();
    }

    localStorage.setItem(
      THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
      String(THREAD_SIDEBAR_MAX_WIDTH_PX + 256),
    );
    const clampedMount = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
    });

    try {
      const wrapper = await waitForElement(
        () => clampedMount.host.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']"),
        "Sidebar wrapper should render.",
      );
      expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe(
        `${THREAD_SIDEBAR_MAX_WIDTH_PX}px`,
      );
      expect(readSidebarWidth("left")).toBeCloseTo(THREAD_SIDEBAR_MAX_WIDTH_PX, 0);
    } finally {
      await clampedMount.cleanup();
    }
  });

  it.each([
    "/bots",
    "/bots?task=old-task",
    "/bots?fromThread=old-thread",
    "/bots?task=old-task&fromThread=old-thread",
  ])("redirects the hidden Bots link %s to Home without adding history", async (url) => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/settings"],
    });
    try {
      // Finish startup first so the fixture's bootstrap thread cannot replace Home.
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          unsubscribe();
          window.clearTimeout(timeout);
        };
        const unsubscribe = useRecoveryStateStore.subscribe((state) => {
          if (state.recoveryEpoch > 0) {
            cleanup();
            resolve();
          }
        });
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("Startup recovery did not complete."));
        }, 10_000);
        if (useRecoveryStateStore.getState().recoveryEpoch > 0) {
          cleanup();
          resolve();
        }
      });
      await mounted.router.navigate({ href: url });
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/");
        expect(mounted.router.state.location.search).toEqual({});
      });
      expect(mounted.router.history.location.href).toBe("/");
      expect(document.body.textContent).not.toContain("Bot tasks");
      mounted.router.history.back();
      await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/settings"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves search and action prefixes when pasting quoted paths into the palette", async () => {
    const mounted = await mountApp({ width: 1_400, initialEntries: ["/"] });
    const input = () =>
      document.querySelector<HTMLInputElement>('[data-testid="command-palette"] input');
    try {
      useCommandPaletteStore.getState().toggleOpen();
      const field = await waitForElement(input, "Command palette input should render.");
      setInputValue(field, "?");
      await vi.waitFor(() => expect(input()?.value).toBe("?"));
      setInputValue(input()!, '?"/api/v1/users"');
      await vi.waitFor(() => {
        expect(input()?.value).toBe('?"/api/v1/users"');
        expect(
          document.querySelector<HTMLElement>('[data-testid="command-palette"]')?.dataset
            .paletteMode,
        ).toBe("content");
      });

      setInputValue(input()!, ">");
      await vi.waitFor(() => expect(input()?.value).toBe(">"));
      setInputValue(input()!, ">'/etc/hosts'");
      await vi.waitFor(() => expect(input()?.value).toBe(">'/etc/hosts'"));

      // Folder browsing still normalizes a paste after a prefilled directory.
      setInputValue(input()!, "~/");
      await vi.waitFor(() => expect(input()?.value).toBe("~/"));
      setInputValue(input()!, "~/'/My Projects'");
      await vi.waitFor(() => expect(input()?.value).toBe("/My Projects"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the command palette from the sidebar search input", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            ...createSidebarShortcutBindings(),
            {
              command: "commandPalette.toggle",
              shortcut: createShortcut("k"),
            },
          ],
        };
      },
    });

    try {
      const navigation = await waitForElement(
        () => document.querySelector<HTMLElement>('nav[aria-label="Primary"]'),
        "The nav strip should render.",
      );
      // The strip is pinned above the scroll area, like the New thread row.
      expect(navigation.closest('[data-sidebar="content"]')).toBeNull();
      const navLabels = [...navigation.querySelectorAll("button[aria-label]")].map((button) =>
        button.getAttribute("aria-label"),
      );
      expect(navLabels).toEqual([
        "Home",
        "Search threads",
        "Pull requests",
        "Scheduled",
        "Usage",
        "Projects",
        "Recent",
      ]);
      // The flex-1/min-w-0 icon buttons only get width from the strip's layout; guard it, since
      // DOM presence alone passed while 0.1.9 rendered Pull requests and Usage at 0px.
      for (const button of navigation.querySelectorAll<HTMLElement>("button[aria-label]")) {
        expect(
          button.getBoundingClientRect().width,
          `${button.getAttribute("aria-label")} width`,
        ).toBeGreaterThan(0);
      }
      const footer = document.querySelector('[data-sidebar="footer"]')!;
      expect(footer.querySelector('[aria-label="Usage"]')).toBeNull();
      expect(footer.querySelector('[aria-label="Pull requests"]')).toBeNull();
      // The notifications bell lives in the title bar, beside the profile switcher.
      const bell = document.querySelector('[data-testid="sidebar-notifications"]');
      expect(bell).toBeInstanceOf(HTMLElement);
      expect(bell!.closest('[data-sidebar="header"]')).not.toBeNull();
      expect(navigation.contains(bell)).toBe(false);
      // The view toggle lives in the strip; the Projects label carries Add project.
      expect(
        navigation.querySelector('[role="radiogroup"] [data-testid="sidebar-view-projects"]'),
      ).not.toBeNull();
      expect(document.querySelector('[data-testid="sidebar-projects-label"]')?.textContent).toBe(
        "Projects",
      );
      // Home's quick-start bar has an Add project button of its own.
      const sidebarAddProject = () =>
        document.querySelector('[data-slot="sidebar"] button[aria-label="Add project"]');
      expect(sidebarAddProject()).not.toBeNull();
      const recentToggle = navigation.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-view-recent"]',
      )!;
      const projectsToggle = navigation.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-view-projects"]',
      )!;
      projectsToggle.focus();
      projectsToggle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(recentToggle.getAttribute("aria-checked")).toBe("true"));
      expect(document.activeElement).toBe(recentToggle);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="sidebar-projects-label"]')).toBeNull(),
      );
      expect(sidebarAddProject()).toBeNull();
      recentToggle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(projectsToggle.getAttribute("aria-checked")).toBe("true"));
      const homeButton = navigation.querySelector<HTMLButtonElement>('[aria-label="Home"]')!;
      const usageButton = navigation.querySelector<HTMLButtonElement>('[aria-label="Usage"]')!;
      expect(usageButton.hasAttribute("aria-current")).toBe(false);
      usageButton.click();
      await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/usage"));
      await vi.waitFor(() => expect(usageButton.getAttribute("aria-current")).toBe("page"));
      await vi.waitFor(() =>
        expect(document.querySelector('[data-sidebar="footer"]')?.textContent).toContain("Back"),
      );
      expect(homeButton.hasAttribute("aria-current")).toBe(false);
      // Pull requests is marked in the strip, so its page keeps Settings in the footer.
      const pullRequestsButton = navigation.querySelector<HTMLButtonElement>(
        '[aria-label="Pull requests"]',
      )!;
      expect(pullRequestsButton.hasAttribute("aria-current")).toBe(false);
      pullRequestsButton.click();
      await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/pull-requests"));
      await vi.waitFor(() => expect(pullRequestsButton.getAttribute("aria-current")).toBe("page"));
      expect(usageButton.hasAttribute("aria-current")).toBe(false);
      await vi.waitFor(() => {
        const footerText = document.querySelector('[data-sidebar="footer"]')?.textContent;
        expect(footerText).toContain("Settings");
        expect(footerText).not.toContain("Back");
      });
      expect(navigation.textContent).not.toContain("Bots");

      // The search field stays hidden until the Search button opens it, focused.
      expect(document.querySelector('[data-testid="sidebar-thread-search-input"]')).toBeNull();
      const searchToggle = navigation.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-search-toggle"]',
      )!;
      expect(searchToggle.getAttribute("aria-pressed")).toBe("false");
      searchToggle.click();
      const searchInput = await waitForElement(
        () =>
          document.querySelector<HTMLInputElement>('[data-testid="sidebar-thread-search-input"]'),
        "Sidebar thread search input should render.",
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(searchInput));
      expect(searchToggle.getAttribute("aria-pressed")).toBe("true");

      // Escape on the empty field closes it and returns focus to the Search button.
      searchInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="sidebar-thread-search-input"]')).toBeNull(),
      );
      expect(document.activeElement).toBe(searchToggle);

      searchToggle.click();
      const trigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="command-palette-trigger"]'),
        "Sidebar full-search button should render.",
      );
      expect(
        Boolean(homeButton.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);
      expect(
        document.querySelector<HTMLInputElement>('[data-testid="sidebar-thread-search-input"]')
          ?.placeholder,
      ).toBe("Search");
      expect(trigger.getAttribute("aria-label")).toBe("Open full search");
      expect(trigger.querySelector("kbd")?.textContent?.trim()).toBeTruthy();

      trigger.click();

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="command-palette"]'),
        "Command palette should open from the sidebar search button.",
      );
      await waitForElement(
        () => document.querySelector<HTMLInputElement>('[data-testid="command-palette"] input'),
        "Command palette root search input should render.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the keyboard shortcuts dialog from mod+/, the sidebar footer and the palette", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            ...createSidebarShortcutBindings(),
            { command: "commandPalette.toggle", shortcut: createShortcut("k") },
            { command: "help.shortcuts", shortcut: createShortcut("/") },
          ],
        };
      },
    });
    const findDialog = () =>
      document.querySelector<HTMLElement>('[data-testid="shortcuts-dialog"]');
    const waitForDialogClosed = () =>
      vi.waitFor(() => expect(findDialog()).toBeNull(), { timeout: 4_000, interval: 16 });

    try {
      const footerButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Keyboard shortcuts"]'),
        "The sidebar footer should offer a shortcuts button.",
      );
      // Keybindings arrive with the server config; retry until the shortcut lands.
      await vi.waitFor(
        async () => {
          if (!useShortcutsDialogStore.getState().open) {
            await dispatchShortcut({ key: "/" });
          }
          expect(useShortcutsDialogStore.getState().open).toBe(true);
        },
        { timeout: 4_000, interval: 50 },
      );
      const dialog = await waitForElement(findDialog, "mod+/ should open the shortcuts dialog.");
      expect(dialog.textContent).toContain("Keyboard shortcuts");
      const paletteRow = await waitForElement(
        () => dialog.querySelector<HTMLElement>('[data-shortcut-command="commandPalette.toggle"]'),
        "The palette binding should be listed.",
      );
      expect(paletteRow.textContent).toContain("Toggle command palette");

      const filter = dialog.querySelector<HTMLInputElement>('input[aria-label="Filter shortcuts"]');
      expect(filter).not.toBeNull();
      await page.getByRole("textbox", { name: "Filter shortcuts" }).fill("zzz-no-match");
      await vi.waitFor(() => expect(dialog.textContent).toContain("No shortcuts match"));

      await dispatchShortcut({ key: "/" });
      await waitForDialogClosed();

      footerButton.click();
      await waitForElement(findDialog, "The sidebar footer button should open the dialog.");
      await userEvent.keyboard("{Escape}");
      await waitForDialogClosed();

      await dispatchShortcut({ key: "k" });
      const paletteInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('[data-testid="command-palette"] input'),
        "Command palette should open.",
      );
      await page.elementLocator(paletteInput).fill("keyboard shortcuts");
      await page.getByText("Show keyboard shortcuts", { exact: true }).click();
      await waitForElement(findDialog, "The palette action should open the dialog.");
    } finally {
      await mounted.cleanup();
    }
  });

  it("virtualizes long palette results and runs an off-screen row from the keyboard", async () => {
    const matchCount = 60;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag !== WS_METHODS.projectsSearchContents) return null;
          return {
            type: "result",
            result: {
              requestId: body.requestId,
              matches: Array.from({ length: matchCount }, (_, index) => ({
                path: `src/match-${index}.ts`,
                lineNumber: 1,
                lineContent: "const needle = true;",
                matchRanges: [{ start: 6, end: 12 }],
              })),
              truncated: false,
              indexedPathCount: matchCount,
              indexTruncated: false,
            },
          };
        };
      },
    });

    try {
      useCommandPaletteStore.getState().toggleMode("content");
      const palette = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="command-palette"][data-palette-mode="content"]',
          ),
        "Content palette should open in content mode.",
      );
      const input = palette.querySelector<HTMLInputElement>("input");
      if (!input) throw new Error("Content palette input should render.");
      setInputValue(input, "needle");
      await vi.waitFor(() => expect(palette.textContent).toContain("src/match-0.ts:1"), {
        timeout: 4_000,
        interval: 16,
      });

      const renderedRows = () => palette.querySelectorAll('[data-slot="command-item"]').length;
      expect(renderedRows()).toBeGreaterThan(0);
      expect(renderedRows()).toBeLessThan(matchCount);

      input.focus();
      await vi.waitFor(() => expect(document.activeElement).toBe(input));
      for (let step = 1; step < matchCount; step += 1) {
        await userEvent.keyboard("{ArrowDown}");
      }
      const lastRow = await waitForElement(
        () =>
          Array.from(palette.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).find(
            (row) => row.textContent?.includes(`src/match-${matchCount - 1}.ts:1`),
          ) ?? null,
        "Arrowing to the last match should mount its row.",
      );
      await vi.waitFor(() => expect(lastRow.hasAttribute("data-highlighted")).toBe(true));

      await userEvent.keyboard("{Enter}");
      await vi.waitFor(
        () =>
          expect(JSON.stringify(mounted.router.state.location.search)).toContain(
            `src/match-${matchCount - 1}.ts`,
          ),
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches project files and contents from dedicated palette modes", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag !== WS_METHODS.projectsSearchContents) return null;
          return {
            type: "result",
            result: {
              requestId: body.requestId,
              matches: [
                {
                  path: "src/search.ts",
                  lineNumber: 7,
                  lineContent: "const needle = true;",
                  matchRanges: [{ start: 6, end: 12 }],
                },
              ],
              truncated: false,
              indexedPathCount: 42,
              indexTruncated: false,
            },
          };
        };
      },
    });

    try {
      useCommandPaletteStore.getState().toggleMode("files");
      const filePalette = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="command-palette"][data-palette-mode="files"]',
          ),
        "File palette should open in file mode.",
      );
      expect(filePalette.querySelector('[aria-label="Search project"]')?.textContent).toContain(
        "Project",
      );
      const fileInput = filePalette.querySelector<HTMLInputElement>("input");
      if (!fileInput) throw new Error("File palette input should render.");
      setInputValue(fileInput, "src");
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.projectsSearchEntries &&
                request.cwd === "/repo/project" &&
                request.query === "src",
            ),
          ).toBe(true);
        },
        { timeout: 4_000, interval: 16 },
      );

      useCommandPaletteStore.getState().setOpen(false);
      useCommandPaletteStore.getState().toggleMode("content");
      const contentPalette = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="command-palette"][data-palette-mode="content"]',
          ),
        "Content palette should open in content mode.",
      );
      const contentInput = contentPalette.querySelector<HTMLInputElement>("input");
      if (!contentInput) throw new Error("Content palette input should render.");
      setInputValue(contentInput, "needle");

      const highlightedMatch = await waitForElement(
        () => contentPalette.querySelector<HTMLElement>("mark"),
        "Content palette should highlight the exact match range.",
      );
      expect(highlightedMatch.textContent).toBe("needle");
      expect(contentPalette.textContent).toContain("src/search.ts:7");
      expect(
        wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.projectsSearchContents &&
            request.projectId === PROJECT_ID &&
            request.query === "needle",
        ),
      ).toBe(true);
      contentPalette
        .querySelector<HTMLButtonElement>('[aria-label="Use regular expression"]')
        ?.click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.projectsSearchContents &&
                request.query === "needle" &&
                request.useRegex === true,
            ),
          ).toBe(true);
        },
        { timeout: 4_000, interval: 16 },
      );

      useCommandPaletteStore.getState().setOpen(false);
      useCommandPaletteStore.getState().toggleOpen();
      const rootPalette = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="command-palette"]'),
        "Root palette should open.",
      );
      const rootInput = rootPalette.querySelector<HTMLInputElement>("input");
      if (!rootInput) throw new Error("Root palette input should render.");
      setInputValue(rootInput, "?another");
      await vi.waitFor(() => expect(rootPalette.dataset.paletteMode).toBe("content"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters threads immediately and escalates to conversation FTS", async () => {
    const retryThreadId = ThreadId.makeUnsafe("thread-retry-search");
    const reconnectThreadId = ThreadId.makeUnsafe("thread-reconnect-search");
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({ id: retryThreadId, title: "Retry provider startup" }),
          createSnapshotThread({ id: reconnectThreadId, title: "Reconnect websocket" }),
        ]);
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag !== WS_METHODS.globalSearchQuery) return null;
          return {
            type: "result",
            result: {
              results: [
                {
                  documentKey: "message:search-match",
                  kind: "message",
                  projectId: PROJECT_ID,
                  projectTitle: "Project",
                  threadId: reconnectThreadId,
                  workflowId: null,
                  messageId: "message-search-match",
                  turnId: null,
                  fileChangeId: null,
                  title: "Reconnect websocket",
                  snippet: "Retry after the connection resumes",
                  path: null,
                  role: "assistant",
                  model: "gpt-5",
                  providerInstanceId: "codex",
                  status: "ready",
                  createdAt: NOW_ISO,
                  rank: -1,
                },
              ],
            },
          };
        };
      },
    });

    try {
      (
        await waitForElement(
          () => document.querySelector<HTMLButtonElement>('[data-testid="sidebar-search-toggle"]'),
          "The nav strip's Search button should render.",
        )
      ).click();
      const input = await waitForElement(
        () =>
          document.querySelector<HTMLInputElement>('[data-testid="sidebar-thread-search-input"]'),
        "Sidebar thread search input should render.",
      );
      setInputValue(input, "retry");

      await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-testid="sidebar-thread-search-result-${retryThreadId}"]`,
          ),
        "The matching thread should appear without waiting for FTS.",
      );
      expect(
        document.querySelector(`[data-testid="sidebar-thread-search-result-${reconnectThreadId}"]`),
      ).toBeNull();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.globalSearchQuery && request.query === "retry",
            ),
          ).toBe(true);
        },
        { timeout: 4_000, interval: 16 },
      );
      const contentResult = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-global-search-result-message:search-match"]',
          ),
        "The conversation-content result should render after the debounced query.",
      );
      expect(contentResult.querySelector("mark")?.textContent?.toLowerCase()).toBe("retry");

      contentResult.click();
      await waitForPath(
        mounted.router,
        (pathname) => pathname.endsWith(`/${reconnectThreadId}`),
        "Conversation result should navigate to its thread.",
      );
      expect(mounted.router.state.location.search.timelineEntryId).toBe("message-search-match");
      expect(input.value).toBe("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("marks unsent composer content on an existing thread", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
    });

    try {
      const row = await waitForElement(
        () => querySidebarThreadRowByTitle(LONG_THREAD_TITLE),
        "Existing thread row should render.",
      );
      expect(row.querySelector('[aria-label="Unsent draft"]')).toBeNull();

      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "Follow up on the failing browser test");
      await vi.waitFor(() => {
        expect(row.querySelector('[aria-label="Unsent draft"]')).not.toBeNull();
      });

      useComposerDraftStore.getState().setPrompt(THREAD_ID, "");
      await vi.waitFor(() => {
        expect(row.querySelector('[aria-label="Unsent draft"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a new draft row in the project sidebar and auto-expands the project", async () => {
    useStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          name: "Project",
          cwd: "/repo/project",
          model: "gpt-5",
          createdAt: NOW_ISO,
          expanded: false,
          scripts: [],
          memories: [],
        },
      ],
      threads: [],
      threadsHydrated: false,
    });

    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
    });

    try {
      await waitForElement(
        () => queryProjectButton("Project"),
        "Project button should render before opening a draft.",
      );

      await page.getByTestId("new-thread-button").click();

      const newThreadPath = await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "Route should switch to the new draft thread.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      const newThreadRow = await waitForSidebarThreadRow("New thread");

      expect(newThreadRow.getAttribute("data-active")).toBe("true");
      expect(
        useStore.getState().projects.find((project) => project.id === PROJECT_ID)?.expanded,
      ).toBe(true);
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId).toBe(
        newThreadId,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the non-default environment for shift-click", async () => {
    seedAppSettings({ defaultThreadEnvMode: "local" });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
    });

    try {
      const newThreadButton = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-button"]'),
        "New-thread button should render.",
      );
      newThreadButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
      );

      await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "Shift-click should navigate to the alternate-mode draft.",
      );
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)).toMatchObject({
        branch: "main",
        envMode: "worktree",
        worktreePath: null,
      });
      expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([false, true])(
    "opens a mod-shift-click draft in a desktop window after persisting it (scratch: %s)",
    async (scratch) => {
      seedAppSettings({ defaultThreadEnvMode: "local" });
      const openThreadInNewWindow = vi.fn(async () => true);
      installDesktopBridgeMock({ openThreadInNewWindow });
      const mounted = await mountApp({
        width: 1_400,
        initialEntries: [`/${THREAD_ID}`],
        configureFixture: (nextFixture) => {
          if (scratch)
            nextFixture.snapshot = {
              ...nextFixture.snapshot,
              projects: [
                ...nextFixture.snapshot.projects,
                {
                  ...createSnapshotProject("scratch-project" as ProjectId, "No project"),
                  kind: "scratch",
                  workspaceRoot: "/state/scratch",
                },
              ],
            };
        },
      });

      try {
        const newThreadButton = await waitForElement(
          () =>
            document.querySelector<HTMLElement>(
              scratch
                ? '[data-testid="sidebar-new-scratch-thread"]'
                : '[data-testid="new-thread-button"]',
            ),
          "New-thread button should render.",
        );
        newThreadButton.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
            metaKey: true,
          }),
        );

        const pathname = await waitForPath(
          mounted.router,
          (nextPathname) => UUID_ROUTE_RE.test(nextPathname),
          "Mod-shift-click should create the draft before opening a new window.",
        );
        await vi.waitFor(() => {
          expect(openThreadInNewWindow).toHaveBeenCalledWith(pathname.slice(1));
        });
        const persisted = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
        expect(persisted).toContain(pathname.slice(1));
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("creates a project-scoped draft from chat.new and preserves branch context", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: createSidebarShortcutBindings(),
        };
      },
    });

    try {
      await waitForElement(
        () => queryProjectButton("Project"),
        "Project button should render before triggering chat.new.",
      );
      await dispatchShortcut({ key: "n" });

      const newThreadPath = await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "chat.new should navigate to a draft thread route.",
      );
      const draftThread = useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID);

      expect(draftThread?.threadId).toBe(newThreadPath.slice(1));
      expect(draftThread?.branch).toBe("main");
      expect(draftThread?.worktreePath).toBeNull();
      expect(querySidebarThreadRowsByTitle("New thread")).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves branch inheritance when the default environment is a worktree", async () => {
    // A legacy browser value: its migration can still be waiting on the startup
    // sync gate when the shortcut runs, so the pending value must apply.
    seedAppSettings({ defaultThreadEnvMode: "worktree" });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: createSidebarShortcutBindings(),
        };
      },
    });

    try {
      await waitForElement(
        () => queryProjectButton("Project"),
        "Project button should render before triggering chat.new.",
      );
      await dispatchShortcut({ key: "n" });
      await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "chat.new should navigate to the worktree draft.",
      );
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)).toMatchObject({
        branch: "main",
        envMode: "worktree",
        worktreePath: null,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("reuses the same project draft for chat.newLocal", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: createSidebarShortcutBindings(),
        };
      },
    });

    try {
      await waitForElement(
        () => queryProjectButton("Project"),
        "Project button should render before triggering chat.newLocal.",
      );
      await dispatchShortcut({ key: "l", shiftKey: true });

      const firstPath = await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "chat.newLocal should navigate to a draft thread route.",
      );
      await dispatchShortcut({ key: "l", shiftKey: true });
      const secondPath = await waitForPath(
        mounted.router,
        (pathname) => pathname === firstPath,
        "chat.newLocal should reuse the same draft for the project.",
      );
      const draftThread = useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID);

      expect(secondPath).toBe(firstPath);
      expect(draftThread?.branch).toBe("main");
      expect(draftThread?.worktreePath).toBeNull();
      expect(querySidebarThreadRowsByTitle("New thread")).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the workflow dialog for the active thread project from workflow.new", async () => {
    const secondProjectId = "project-2" as ProjectId;
    const secondThreadId = "thread-sidebar-workflow-shortcut" as ThreadId;
    const snapshot = {
      ...createSnapshot([
        createSnapshotThread({ id: THREAD_ID, title: "Project One thread" }),
        createSnapshotThread({
          id: secondThreadId,
          projectId: secondProjectId,
          title: "Project Two thread",
        }),
      ]),
      projects: [
        {
          id: PROJECT_ID,
          title: "Project One",
          workspaceRoot: "/repo/project-one",
          defaultModel: "gpt-5",
          scripts: [],
          memories: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
        {
          id: secondProjectId,
          title: "Project Two",
          workspaceRoot: "/repo/project-two",
          defaultModel: "gpt-5",
          scripts: [],
          memories: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
    } satisfies OrchestrationReadModel;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${secondThreadId}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = snapshot;
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: createSidebarShortcutBindings(),
        };
        nextFixture.welcome = {
          ...nextFixture.welcome,
          bootstrapProjectId: secondProjectId,
          bootstrapThreadId: secondThreadId,
        };
      },
    });

    try {
      await waitForElement(
        () => queryProjectButton("Project Two"),
        "Active project button should render before triggering workflow.new.",
      );
      await dispatchShortcut({ key: "n", shiftKey: true });

      await vi.waitFor(
        () => {
          expect(useWorkflowCreateDialogStore.getState().projectId).toBe(secondProjectId);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="dialog-title"]'),
        "Workflow dialog should open from workflow.new.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches project.meta.update when changing a project's path", async () => {
    installDesktopBridgeMock({
      showContextMenu: (async () => "change-path") as DesktopBridge["showContextMenu"],
      pickFolder: async () => "/repo/project-renamed",
    });

    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
    });

    try {
      const projectButton = await waitForElement(
        () => queryProjectButton("Project"),
        "Project button should render before changing the path.",
      );
      const requestCountBeforeContextMenu = wsRequests.length;

      projectButton.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 24,
          clientY: 24,
        }),
      );

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests
            .slice(requestCountBeforeContextMenu)
            .find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                (request.command as { type?: string } | undefined)?.type === "project.meta.update",
            );
          expect(dispatchRequest).toBeTruthy();
          if (!dispatchRequest) {
            throw new Error("Expected a project.meta.update dispatch request.");
          }
          const command = dispatchRequest.command as {
            projectId?: string;
            workspaceRoot?: string;
          };
          expect(command.projectId).toBe(PROJECT_ID);
          expect(command.workspaceRoot).toBe("/repo/project-renamed");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches a revisioned full-list command when pinning from the thread menu", async () => {
    installDesktopBridgeMock({
      showContextMenu: (async () => "pin") as DesktopBridge["showContextMenu"],
    });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = { ...nextFixture.snapshot, pinRevision: 7 };
      },
    });

    try {
      const row = await waitForSidebarThreadRow(LONG_THREAD_TITLE);
      const requestCount = wsRequests.length;
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 30,
          clientY: 30,
        }),
      );

      await vi.waitFor(() => {
        const request = wsRequests
          .slice(requestCount)
          .find(
            (entry) =>
              entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (entry.command as { type?: string } | undefined)?.type === "thread.pins.replace",
          );
        expect(request).toBeTruthy();
        expect(request?.command).toMatchObject({
          threadId: THREAD_ID,
          pinnedThreadIds: [THREAD_ID],
          expectedRevision: 7,
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("drags one thread, or the multi-selection, as thread references without navigating", async () => {
    const otherId = "thread-sidebar-drag-other" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({ id: THREAD_ID, title: "Drag source one" }),
          createSnapshotThread({ id: otherId, title: "Drag source two" }),
        ]);
      },
    });
    const dragFrom = (element: HTMLElement) => {
      const transfer = new DataTransfer();
      element.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      return transfer;
    };
    try {
      const row = await waitForSidebarThreadRow("Drag source two");
      expect(row.getAttribute("draggable")).toBe("true");
      const requestCount = wsRequests.length;

      const single = readThreadReferenceDrag(dragFrom(row));
      expect(single).toEqual([{ threadId: otherId, title: "Drag source two" }]);

      useThreadSelectionStore.getState().toggleThread(THREAD_ID);
      useThreadSelectionStore.getState().toggleThread(otherId);
      const selection = readThreadReferenceDrag(dragFrom(row));
      expect(selection?.map((item) => item.threadId).toSorted()).toEqual(
        [THREAD_ID, otherId].toSorted(),
      );

      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
      expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(2);
      expect(
        wsRequests
          .slice(requestCount)
          .filter((entry) => entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toEqual([]);
    } finally {
      useThreadSelectionStore.getState().clearSelection();
      await mounted.cleanup();
    }
  });

  it("dispatches title regeneration and shows pending progress in the row", async () => {
    installDesktopBridgeMock({
      showContextMenu: (async () => "regenerate-title") as DesktopBridge["showContextMenu"],
    });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
    });

    try {
      const row = await waitForSidebarThreadRow(LONG_THREAD_TITLE);
      const requestCount = wsRequests.length;
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 30,
          clientY: 30,
        }),
      );

      await vi.waitFor(() => {
        const request = wsRequests
          .slice(requestCount)
          .find(
            (entry) =>
              entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (entry.command as { type?: string } | undefined)?.type === "thread.meta.update",
          );
        expect(request?.command).toMatchObject({
          threadId: THREAD_ID,
          regenerateTitle: true,
        });
      });
    } finally {
      await mounted.cleanup();
    }

    const pendingMounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...nextFixture.snapshot,
          threads: nextFixture.snapshot.threads.map((thread) => ({
            ...thread,
            titleRegeneration: {
              requestId: CommandId.makeUnsafe("command-title-pending"),
              startedAt: NOW_ISO,
            },
          })),
        };
      },
    });
    try {
      await waitForElement(
        () => document.querySelector('[aria-label="Regenerating thread title"]'),
        "Pending title regeneration indicator should render.",
      );
    } finally {
      await pendingMounted.cleanup();
    }
  });

  it("groups snoozed threads under the project's shelf", async () => {
    const snoozedTitle = "Snoozed implementation";
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({
            id: THREAD_ID,
            title: snoozedTitle,
            snoozedAt: NOW_ISO,
            snoozedUntil: "2099-03-11T15:00:00.000Z",
          }),
        ]);
      },
    });

    try {
      const toggle = await waitForElement(
        () => queryShelfSegment("snoozed"),
        "Snoozed shelf segment should render.",
      );
      expect(toggle.textContent).toBe("1 snoozed");
      // The app opens the snoozed thread, so its bucket starts open.
      await waitForSidebarThreadRow(snoozedTitle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      toggle.click();
      await vi.waitFor(() => expect(querySidebarThreadRowByTitle(snoozedTitle)).toBeNull());
      toggle.click();
      await waitForSidebarThreadRow(snoozedTitle);
    } finally {
      await mounted.cleanup();
    }
  });

  it("folds threads idle past the configured age into an older row, except exempt ones", async () => {
    seedAppSettings({ sidebarOlderThreadDays: 7 });
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const thread = (id: string, title: string, idleDays: number, extra = {}) =>
      createSnapshotThread({
        id: id as ThreadId,
        title,
        createdAt: daysAgo(idleDays),
        lastInteractionAt: daysAgo(idleDays),
        updatedAt: daysAgo(idleDays),
        ...extra,
      });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/stale-open"],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          thread("fresh", "Fresh thread", 1),
          thread("stale-a", "Stale thread A", 20),
          thread("stale-b", "Stale thread B", 9),
          thread("stale-pinned", "Stale pinned", 30, { pinnedAt: daysAgo(30) }),
          thread("stale-open", "Stale open", 40),
        ]);
      },
    });
    try {
      await waitForSidebarThreadRow("Fresh thread");
      const older = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="sidebar-older-toggle"]'),
        "The older row should render.",
      );
      expect(older.textContent).toBe("2 older than 7 days");
      expect(older.getAttribute("aria-expanded")).toBe("false");
      expect(querySidebarThreadRowByTitle("Stale thread A")).toBeNull();
      expect(querySidebarThreadRowByTitle("Stale thread B")).toBeNull();
      const terminal = useTerminalStateStore.getState();
      const staleId = ThreadId.makeUnsafe("stale-b");
      terminal.ensureTerminal(staleId, "default");
      terminal.setTerminalActivity(staleId, "default", true);
      await waitForSidebarThreadRow("Stale thread B");
      await expect.poll(() => older.textContent).toBe("1 older than 7 days");
      terminal.setTerminalActivity(staleId, "default", false);
      await expect.poll(() => querySidebarThreadRowByTitle("Stale thread B")).toBeNull();
      await expect.poll(() => older.textContent).toBe("2 older than 7 days");
      terminal.clearTerminalState(staleId);
      // Pinned and open threads never fold.
      expect(querySidebarThreadRowByTitle("Stale pinned")).not.toBeNull();
      expect(querySidebarThreadRowByTitle("Stale open")).not.toBeNull();
      // Three recent threads fit the default preview count.
      expect(querySidebarButtonByText("Show more")).toBeNull();

      older.click();
      await waitForSidebarThreadRow("Stale thread A");
      await waitForSidebarThreadRow("Stale thread B");
      expect(older.getAttribute("aria-expanded")).toBe("true");
      older.click();
      await vi.waitFor(() => expect(querySidebarThreadRowByTitle("Stale thread A")).toBeNull());
    } finally {
      await mounted.cleanup();
    }
  });

  it("moves a lone thread to Today when its turn finishes on a new day", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    const lone = (at: string) =>
      createSnapshotThread({ id: THREAD_ID, createdAt: at, lastInteractionAt: at, updatedAt: at });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([lone(yesterday.toISOString())]);
      },
    });
    const bucketOfRow = () =>
      querySidebarThreadRowByTitle(LONG_THREAD_TITLE)?.closest<HTMLElement>("[data-recent-bucket]")
        ?.dataset.recentBucket;
    try {
      (
        await waitForElement(
          () => document.querySelector<HTMLButtonElement>('[data-testid="sidebar-view-recent"]'),
          "The view toggle should render.",
        )
      ).click();
      await vi.waitFor(() => expect(bucketOfRow()).toBe("yesterday"));
      // The only thread keeps its place in the activity order, so its summary key lags.
      useStore.getState().syncServerReadModel(createSnapshot([lone(new Date().toISOString())]));
      await vi.waitFor(() => expect(bucketOfRow()).toBe("today"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the preview count for recent threads while aging folds older ones", async () => {
    seedAppSettings({ sidebarOlderThreadDays: 7, sidebarThreadPreviewCount: 2 });
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const thread = (id: string, title: string, idleDays: number) =>
      createSnapshotThread({
        id: id as ThreadId,
        title,
        createdAt: daysAgo(idleDays),
        lastInteractionAt: daysAgo(idleDays),
        updatedAt: daysAgo(idleDays),
      });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/recent-1"],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          thread("recent-1", "Recent one", 0.1),
          thread("recent-2", "Recent two", 1),
          thread("recent-3", "Recent three", 2),
          thread("recent-4", "Recent four", 3),
          thread("old-1", "Old one", 20),
        ]);
      },
    });
    try {
      await waitForSidebarThreadRow("Recent one");
      await waitForSidebarThreadRow("Recent two");
      expect(querySidebarThreadRowByTitle("Recent three")).toBeNull();
      expect(querySidebarThreadRowByTitle("Old one")).toBeNull();
      // One row: "Show 2 more · 1 older than 7 days".
      const row = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="sidebar-more-and-older"]'),
        "Recent threads past the preview count should sit behind one disclosure row.",
      );
      expect(row.textContent).toBe("Show 2 more·1 older than 7 days");
      const more = row.querySelector<HTMLButtonElement>('[data-testid="sidebar-show-more"]')!;
      const older = row.querySelector<HTMLButtonElement>('[data-testid="sidebar-older-toggle"]')!;
      expect(older.getAttribute("aria-expanded")).toBe("false");
      // Two sibling buttons, each its own tree row; neither nests inside the other.
      expect(more.tagName).toBe("BUTTON");
      expect(more.getAttribute("role")).toBe("treeitem");
      expect(older.getAttribute("role")).toBe("treeitem");
      expect(more.contains(older) || older.contains(more)).toBe(false);
      expect(row.querySelector('[role="button"]')).toBeNull();

      // Enter on "Show 2 more" shows more, without opening the older threads.
      more.focus();
      await userEvent.keyboard("{Enter}");
      await waitForSidebarThreadRow("Recent four");
      expect(querySidebarThreadRowByTitle("Old one")).toBeNull();
      await vi.waitFor(() => expect(row.textContent).toContain("Show less"));

      // The older part toggles only its own list.
      older.click();
      await waitForSidebarThreadRow("Old one");
      expect(older.getAttribute("aria-expanded")).toBe("true");
      expect(querySidebarThreadRowByTitle("Recent four")).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("wraps every shelf segment within a minimum-width sidebar", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        const many = (
          prefix: string,
          count: number,
          extra: (index: number) => Partial<SnapshotThread>,
        ) =>
          Array.from({ length: count }, (_, index) =>
            createSnapshotThread({
              id: `${prefix}-${index}` as ThreadId,
              title: `${prefix} ${index}`,
              ...extra(index),
            }),
          );
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({ id: THREAD_ID }),
          // Four nonempty buckets already outgrow one line at 192px.
          ...many("scheduled", 3, (index) => ({
            scheduledOrigin: {
              taskId: ScheduledTaskId.makeUnsafe("task"),
              runId: ScheduledTaskRunId.makeUnsafe(`run-${index}`),
            },
          })),
          ...many("snoozed", 3, () => ({
            snoozedAt: NOW_ISO,
            snoozedUntil: "2099-03-11T15:00:00.000Z",
          })),
          ...many("settled", 3, () => ({ settledAt: NOW_ISO })),
          ...many("archived", 3, () => ({ archivedAt: NOW_ISO })),
        ]);
      },
    });
    try {
      const shelf = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="sidebar-shelf"]'),
        "The shelf should render.",
      );
      await vi.waitFor(() => expect(shelf.querySelectorAll("[data-shelf-bucket]").length).toBe(4));
      const sidebarEl = [...document.querySelectorAll<HTMLElement>("[style]")].find((element) =>
        element.getAttribute("style")?.includes("--sidebar-width"),
      )!;
      sidebarEl.style.setProperty("--sidebar-width", "12rem");
      await vi.waitFor(() => {
        const row = shelf.firstElementChild!.getBoundingClientRect();
        const segments = [...shelf.querySelectorAll<HTMLElement>("[data-shelf-bucket]")];
        for (const segment of segments) {
          const rect = segment.getBoundingClientRect();
          expect(rect.right).toBeLessThanOrEqual(row.right + 0.5);
          expect(rect.width).toBeGreaterThan(0);
        }
        // They no longer fit on one line, so the last one wrapped.
        expect(segments.at(-1)!.getBoundingClientRect().top).toBeGreaterThan(
          segments[0]!.getBoundingClientRect().top,
        );
      });
      // Segments are reached through the tree row, not as extra Tab stops.
      for (const segment of shelf.querySelectorAll<HTMLElement>("[data-shelf-bucket]")) {
        expect(segment.tabIndex).toBe(-1);
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches to a Recent view that buckets, filters by project and remembers both", async () => {
    const otherProjectId = "recent-beta" as ProjectId;
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const thread = (id: string, title: string, at: string, projectId = PROJECT_ID) =>
      createSnapshotThread({
        id: id as ThreadId,
        title,
        projectId,
        createdAt: at,
        lastInteractionAt: at,
        updatedAt: at,
      });
    const configureFixture = (nextFixture: TestFixture) => {
      const snapshot = createSnapshot([
        thread("recent-alpha-now", "Alpha now", hoursAgo(0)),
        thread("recent-beta-now", "Beta now", hoursAgo(0), otherProjectId),
        thread("recent-alpha-old", "Alpha old", hoursAgo(24 * 30)),
      ]);
      nextFixture.snapshot = {
        ...snapshot,
        projects: [...snapshot.projects, createSnapshotProject(otherProjectId, "Beta")],
      };
      nextFixture.welcome = {
        ...nextFixture.welcome,
        bootstrapThreadId: "recent-alpha-now" as ThreadId,
      };
    };
    let mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/recent-alpha-now"],
      configureFixture,
    });
    try {
      await waitForSidebarThreadRow("Alpha now");
      const recentToggle = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="sidebar-view-recent"]'),
        "The view toggle should render.",
      );
      expect(recentToggle.getAttribute("aria-checked")).toBe("false");
      recentToggle.click();
      const tree = await waitForElement(
        () => document.querySelector<HTMLElement>('[role="tree"][aria-label="Recent threads"]'),
        "The Recent view should render its own tree.",
      );
      expect(document.querySelector('[role="tree"][aria-label="Threads and projects"]')).toBeNull();
      const bucketOf = (title: string) =>
        querySidebarThreadRowByTitle(title)?.closest<HTMLElement>("[data-recent-bucket]")?.dataset
          .recentBucket;
      await vi.waitFor(() => expect(bucketOf("Alpha now")).toBe("today"));
      expect(bucketOf("Beta now")).toBe("today");
      // Earlier starts collapsed.
      expect(querySidebarThreadRowByTitle("Alpha old")).toBeNull();
      expect(
        tree.querySelector('[data-sidebar-row="recent:earlier"]')?.getAttribute("aria-expanded"),
      ).toBe("false");
      // Rows name their project while every project shows.
      expect(querySidebarThreadRowByTitle("Beta now")?.textContent).toContain("Beta");

      // Keyboard: the tree moves between bucket rows and threads; mod-click multi-selects.
      const todayHeader = tree.querySelector<HTMLElement>('[data-sidebar-row="recent:today"]')!;
      todayHeader.focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement?.getAttribute("data-sidebar-row")).toMatch(/^thread:recent:/);
      const modifier = navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true };
      for (const title of ["Alpha now", "Beta now"]) {
        querySidebarThreadRowByTitle(title)!.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier }),
        );
      }
      expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(2);
      useThreadSelectionStore.getState().clearSelection();

      // Opening a thread from elsewhere reveals it in the collapsed Earlier bucket.
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: "recent-alpha-old" as ThreadId },
      });
      await vi.waitFor(() => expect(bucketOf("Alpha old")).toBe("earlier"));
      expect(
        tree.querySelector('[data-sidebar-row="recent:earlier"]')?.getAttribute("aria-expanded"),
      ).toBe("true");

      document
        .querySelector<HTMLButtonElement>(`[data-testid="recent-project-chip-${otherProjectId}"]`)!
        .click();
      await vi.waitFor(() => expect(querySidebarThreadRowByTitle("Alpha now")).toBeNull());
      const betaRow = querySidebarThreadRowByTitle("Beta now")!;
      // A filtered list drops the redundant project tag.
      expect(betaRow.textContent).not.toContain("Beta now Beta");
      expect(betaRow.querySelector("[title='Beta']")).toBeNull();
      expect(localStorage.getItem("f5:sidebar:recent-project")).toBe(
        JSON.stringify(otherProjectId),
      );

      // Both choices survive a reload.
      await mounted.cleanup();
      mounted = await mountApp({
        width: 1_400,
        initialEntries: ["/recent-alpha-now"],
        configureFixture,
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('[role="tree"][aria-label="Recent threads"]'),
        "The Recent view should be remembered.",
      );
      await waitForSidebarThreadRow("Beta now");
      expect(querySidebarThreadRowByTitle("Alpha now")).toBeNull();

      // A remembered project that no longer exists falls back to All.
      await mounted.cleanup();
      localStorage.setItem("f5:sidebar:recent-project", JSON.stringify("deleted-project"));
      mounted = await mountApp({
        width: 1_400,
        initialEntries: ["/recent-alpha-now"],
        configureFixture,
      });
      await waitForSidebarThreadRow("Alpha now");
      await waitForSidebarThreadRow("Beta now");
      expect(
        document
          .querySelector('[data-testid="recent-project-chip-all"]')
          ?.getAttribute("aria-pressed"),
      ).toBe("true");

      document.querySelector<HTMLButtonElement>('[data-testid="sidebar-view-projects"]')!.click();
      await waitForElement(
        () =>
          document.querySelector<HTMLElement>('[role="tree"][aria-label="Threads and projects"]'),
        "Projects view should come back.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a project draft visible in the collapsed preview when it would normally be truncated", async () => {
    const previewThreads = Array.from({ length: 8 }, (_, index) =>
      createSnapshotThread({
        id: `preview-thread-${index}` as ThreadId,
        title: `Preview thread ${index}`,
        createdAt: `2026-03-11T12:0${index}:00.000Z`,
        lastInteractionAt: `2026-03-11T12:0${index}:00.000Z`,
        updatedAt: `2026-03-11T12:0${index}:00.000Z`,
      }),
    ).toReversed();
    const draftThreadId = "preview-draft-thread" as ThreadId;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {
        [draftThreadId]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-01T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: draftThreadId,
      },
    });

    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${previewThreads[0]!.id}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot(previewThreads);
        nextFixture.welcome = {
          ...nextFixture.welcome,
          bootstrapThreadId: previewThreads[0]!.id,
        };
      },
    });

    try {
      await waitForSidebarThreadRow("New thread");
      expect(querySidebarThreadRowByTitle("Preview thread 3")).toBeTruthy();
      expect(querySidebarThreadRowByTitle("Preview thread 2")).toBeNull();
      expect(querySidebarThreadRowByTitle("Preview thread 1")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders archived threads in a shelf bucket that can be opened", async () => {
    const activeThreadId = "active-thread" as ThreadId;
    const archivedThreadId = "archived-thread" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${activeThreadId}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({
            id: activeThreadId,
            title: "Active thread",
            createdAt: "2026-03-11T12:00:00.000Z",
            lastInteractionAt: "2026-03-11T12:00:00.000Z",
            updatedAt: "2026-03-11T12:00:00.000Z",
          }),
          createSnapshotThread({
            id: archivedThreadId,
            title: "Archived thread",
            createdAt: "2026-03-11T11:55:00.000Z",
            lastInteractionAt: "2026-03-11T11:55:00.000Z",
            updatedAt: "2026-03-11T11:55:00.000Z",
            archivedAt: "2026-03-11T12:10:00.000Z",
          }),
        ]);
        nextFixture.welcome = {
          ...nextFixture.welcome,
          bootstrapThreadId: activeThreadId,
        };
      },
    });

    try {
      await waitForSidebarThreadRow("Active thread");
      const archivedToggle = await waitForElement(
        () => queryShelfSegment("archived"),
        "Archived shelf segment should render for projects with archived threads.",
      );

      expect(querySidebarThreadRowByTitle("Archived thread")).toBeNull();

      archivedToggle.click();

      await waitForSidebarThreadRow("Archived thread");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the archived shelf collapsed when the open thread is archived", async () => {
    const openThreadId = "open-thread" as ThreadId;
    const otherThreadId = "other-thread" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${openThreadId}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({ id: openThreadId, title: "Open thread" }),
          createSnapshotThread({ id: otherThreadId, title: "Other thread" }),
        ]);
      },
    });

    try {
      await waitForSidebarThreadRow("Open thread");
      // The server confirms archiving the open thread.
      useStore.setState((state) => ({
        threads: state.threads.map((thread) =>
          thread.id === openThreadId ? { ...thread, archivedAt: NOW_ISO } : thread,
        ),
      }));
      const archivedSegment = await waitForElement(
        () => queryShelfSegment("archived"),
        "The archived segment should appear once the open thread is archived.",
      );
      await waitForLayout();
      expect(archivedSegment.getAttribute("aria-expanded")).toBe("false");
      expect(querySidebarThreadRowByTitle("Open thread")).toBeNull();
      expect(mounted.router.state.location.pathname).toBe(`/${openThreadId}`);

      // Navigating to an archived thread still opens its bucket.
      await mounted.router.navigate({ to: "/$threadId", params: { threadId: otherThreadId } });
      await waitForSidebarThreadRow("Other thread");
      await mounted.router.navigate({ to: "/$threadId", params: { threadId: openThreadId } });
      await expect
        .poll(() => queryShelfSegment("archived")?.getAttribute("aria-expanded"))
        .toBe("true");
      await waitForSidebarThreadRow("Open thread");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders archived workflows as archived rows and keeps workflow threads hidden", async () => {
    const activeThreadId = "active-thread" as ThreadId;
    const branchAThreadId = "archived-workflow-branch-a" as ThreadId;
    const branchBThreadId = "archived-workflow-branch-b" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${activeThreadId}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({
              id: activeThreadId,
              title: "Active thread",
            }),
            createSnapshotThread({
              id: branchAThreadId,
              title: "Archived workflow Branch A",
              lastInteractionAt: "2026-03-11T11:59:00.000Z",
              updatedAt: "2026-03-11T11:59:00.000Z",
            }),
            createSnapshotThread({
              id: branchBThreadId,
              title: "Archived workflow Branch B",
              lastInteractionAt: "2026-03-11T11:58:00.000Z",
              updatedAt: "2026-03-11T11:58:00.000Z",
            }),
          ]),
          planningWorkflows: [
            createPlanningWorkflow({
              id: "workflow-archived",
              title: "Archived workflow",
              branchAThreadId,
              branchBThreadId,
              archivedAt: "2026-03-11T12:10:00.000Z",
            }),
          ],
        };
        nextFixture.welcome = {
          ...nextFixture.welcome,
          bootstrapThreadId: activeThreadId,
        };
      },
    });

    try {
      await waitForSidebarThreadRow("Active thread");
      const archivedToggle = await waitForElement(
        () => queryShelfSegment("archived"),
        "Archived shelf segment should render for archived workflows.",
      );

      expect(querySidebarThreadRowByTitle("Archived workflow")).toBeNull();
      expect(querySidebarThreadRowByTitle("Archived workflow Branch A")).toBeNull();

      archivedToggle.click();

      await waitForSidebarThreadRow("Archived workflow");
      expect(querySidebarThreadRowByTitle("Archived workflow Branch A")).toBeNull();
      expect(querySidebarThreadRowByTitle("Archived workflow Branch B")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a collapsed workflow's phase strip and opens its current step", async () => {
    const workflowTitle = "Phase strip workflow";
    const branchAThreadId = "phase-strip-branch-a" as ThreadId;
    const branchBThreadId = "phase-strip-branch-b" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            createSnapshotThread({ id: branchAThreadId, title: `${workflowTitle} Branch A` }),
            createSnapshotThread({ id: branchBThreadId, title: `${workflowTitle} Branch B` }),
          ]),
          planningWorkflows: [
            createPlanningWorkflow({ title: workflowTitle, branchAThreadId, branchBThreadId }),
          ],
        };
      },
    });

    try {
      await waitForSidebarThreadRow(workflowTitle);
      const strip = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="workflow-phase-strip"]'),
        "The workflow row should show its phase strip.",
      );
      const dots = [...strip.querySelectorAll<HTMLElement>("[data-phase-state]")];
      expect(dots.length).toBeGreaterThan(1);
      expect(dots[0]!.dataset.phaseState).toBe("active");
      expect(dots.slice(1).every((dot) => dot.dataset.phaseState === "pending")).toBe(true);
      expect(strip.textContent).toContain(`0 of ${dots.length} phases complete, Authoring running`);

      const currentStep = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="workflow-current-step"]'),
        "A collapsed workflow should name its current step.",
      );
      expect(currentStep.textContent).toContain("Branch A · running");
      currentStep.click();
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(`/${branchAThreadId}`),
      );
      // Opening a child expands the workflow, which hides the current-step line.
      await waitForSidebarThreadRow("Branch A");
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="workflow-current-step"]')).toBeNull(),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("groups an expanded workflow's steps by phase, each led by its step state", async () => {
    const at = "2026-03-11T12:00:00.000Z";
    const slot = { provider: "codex", model: "gpt-5-codex" } as const;
    const ids = {
      a: "outline-branch-a" as ThreadId,
      b: "outline-branch-b" as ThreadId,
      merge: "outline-merge" as ThreadId,
      impl: "outline-impl" as ThreadId,
      reviewA: "outline-review-a" as ThreadId,
      reviewB: "outline-review-b" as ThreadId,
    };
    const codeReview = (threadId: ThreadId, status: "completed" | "error") => ({
      reviewerLabel: "Reviewer",
      reviewerSlot: slot,
      threadId,
      status,
      error: status === "error" ? "Reviewer crashed" : null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: at,
    });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${ids.b}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            ...Object.entries(ids).map(([role, id]) =>
              createSnapshotThread({
                id,
                title: `Outline ${role} thread`,
                // Never visited since its turn finished: unread outside a workflow.
                latestTurn: {
                  turnId: `${id}-turn` as never,
                  state: "completed",
                  requestedAt: at,
                  startedAt: at,
                  completedAt: at,
                  assistantMessageId: null,
                },
                // Branch A's saved plan reads "Plan Ready" outside a workflow.
                ...(role === "a" ? createPlanReadyOverrides("outline-a") : {}),
              }),
            ),
          ]),
          planningWorkflows: [
            createPlanningWorkflow({
              id: "workflow-outline",
              title: "Outline workflow",
              branchAThreadId: ids.a,
              branchBThreadId: ids.b,
              branchA: { status: "revised" },
              branchB: { status: "revised" },
              merge: { status: "merged", threadId: ids.merge },
              implementation: {
                implementationSlot: slot,
                threadId: ids.impl,
                implementationTurnId: null,
                revisionTurnId: null,
                codeReviewEnabled: true,
                codeReviews: [
                  codeReview(ids.reviewA, "completed"),
                  codeReview(ids.reviewB, "error"),
                ],
                status: "error",
                error: "Reviewer crashed",
                retryCount: 0,
                lastRetryAt: null,
                updatedAt: at,
              },
            }),
          ],
        };
        nextFixture.resolveWsRequest = (body) =>
          body._tag === WS_METHODS.gitStatus
            ? {
                type: "result",
                result: {
                  branch: "main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: {
                    number: 536,
                    title: "Outline implementation",
                    url: "https://github.com/acme/repo/pull/536",
                    baseBranch: "main",
                    headBranch: "main",
                    state: "open",
                  },
                },
              }
            : null;
      },
    });
    const phaseRow = (phaseId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="workflow-phase-row-${phaseId}"]`);
    const leadOf = (row: HTMLElement) => row.firstElementChild as HTMLElement;

    try {
      // The open thread's phase is expanded; Revision reruns the authors, so no row of its own.
      const authoring = await waitForElement(
        () => phaseRow("authoring"),
        "Authoring should render as a phase row.",
      );
      expect(authoring.getAttribute("aria-expanded")).toBe("true");
      expect(authoring.textContent).toContain("Authoring");
      expect(phaseRow("revision")).toBeNull();
      const branchA = await waitForSidebarThreadRow("Branch A");
      expect(
        leadOf(branchA)
          .querySelector("[data-workflow-step-state]")
          ?.getAttribute("data-workflow-step-state"),
      ).toBe("completed");
      expect(branchA.textContent).not.toContain("Plan Ready");
      // Unread outside a workflow, but steps run unattended: no bold.
      expect(branchA.className).not.toContain("font-medium");

      // A phase with one step is that step's row.
      expect(phaseRow("merge")).toBeNull();
      await waitForSidebarThreadRow("Merge");

      // The phase with a failed step opens by default and leads with the error.
      const codeReviewPhase = phaseRow("code-review")!;
      expect(codeReviewPhase.getAttribute("aria-expanded")).toBe("true");
      expect(
        leadOf(codeReviewPhase).getAttribute("data-workflow-step-state") ??
          codeReviewPhase
            .querySelector("[data-workflow-step-state]")
            ?.getAttribute("data-workflow-step-state"),
      ).toBe("error");
      const reviewB = await waitForSidebarThreadRow("Code Review B");
      expect(reviewB.className).toContain("text-foreground");

      // The implementation thread's PR is its leading glyph; no other step shows a PR, so
      // every title starts at the same x.
      const implementation = await waitForSidebarThreadRow("Implementation");
      await vi.waitFor(() =>
        expect(
          leadOf(implementation).querySelector('button[aria-label*="PR open"]'),
        ).not.toBeNull(),
      );
      const titleLeft = (row: HTMLElement) =>
        [...row.children]
          .find((child) => child.textContent?.trim() && child !== leadOf(row))!
          .getBoundingClientRect().left;
      expect(branchA.querySelector('button[aria-label*="PR open"]')).toBeNull();
      expect(titleLeft(implementation)).toBe(titleLeft(querySidebarThreadRowByTitle("Merge")!));

      // Click and Left/Right fold the phase, even with the open thread inside.
      authoring.click();
      await vi.waitFor(() => expect(querySidebarThreadRowByTitle("Branch A")).toBeNull());
      expect(authoring.getAttribute("aria-expanded")).toBe("false");
      authoring.focus();
      authoring.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
      await waitForSidebarThreadRow("Branch A");
      authoring.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(querySidebarThreadRowByTitle("Branch A")).toBeNull());
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the implementation PR during code review and a folded phase's approval in view", async () => {
    const at = "2026-03-11T12:00:00.000Z";
    const slot = { provider: "codex", model: "gpt-5-codex" } as const;
    const ids = {
      a: "review-stage-branch-a" as ThreadId,
      b: "review-stage-branch-b" as ThreadId,
      merge: "review-stage-merge" as ThreadId,
      impl: "review-stage-impl" as ThreadId,
      reviewA: "review-stage-review-a" as ThreadId,
      reviewB: "review-stage-review-b" as ThreadId,
    };
    const codeReview = (threadId: ThreadId) => ({
      reviewerLabel: "Reviewer",
      reviewerSlot: slot,
      threadId,
      status: "running" as const,
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: at,
    });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            ...Object.entries(ids).map(([role, id]) =>
              createSnapshotThread({
                id,
                title: `Review stage ${role} thread`,
                ...(role === "reviewA"
                  ? {
                      activities: [
                        {
                          id: "review-stage-approval" as never,
                          tone: "approval",
                          kind: "approval.requested",
                          summary: "Needs approval",
                          payload: { requestId: "review-stage-request", requestKind: "command" },
                          turnId: null,
                          createdAt: at,
                        },
                      ],
                    }
                  : {}),
              }),
            ),
          ]),
          planningWorkflows: [
            createPlanningWorkflow({
              id: "workflow-review-stage",
              title: "Review stage workflow",
              branchAThreadId: ids.a,
              branchBThreadId: ids.b,
              branchA: { status: "revised" },
              branchB: { status: "revised" },
              merge: { status: "merged", threadId: ids.merge },
              implementation: {
                implementationSlot: slot,
                threadId: ids.impl,
                implementationTurnId: null,
                revisionTurnId: null,
                codeReviewEnabled: true,
                codeReviews: [codeReview(ids.reviewA), codeReview(ids.reviewB)],
                status: "code_reviews_requested",
                error: null,
                retryCount: 0,
                lastRetryAt: null,
                updatedAt: at,
              },
            }),
          ],
        };
        nextFixture.resolveWsRequest = (body) => {
          // The default details carry no activities; keep Review A's approval when the sidebar
          // prefetches its details.
          if (
            body._tag === ORCHESTRATION_WS_METHODS.getThreadTailDetails &&
            body.threadId === ids.reviewA
          ) {
            const thread = nextFixture.snapshot.threads.find((entry) => entry.id === ids.reviewA);
            return {
              type: "result",
              result: {
                ...(resolveWsRpc(body) as Record<string, unknown>),
                activities: thread?.activities ?? [],
              },
            };
          }
          return body._tag === WS_METHODS.gitStatus
            ? {
                type: "result",
                result: {
                  branch: "main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: {
                    number: 537,
                    title: "Review stage implementation",
                    url: "https://github.com/acme/repo/pull/537",
                    baseBranch: "main",
                    headBranch: "main",
                    state: "open",
                  },
                },
              }
            : null;
        };
      },
    });

    try {
      const workflowRow = await waitForSidebarThreadRow("Review stage workflow");
      if (!document.querySelector('[data-testid="workflow-phase-row-code-review"]')) {
        workflowRow
          .querySelector<HTMLButtonElement>('button[aria-label="Expand Review stage workflow"]')
          ?.click();
      }
      // Code review keeps the implementation step active; its PR still leads the row.
      // The workflow row's phase summary also says "Implementation", so find the step's row.
      const implementationRow = () =>
        document.querySelector<HTMLElement>(`[data-sidebar-row="thread:workflow:${ids.impl}"]`);
      await vi.waitFor(() =>
        expect(
          (implementationRow()?.firstElementChild as HTMLElement | undefined)?.querySelector(
            'button[aria-label*="PR open"]',
          ) ?? null,
        ).not.toBeNull(),
      );

      // Folding the phase keeps the waiting approval visible on the phase row.
      const codeReviewPhase = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="workflow-phase-row-code-review"]'),
        "Code Review should render as a phase row.",
      );
      await vi.waitFor(() => expect(codeReviewPhase.textContent).toContain("Pending Approval"));
      expect(codeReviewPhase.getAttribute("aria-expanded")).toBe("true");
      codeReviewPhase.click();
      await vi.waitFor(() => expect(codeReviewPhase.getAttribute("aria-expanded")).toBe("false"));
      expect(querySidebarThreadRowByTitle("Code Review A")).toBeNull();
      expect(codeReviewPhase.textContent).toContain("Pending Approval");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a finished workflow's PR state, and its step line always opens a thread", async () => {
    seedAppSettings({ sidebarOlderThreadDays: 7 });
    const at = "2026-03-11T12:00:00.000Z";
    const slot = { provider: "codex", model: "gpt-5-codex" } as const;
    const ids = (prefix: string) => ({
      a: `${prefix}-branch-a` as ThreadId,
      b: `${prefix}-branch-b` as ThreadId,
      merge: `${prefix}-merge` as ThreadId,
      impl: `${prefix}-impl` as ThreadId,
      review: `${prefix}-review` as ThreadId,
    });
    const openPr = ids("open-pr");
    const plain = ids("plain");
    const waiting = ids("waiting");
    const completedWorkflow = (id: string, title: string, threads: ReturnType<typeof ids>) =>
      createPlanningWorkflow({
        id,
        title,
        branchAThreadId: threads.a,
        branchBThreadId: threads.b,
        branchA: { status: "revised" },
        branchB: { status: "revised" },
        merge: { status: "merged", threadId: threads.merge },
        implementation: {
          implementationSlot: slot,
          threadId: threads.impl,
          implementationTurnId: null,
          revisionTurnId: null,
          codeReviewEnabled: true,
          codeReviews: [
            {
              reviewerLabel: "Reviewer",
              reviewerSlot: slot,
              threadId: threads.review,
              status: "completed",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: at,
            },
          ],
          status: "completed",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: at,
        },
      });
    const snapshotThreads = (
      threads: ReturnType<typeof ids>,
      label: string,
      extra: Partial<SnapshotThread> = {},
    ) =>
      Object.entries(threads).map(([role, id]) =>
        createSnapshotThread({
          id,
          title: `${label} ${role} thread`,
          ...(role === "impl" ? extra : {}),
        }),
      );
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            ...snapshotThreads(openPr, "Open"),
            // Without a branch, the plain workflow's last thread has no PR.
            ...snapshotThreads(plain, "Plain", { branch: null }),
            ...snapshotThreads(waiting, "Waiting"),
          ]),
          planningWorkflows: [
            completedWorkflow("workflow-open-pr", "Open PR workflow", openPr),
            completedWorkflow("workflow-plain", "Plain workflow", plain),
            createPlanningWorkflow({
              id: "workflow-waiting",
              title: "Waiting workflow",
              branchAThreadId: waiting.a,
              branchBThreadId: waiting.b,
              branchA: { status: "revised" },
              branchB: { status: "revised" },
            }),
          ],
        };
        nextFixture.resolveWsRequest = (body) =>
          body._tag === WS_METHODS.gitStatus
            ? {
                type: "result",
                result: {
                  branch: "main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: {
                    number: 462,
                    title: "Sidebar follow-ups",
                    url: "https://github.com/acme/repo/pull/462",
                    baseBranch: "main",
                    headBranch: "main",
                    state: "open",
                  },
                },
              }
            : null;
      },
    });
    const itemOf = (workflowTitle: string) =>
      querySidebarThreadRowByTitle(workflowTitle)?.closest('[data-sidebar="menu-sub-item"]') ??
      null;
    const stepLineOf = (workflowTitle: string) =>
      itemOf(workflowTitle)?.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-current-step"]',
      ) ?? null;
    const finishedStatusOf = (workflowTitle: string) =>
      itemOf(workflowTitle)?.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-finished-status"]',
      ) ?? null;

    try {
      // Every phase is done: one line, with the last thread's PR in place of the phase strip.
      await waitForSidebarThreadRow("Open PR workflow");
      await vi.waitFor(() =>
        expect(finishedStatusOf("Open PR workflow")?.textContent).toBe("#462"),
      );
      const openPrStatus = finishedStatusOf("Open PR workflow")!;
      expect(openPrStatus.getAttribute("aria-label")).toBe(
        "Open last thread, #462 PR open: Sidebar follow-ups",
      );
      expect(stepLineOf("Open PR workflow")).toBeNull();
      expect(
        itemOf("Open PR workflow")?.querySelector('[data-testid="workflow-phase-strip"]'),
      ).toBeNull();

      // Old and finished without an open PR, the plain workflow folds; the open-PR one doesn't.
      expect(querySidebarThreadRowByTitle("Plain workflow")).toBeNull();
      const older = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="sidebar-older-toggle"]'),
        "The older row should render.",
      );
      older.click();
      await waitForSidebarThreadRow("Plain workflow");
      // Without a PR, the status is a check.
      expect(finishedStatusOf("Plain workflow")?.getAttribute("aria-label")).toBe(
        "Open last thread",
      );
      expect(stepLineOf("Plain workflow")).toBeNull();

      // An unfinished workflow keeps its strip and step line. The waiting workflow's next step
      // (Merge) has no thread: the line opens the newest one.
      expect(
        itemOf("Waiting workflow")?.querySelector('[data-testid="workflow-phase-strip"]'),
      ).not.toBeNull();
      expect(stepLineOf("Waiting workflow")?.textContent).toContain("Merge · waiting");
      stepLineOf("Waiting workflow")!.click();
      await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe(`/${waiting.b}`));

      // A finished workflow's status opens its last thread; the row opens the workflow page.
      finishedStatusOf("Plain workflow")!.click();
      await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe(`/${plain.impl}`));
      finishedStatusOf("Open PR workflow")!.click();
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(`/${openPr.impl}`),
      );
      querySidebarThreadRowByTitle("Open PR workflow")!.click();
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe("/workflow/workflow-open-pr"),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("reads a snoozed last thread's PR, and waits for git status before a check or folding", async () => {
    seedAppSettings({ sidebarOlderThreadDays: 7 });
    const at = "2026-03-11T12:00:00.000Z";
    const slot = { provider: "codex", model: "gpt-5-codex" } as const;
    const ids = (prefix: string) => ({
      a: `${prefix}-branch-a` as ThreadId,
      b: `${prefix}-branch-b` as ThreadId,
      merge: `${prefix}-merge` as ThreadId,
      impl: `${prefix}-impl` as ThreadId,
      review: `${prefix}-review` as ThreadId,
    });
    const snoozed = ids("snoozed");
    const plain = ids("plain");
    const completedWorkflow = (id: string, title: string, threads: ReturnType<typeof ids>) =>
      createPlanningWorkflow({
        id,
        title,
        branchAThreadId: threads.a,
        branchBThreadId: threads.b,
        branchA: { status: "revised" },
        branchB: { status: "revised" },
        merge: { status: "merged", threadId: threads.merge },
        implementation: {
          implementationSlot: slot,
          threadId: threads.impl,
          implementationTurnId: null,
          revisionTurnId: null,
          codeReviewEnabled: true,
          codeReviews: [
            {
              reviewerLabel: "Reviewer",
              reviewerSlot: slot,
              threadId: threads.review,
              status: "completed",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: at,
            },
          ],
          status: "completed",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: at,
        },
      });
    const snapshotThreads = (
      threads: ReturnType<typeof ids>,
      label: string,
      impl: Partial<SnapshotThread>,
    ) =>
      Object.entries(threads).map(([role, id]) =>
        createSnapshotThread({
          id,
          title: `${label} ${role} thread`,
          ...(role === "impl" ? impl : {}),
        }),
      );
    let releaseGitStatus: () => void = () => {};
    const gitStatusHeld = new Promise<void>((resolve) => {
      releaseGitStatus = resolve;
    });
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            // The implementation thread is snoozed, so the workflow's child list leaves it out.
            ...snapshotThreads(snoozed, "Snoozed", { snoozedUntil: "2099-01-01T00:00:00.000Z" }),
            // Without a branch, the plain workflow's last thread has no PR to wait for.
            ...snapshotThreads(plain, "Plain", { branch: null }),
          ]),
          planningWorkflows: [
            completedWorkflow("workflow-snoozed", "Snoozed PR workflow", snoozed),
            completedWorkflow("workflow-plain", "Plain workflow", plain),
          ],
        };
        nextFixture.resolveWsRequest = (body) =>
          body._tag === WS_METHODS.gitStatus
            ? gitStatusHeld.then(() => ({
                type: "result" as const,
                result: {
                  branch: "main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: {
                    number: 462,
                    title: "Sidebar follow-ups",
                    url: "https://github.com/acme/repo/pull/462",
                    baseBranch: "main",
                    headBranch: "main",
                    state: "open" as const,
                  },
                },
              }))
            : null;
      },
    });
    const finishedStatusOf = (workflowTitle: string) =>
      querySidebarThreadRowByTitle(workflowTitle)
        ?.closest('[data-sidebar="menu-sub-item"]')
        ?.querySelector<HTMLButtonElement>('[data-testid="workflow-finished-status"]') ?? null;

    try {
      // While git status loads: no check that could flip to a PR, and no folding.
      await waitForSidebarThreadRow("Snoozed PR workflow");
      const pending = finishedStatusOf("Snoozed PR workflow")!;
      expect(pending.hasAttribute("data-pr-pending")).toBe(true);
      expect(pending.getAttribute("aria-label")).toBe("Open last thread, checking for a PR");
      // The plain workflow has nothing to wait for, so it folds as before.
      expect(querySidebarThreadRowByTitle("Plain workflow")).toBeNull();
      expect(document.querySelector('[data-testid="sidebar-older-toggle"]')?.textContent).toBe(
        "1 older than 7 days",
      );

      // Once loaded, the snoozed implementation thread's open PR shows and keeps it in view.
      releaseGitStatus();
      await vi.waitFor(() =>
        expect(finishedStatusOf("Snoozed PR workflow")?.textContent).toBe("#462"),
      );
      expect(finishedStatusOf("Snoozed PR workflow")?.hasAttribute("data-pr-pending")).toBe(false);
      expect(querySidebarThreadRowByTitle("Snoozed PR workflow")).not.toBeNull();
    } finally {
      releaseGitStatus();
      await mounted.cleanup();
    }
  });

  it("keeps rows quiet: no worktree icon, queue count on the right, done work dimmed", async () => {
    const worktreeId = "quiet-worktree" as ThreadId;
    const queuedId = "quiet-queued" as ThreadId;
    const archivedId = "quiet-archived" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({ id: THREAD_ID }),
          createSnapshotThread({
            id: worktreeId,
            title: "Worktree thread",
            branch: "feature/quiet",
            worktreePath: "/tmp/worktrees/quiet",
          }),
          createSnapshotThread({ id: queuedId, title: "Queued thread" }),
          createSnapshotThread({ id: archivedId, title: "Archived thread", archivedAt: NOW_ISO }),
        ]);
      },
    });
    try {
      const worktreeRow = await waitForSidebarThreadRow("Worktree thread");
      expect(document.querySelector('[data-testid^="thread-worktree-"]')).toBeNull();

      useNextTurnQueueStore.getState().applySummary({
        threads: [
          {
            threadId: queuedId,
            queuedCount: 1,
            dispatchingCount: 0,
            failedCount: 0,
            scheduledResumeAt: null,
            paused: false,
          },
        ],
      });
      const queuedRow = await waitForSidebarThreadRow("Queued thread");
      const badge = await waitForElement(
        () => queuedRow.querySelector<HTMLElement>('[aria-label="1 queued turns"]'),
        "The queued row should show its count.",
      );
      const queuedTitle = queuedRow.querySelector<HTMLElement>(
        `[data-testid="thread-title-${queuedId}"]`,
      )!;
      const plainTitle = worktreeRow.querySelector<HTMLElement>(
        `[data-testid="thread-title-${worktreeId}"]`,
      )!;
      // The count sits after the title, so both titles start at the same x.
      expect(
        queuedTitle.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(queuedTitle.getBoundingClientRect().left).toBe(
        plainTitle.getBoundingClientRect().left,
      );

      // Archived rows recede like settled ones: everything in the muted color, never opacity,
      // which would drop the (already muted) title below AA contrast.
      queryShelfSegment("archived")!.click();
      const archivedRow = await waitForSidebarThreadRow("Archived thread");
      const archivedTitle = [...archivedRow.querySelectorAll<HTMLElement>("span")].find(
        (span) => span.textContent === "Archived thread",
      )!;
      expect(archivedRow.hasAttribute("data-row-done")).toBe(true);
      expect(getComputedStyle(archivedRow).opacity).toBe("1");
      expect(getComputedStyle(archivedTitle).opacity).toBe("1");
      expect(getComputedStyle(archivedTitle).color).toBe(getComputedStyle(plainTitle).color);

      // The worktree is still described in the hover card.
      await userEvent.hover(worktreeRow);
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-testid="sidebar-peek-card"] [aria-label="Worktree"]'),
        ).not.toBeNull(),
      );
    } finally {
      useNextTurnQueueStore.setState({ byThreadId: {}, summary: { threads: [] } });
      await mounted.cleanup();
    }
  });

  it("reorders pins by dragging the yellow pin without unpinning", async () => {
    const firstId = "pin-drag-first" as ThreadId;
    const secondId = "pin-drag-second" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            createSnapshotThread({
              id: firstId,
              title: "First pin",
              pinnedAt: NOW_ISO,
              pinOrderKey: 0,
            }),
            createSnapshotThread({
              id: secondId,
              title: "Second pin",
              pinnedAt: NOW_ISO,
              pinOrderKey: 1,
            }),
          ]),
          pinRevision: 3,
        };
      },
    });
    const pinCommands = (from: number) =>
      wsRequests
        .slice(from)
        .filter(
          (entry) =>
            entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            (entry.command as { type?: string } | undefined)?.type === "thread.pins.replace",
        )
        .map((entry) => (entry.command as { pinnedThreadIds: string[] }).pinnedThreadIds);
    try {
      const firstRow = await waitForSidebarThreadRow("First pin");
      const secondRow = await waitForSidebarThreadRow("Second pin");
      const handle = secondRow.querySelector<HTMLButtonElement>(
        "[data-pinned-thread-drag-handle]",
      )!;
      const start = handle.getBoundingClientRect();
      const target = firstRow.getBoundingClientRect();
      const x = start.left + start.width / 2;
      const pointer = (type: string, clientY: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          isPrimary: true,
          pointerId: 1,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY,
        });
      const from = wsRequests.length;
      handle.dispatchEvent(pointer("pointerdown", start.top + start.height / 2));
      for (const step of [4, 10, 20]) {
        document.dispatchEvent(pointer("pointermove", start.top + start.height / 2 - step));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      document.dispatchEvent(pointer("pointermove", target.top + 2));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      document.dispatchEvent(pointer("pointerup", target.top + 2));
      // The click a released drag can fire must not unpin.
      handle.click();
      await vi.waitFor(() => expect(pinCommands(from)).toContainEqual([secondId, firstId]));
      expect(pinCommands(from).every((ids) => ids.length === 2)).toBe(true);
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("undoes an accidental unpin from the yellow pin, back to the same place", async () => {
    const ids = ["pin-undo-a", "pin-undo-b", "pin-undo-c"] as ThreadId[];
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            ...ids.map((id, index) =>
              createSnapshotThread({
                id,
                title: `Undo pin ${index}`,
                pinnedAt: NOW_ISO,
                pinOrderKey: index,
              }),
            ),
          ]),
          pinRevision: 3,
        };
      },
    });
    const pinCommands = (from: number) =>
      wsRequests
        .slice(from)
        .filter(
          (entry) =>
            entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            (entry.command as { type?: string } | undefined)?.type === "thread.pins.replace",
        )
        .map((entry) => entry.command as { pinnedThreadIds: string[]; expectedRevision: number });
    const toast = vi.spyOn(toastManager, "add");
    try {
      const middleRow = await waitForSidebarThreadRow("Undo pin 1");
      const handle = middleRow.querySelector<HTMLButtonElement>(
        "[data-pinned-thread-drag-handle]",
      )!;
      // A short press unpins.
      let from = wsRequests.length;
      await userEvent.click(handle);
      await vi.waitFor(() =>
        expect(pinCommands(from)).toEqual([
          expect.objectContaining({ pinnedThreadIds: [ids[0], ids[2]], expectedRevision: 3 }),
        ]),
      );
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
      // The server confirms the unpin. (Set directly: a domain event would advance the store's
      // applied sequence past later tests' snapshots.)
      useStore.setState((state) => ({
        pinRevision: 4,
        threads: state.threads.map((thread) =>
          thread.id === ids[1] ? { ...thread, pinnedAt: null, pinOrderKey: null } : thread,
        ),
      }));

      // The "Thread unpinned" toast's Undo puts the pin back between its old neighbours.
      const unpinnedToast = toast.mock.calls
        .map(([options]) => options)
        .find((options) => options.title === "Thread unpinned");
      expect(unpinnedToast?.actionProps?.children).toBe("Undo");
      from = wsRequests.length;
      unpinnedToast!.actionProps!.onClick!({ preventDefault: () => {} } as never);
      await vi.waitFor(() =>
        expect(pinCommands(from)).toEqual([
          expect.objectContaining({ pinnedThreadIds: ids, expectedRevision: 4 }),
        ]),
      );
    } finally {
      toast.mockRestore();
      await mounted.cleanup();
    }
  });

  it("keeps the nav strip's count badges inside the sidebar", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: ["/"],
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) =>
          body._tag === PR_HUB_WS_METHODS.getOverview
            ? {
                type: "result",
                result: {
                  status: "ok",
                  viewerLogin: null,
                  host: "github.com",
                  counts: { needs_you: 1234 },
                  coverage: [],
                  revision: "0",
                  lastPolledAt: null,
                },
              }
            : null;
      },
    });
    try {
      const navigation = await waitForElement(
        () => document.querySelector<HTMLElement>('nav[aria-label="Primary"]'),
        "The nav strip should render.",
      );
      const badge = await waitForElement(
        () =>
          [...navigation.querySelectorAll<HTMLElement>("span")].find(
            (span) => span.textContent === "1.2k",
          ) ?? null,
        "The Pull requests badge should render.",
      );
      const sidebar = navigation.closest<HTMLElement>('[data-sidebar="sidebar"]')!;
      const badgeRect = badge.parentElement!.getBoundingClientRect();
      const areaRect = sidebar.getBoundingClientRect();
      expect(badgeRect.top).toBeGreaterThanOrEqual(areaRect.top);
      expect(badgeRect.right).toBeLessThanOrEqual(areaRect.right);
    } finally {
      await mounted.cleanup();
    }
  });

  describe("peek card", () => {
    const otherId = "thread-sidebar-peek-other" as ThreadId;
    const otherTitle = "Other peek thread";
    const peekCard = () => document.querySelector<HTMLElement>('[data-testid="sidebar-peek-card"]');
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const mountWithPeekRpc = (extraThreads: SnapshotThread[] = []) =>
      mountApp({
        width: 1_400,
        initialEntries: [`/${THREAD_ID}`],
        configureFixture: (nextFixture) => {
          nextFixture.snapshot = {
            ...createSnapshot([
              createSnapshotThread({ id: THREAD_ID }),
              createSnapshotThread({ id: otherId, title: otherTitle }),
              ...extraThreads,
            ]),
            pinRevision: 7,
          };
          nextFixture.resolveWsRequest = (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.getThreadPeek
              ? {
                  type: "result",
                  result: {
                    threadId: body.threadId,
                    lastUserText: "Fix the login bug",
                    lastAssistantText: "**Done.** I fixed `auth.ts`.",
                    latestTurnDiff: { files: 2, additions: 10, deletions: 3 },
                  },
                }
              : null;
        },
      });

    it("opens after the hover delay, swaps between rows, and reads the RPC only when needed", async () => {
      const mounted = await mountWithPeekRpc();
      try {
        const otherRow = await waitForSidebarThreadRow(otherTitle);
        const ownRow = await waitForSidebarThreadRow(LONG_THREAD_TITLE);
        // Like a thread never opened in this session: only its summary is on the client.
        useStore.getState().evictThreadDetails([otherId]);
        await userEvent.hover(otherRow);
        // Nothing opens before the delay.
        await sleep(200);
        expect(peekCard()).toBeNull();
        const card = await waitForElement(peekCard, "The peek card should open after the delay.");
        await vi.waitFor(() => {
          expect(card.querySelector(`[data-peek-thread="${otherId}"]`)).not.toBeNull();
          expect(card.textContent).toContain("Fix the login bug");
          expect(card.textContent).toContain("Done. I fixed auth.ts.");
          expect(card.textContent).toContain("2 files +10 −3");
        });

        // A neighbouring row swaps the open card in place.
        await userEvent.hover(ownRow);
        await vi.waitFor(
          () => expect(card.querySelector(`[data-peek-thread="${THREAD_ID}"]`)).not.toBeNull(),
          { timeout: 2_000, interval: 16 },
        );
        expect(card.isConnected).toBe(true);
        // The open thread's details are loaded, so its card is local.
        await vi.waitFor(() => expect(card.textContent).toContain("hello"));
        expect(
          wsRequests
            .filter((request) => request._tag === ORCHESTRATION_WS_METHODS.getThreadPeek)
            .map((request) => request.threadId),
        ).toEqual([otherId]);
      } finally {
        await mounted.cleanup();
      }
    });

    it("opens on keyboard focus and stays closed with several threads selected or while renaming", async () => {
      const mounted = await mountWithPeekRpc();
      try {
        const otherRow = await waitForSidebarThreadRow(otherTitle);
        const ownRow = await waitForSidebarThreadRow(LONG_THREAD_TITLE);
        await userEvent.keyboard("{Shift}");
        otherRow.focus();
        const card = await waitForElement(peekCard, "Keyboard focus should open the card.");
        await vi.waitFor(() =>
          expect(card.querySelector(`[data-peek-thread="${otherId}"]`)).not.toBeNull(),
        );
        otherRow.blur();
        await userEvent.hover(document.body);
        await vi.waitFor(() => expect(peekCard()).toBeNull());

        const modifier = navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true };
        for (const row of [otherRow, ownRow]) {
          row.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier }),
          );
        }
        expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(2);
        await userEvent.hover(otherRow);
        await sleep(900);
        expect(peekCard()).toBeNull();
        useThreadSelectionStore.getState().clearSelection();
        await userEvent.hover(document.body);

        document
          .querySelector<HTMLElement>(`[data-testid="thread-title-${otherId}"]`)!
          .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        await waitForElement(
          () => otherRow.querySelector<HTMLInputElement>("input"),
          "Double-click should start renaming.",
        );
        await userEvent.hover(ownRow);
        await sleep(900);
        expect(peekCard()).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    });

    it("prefetches only rows the pointer rests on and reopens after a right-click", async () => {
      installDesktopBridgeMock({
        showContextMenu: (async () => null) as DesktopBridge["showContextMenu"],
      });
      const mounted = await mountWithPeekRpc();
      const peekReads = () =>
        wsRequests.filter((request) => request._tag === ORCHESTRATION_WS_METHODS.getThreadPeek)
          .length;
      try {
        const otherRow = await waitForSidebarThreadRow(otherTitle);
        const ownRow = await waitForSidebarThreadRow(LONG_THREAD_TITLE);
        useStore.getState().evictThreadDetails([otherId]);
        // Crossing a row on the way elsewhere reads nothing.
        await userEvent.hover(otherRow);
        await userEvent.hover(document.body);
        await sleep(400);
        expect(peekReads()).toBe(0);

        // A right-click's native menu swallows the pointerup; the card still opens after it.
        ownRow.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 2, buttons: 2 }),
        );
        ownRow.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
        );
        await userEvent.hover(otherRow);
        const card = await waitForElement(peekCard, "The card should open after a right-click.");
        await vi.waitFor(() => expect(card.textContent).toContain("Fix the login bug"));
        expect(peekReads()).toBe(1);
      } finally {
        await mounted.cleanup();
      }
    });

    it("opens a step's thread, or the workflow, from inside the workflow card", async () => {
      const workflowTitle = "Clickable peek workflow";
      const branchAThreadId = "clickable-peek-branch-a" as ThreadId;
      const branchBThreadId = "clickable-peek-branch-b" as ThreadId;
      const mounted = await mountApp({
        width: 1_400,
        initialEntries: [`/${THREAD_ID}`],
        configureFixture: (nextFixture) => {
          nextFixture.snapshot = {
            ...createSnapshot([
              createSnapshotThread({ id: THREAD_ID }),
              createSnapshotThread({ id: branchAThreadId, title: `${workflowTitle} Branch A` }),
              createSnapshotThread({ id: branchBThreadId, title: `${workflowTitle} Branch B` }),
            ]),
            planningWorkflows: [
              createPlanningWorkflow({ title: workflowTitle, branchAThreadId, branchBThreadId }),
            ],
          };
        },
      });
      try {
        await userEvent.hover(await waitForSidebarThreadRow(workflowTitle));
        const card = await waitForElement(peekCard, "The workflow card should open.");
        // Steps with a thread are buttons (Authoring and Revision share the branch threads);
        // Merge, which has no thread yet, is not.
        const stepButtons = [
          ...card.querySelectorAll<HTMLButtonElement>("[data-peek-step-thread]"),
        ];
        expect(new Set(stepButtons.map((button) => button.dataset.peekStepThread))).toEqual(
          new Set([branchAThreadId, branchBThreadId]),
        );
        expect(stepButtons.some((button) => button.textContent?.includes("Merge"))).toBe(false);
        expect(card.textContent).toContain("Merge");

        // A real press inside the card must not close it before the click lands.
        await userEvent.hover(stepButtons[1]!);
        await userEvent.click(stepButtons[1]!);
        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(`/${branchBThreadId}`),
        );
        await vi.waitFor(() => expect(peekCard()).toBeNull());

        await userEvent.hover(await waitForSidebarThreadRow(workflowTitle));
        const reopened = await waitForElement(peekCard, "The workflow card should reopen.");
        await userEvent.click(
          reopened.querySelector<HTMLElement>('[data-testid="sidebar-peek-workflow"] button')!,
        );
        await vi.waitFor(() => expect(mounted.router.state.location.pathname).toMatch(/workflow/u));
      } finally {
        await mounted.cleanup();
      }
    });

    it("lists a workflow's phases and steps", async () => {
      const workflowTitle = "Peek workflow";
      const branchAThreadId = "peek-workflow-branch-a" as ThreadId;
      const branchBThreadId = "peek-workflow-branch-b" as ThreadId;
      const mounted = await mountApp({
        width: 1_400,
        initialEntries: [`/${THREAD_ID}`],
        configureFixture: (nextFixture) => {
          nextFixture.snapshot = {
            ...createSnapshot([
              createSnapshotThread({ id: THREAD_ID }),
              createSnapshotThread({ id: branchAThreadId, title: `${workflowTitle} Branch A` }),
              createSnapshotThread({ id: branchBThreadId, title: `${workflowTitle} Branch B` }),
            ]),
            planningWorkflows: [
              createPlanningWorkflow({ title: workflowTitle, branchAThreadId, branchBThreadId }),
            ],
          };
        },
      });
      try {
        await userEvent.hover(await waitForSidebarThreadRow(workflowTitle));
        const card = await waitForElement(peekCard, "The workflow card should open.");
        const workflowCard = card.querySelector<HTMLElement>(
          '[data-testid="sidebar-peek-workflow"]',
        );
        expect(workflowCard?.textContent).toContain(workflowTitle);
        const phases = [...card.querySelectorAll<HTMLElement>("[data-peek-phase]")];
        expect(phases.length).toBeGreaterThan(1);
        expect(phases[0]!.dataset.peekPhase).toBe("active");
        expect(phases[0]!.textContent).toContain("Authoring");
        expect(phases[0]!.textContent).toContain("Branch A");
        expect(phases[0]!.textContent).toContain("Branch B");

        // A child row shows its role; its card also names the thread itself.
        queryButtonByAriaLabel(`Expand ${workflowTitle}`)!.click();
        await userEvent.hover(await waitForSidebarThreadRow("Branch A"));
        await vi.waitFor(() =>
          expect(
            document.querySelector('[data-testid="sidebar-peek-thread-title"]')?.textContent,
          ).toBe(`${workflowTitle} Branch A`),
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("pins and archives from quick actions, unpins from the yellow pin, and snoozes from the menu", async () => {
      const snoozeId = "thread-sidebar-peek-snooze" as ThreadId;
      const pinnedId = "thread-sidebar-peek-pinned" as ThreadId;
      const showContextMenu = vi.fn(
        async (items: ReadonlyArray<{ id: string }>) =>
          items.find((item) => item.id.startsWith("snooze:"))?.id ?? null,
      );
      installDesktopBridgeMock({
        showContextMenu: showContextMenu as unknown as DesktopBridge["showContextMenu"],
      });
      const mounted = await mountWithPeekRpc([
        createSnapshotThread({ id: snoozeId, title: "Snooze me" }),
        createSnapshotThread({
          id: pinnedId,
          title: "Pinned me",
          pinnedAt: "2026-11-01T00:00:00.000Z",
          pinOrderKey: 0,
        }),
      ]);
      const dispatched = (type: string, from: number) =>
        wsRequests
          .slice(from)
          .find(
            (entry) =>
              entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (entry.command as { type?: string } | undefined)?.type === type,
          )?.command;
      try {
        const row = await waitForSidebarThreadRow(otherTitle);
        await userEvent.hover(row);
        const quickActions = row.querySelector<HTMLElement>(
          '[data-testid="thread-row-quick-actions"]',
        )!;
        await vi.waitFor(() => expect(getComputedStyle(quickActions).display).not.toBe("none"));
        const button = (label: string) =>
          row.querySelector<HTMLButtonElement>(`button[aria-label="${label} ${otherTitle}"]`);
        const quickActionLabels = (target: HTMLElement) =>
          [
            ...target.querySelectorAll<HTMLButtonElement>(
              '[data-testid="thread-row-quick-actions"] button',
            ),
          ].map((entry) => entry.getAttribute("aria-label"));
        // Snoozing lives in the context menu only.
        expect(quickActionLabels(row)).toEqual([`Pin ${otherTitle}`, `Archive ${otherTitle}`]);

        // A pinned row unpins from its yellow pin, so its quick actions skip Unpin.
        const pinnedRow = await waitForSidebarThreadRow("Pinned me");
        await userEvent.hover(pinnedRow);
        expect(quickActionLabels(pinnedRow)).toEqual(["Archive Pinned me"]);
        const pin = pinnedRow.querySelector<HTMLButtonElement>("[data-pinned-thread-drag-handle]")!;
        expect(pin.getAttribute("aria-label")).toBe("Unpin Pinned me");
        let from = wsRequests.length;
        pin.click();
        await vi.waitFor(() =>
          expect(dispatched("thread.pins.replace", from)).toMatchObject({
            pinnedThreadIds: [],
            expectedRevision: 7,
          }),
        );
        // Unpinning does not open the row.
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);

        from = wsRequests.length;
        button("Pin")!.click();
        await vi.waitFor(() =>
          expect(
            (dispatched("thread.pins.replace", from) as { pinnedThreadIds?: string[] })
              ?.pinnedThreadIds,
          ).toContain(otherId),
        );

        from = wsRequests.length;
        button("Archive")!.click();
        await vi.waitFor(() =>
          expect(dispatched("thread.archive", from)).toMatchObject({ threadId: otherId }),
        );

        const snoozeRow = await waitForSidebarThreadRow("Snooze me");
        from = wsRequests.length;
        snoozeRow.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
        );
        await vi.waitFor(() => expect(showContextMenu).toHaveBeenCalled());
        await vi.waitFor(() =>
          expect(dispatched("thread.snooze", from)).toMatchObject({ threadId: snoozeId }),
        );
      } finally {
        await mounted.cleanup();
      }
    });
  });

  it("keeps workflow subthreads collapsed by default until the workflow is expanded", async () => {
    const workflowTitle = "Collapsed workflow";
    const branchAThreadId = "collapsed-workflow-branch-a" as ThreadId;
    const branchBThreadId = "collapsed-workflow-branch-b" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            createSnapshotThread({
              id: branchAThreadId,
              title: `${workflowTitle} Branch A`,
            }),
            createSnapshotThread({
              id: branchBThreadId,
              title: `${workflowTitle} Branch B`,
            }),
          ]),
          planningWorkflows: [
            createPlanningWorkflow({
              title: workflowTitle,
              branchAThreadId,
              branchBThreadId,
            }),
          ],
        };
      },
    });

    try {
      await waitForSidebarThreadRow(workflowTitle);
      expect(querySidebarThreadRowByTitle("Branch A")).toBeNull();
      expect(querySidebarThreadRowByTitle("Branch B")).toBeNull();

      const expandButton = await waitForElement(
        () => queryButtonByAriaLabel(`Expand ${workflowTitle}`),
        "Workflow expand button should render.",
      );
      expandButton.click();

      await waitForSidebarThreadRow("Branch A");
      expect(querySidebarThreadRowByTitle("Branch B")).toBeTruthy();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows workflow subthreads immediately when the setting enables default expansion", async () => {
    const workflowTitle = "Expanded workflow";
    const branchAThreadId = "expanded-workflow-branch-a" as ThreadId;
    const branchBThreadId = "expanded-workflow-branch-b" as ThreadId;
    seedAppSettings({
      expandWorkflowThreadsByDefault: true,
    });

    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            createSnapshotThread({
              id: branchAThreadId,
              title: `${workflowTitle} Branch A`,
            }),
            createSnapshotThread({
              id: branchBThreadId,
              title: `${workflowTitle} Branch B`,
            }),
          ]),
          planningWorkflows: [
            createPlanningWorkflow({
              title: workflowTitle,
              branchAThreadId,
              branchBThreadId,
            }),
          ],
        };
      },
    });

    try {
      await waitForSidebarThreadRow("Branch A");
      expect(querySidebarThreadRowByTitle("Branch B")).toBeTruthy();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders New thread directly after workflows even when persisted threads are newer", async () => {
    const workflowTitle = "Pinned workflow";
    const draftThreadId = "pinned-new-thread" as ThreadId;

    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [draftThreadId]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-11T11:50:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: draftThreadId,
      },
    });

    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({
              id: THREAD_ID,
              title: "Most recent persisted thread",
              createdAt: "2026-03-11T12:10:00.000Z",
              lastInteractionAt: "2026-03-11T12:10:00.000Z",
              updatedAt: "2026-03-11T12:10:00.000Z",
            }),
          ]),
          planningWorkflows: [
            createPlanningWorkflow({
              title: workflowTitle,
            }),
          ],
        };
      },
    });

    try {
      await waitForSidebarThreadRow(workflowTitle);
      await waitForSidebarThreadRow("New thread");
      await waitForSidebarThreadRow("Most recent persisted thread");

      expectSidebarTitleOrder([workflowTitle, "New thread", "Most recent persisted thread"]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("freezes recency-based sidebar reordering while the mouse stays inside the sidebar", async () => {
    const olderThreadId = "older-thread" as ThreadId;
    const newerThreadId = "newer-thread" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${newerThreadId}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({
            id: olderThreadId,
            title: "Older thread",
            createdAt: "2026-03-11T12:00:00.000Z",
            lastInteractionAt: "2026-03-11T12:00:00.000Z",
            updatedAt: "2026-03-11T12:00:00.000Z",
          }),
          createSnapshotThread({
            id: newerThreadId,
            title: "Newer thread",
            createdAt: "2026-03-11T12:05:00.000Z",
            lastInteractionAt: "2026-03-11T12:05:00.000Z",
            updatedAt: "2026-03-11T12:05:00.000Z",
          }),
        ]);
        nextFixture.welcome = {
          ...nextFixture.welcome,
          bootstrapThreadId: newerThreadId,
        };
      },
    });

    try {
      await waitForSidebarThreadRow("Newer thread");
      await waitForSidebarThreadRow("Older thread");
      expectSidebarTitleOrder(["Newer thread", "Older thread"]);

      await hoverSidebar("left");

      useStore.getState().syncServerReadModel(
        createSnapshot([
          createSnapshotThread({
            id: olderThreadId,
            title: "Older thread",
            createdAt: "2026-03-11T12:00:00.000Z",
            lastInteractionAt: "2026-03-11T12:20:00.000Z",
            updatedAt: "2026-03-11T12:20:00.000Z",
          }),
          createSnapshotThread({
            id: newerThreadId,
            title: "Newer thread",
            createdAt: "2026-03-11T12:05:00.000Z",
            lastInteractionAt: "2026-03-11T12:05:00.000Z",
            updatedAt: "2026-03-11T12:05:00.000Z",
          }),
        ]),
      );
      await waitForLayout();

      expectSidebarTitleOrder(["Newer thread", "Older thread"]);

      await unhoverSidebar("left");

      expectSidebarTitleOrder(["Older thread", "Newer thread"]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists threads that need the user in a capped Needs you section frozen under hover", async () => {
    const attentionThread = (index: number, lastInteractionAt: string) =>
      createSnapshotThread({
        id: `attention-${index}` as ThreadId,
        title: `Attention ${index}`,
        createdAt: "2026-03-11T12:00:00.000Z",
        lastInteractionAt,
        updatedAt: lastInteractionAt,
        ...createPlanReadyOverrides(String(index)),
      });
    const minute = (value: number) => `2026-03-11T12:${String(value).padStart(2, "0")}:00.000Z`;
    const initialThreads = [
      createSnapshotThread({ id: THREAD_ID, title: "Quiet thread" }),
      ...Array.from({ length: 6 }, (_, index) => attentionThread(index, minute(index + 1))),
    ];
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot(initialThreads);
      },
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>("[data-testid='sidebar-attention-section']"),
        "Needs you section should render when threads wait on the user.",
      );
      const visibleIds = () =>
        queryAttentionRows().map((row) => row.dataset.testid?.replace("attention-thread-row-", ""));
      expect(visibleIds()).toEqual([
        "attention-5",
        "attention-4",
        "attention-3",
        "attention-2",
        "attention-1",
      ]);
      expect(querySidebarButtonByText("Show all (6)")).not.toBeNull();
      for (const row of queryAttentionRows()) {
        expect(row.hasAttribute("data-thread-item")).toBe(false);
      }
      // The project list still owns the canonical row and its test id.
      expect(document.querySelectorAll("[data-testid='thread-row-attention-5']")).toHaveLength(1);
      expect(document.querySelector("[data-testid='attention-thread-row-thread-1']")).toBeNull();

      await hoverSidebar("left");
      useStore
        .getState()
        .syncServerReadModel(
          createSnapshot([
            createSnapshotThread({ id: THREAD_ID, title: "Quiet thread" }),
            ...Array.from({ length: 5 }, (_, index) =>
              attentionThread(index + 1, minute(index + 2)),
            ),
            attentionThread(0, minute(30)),
          ]),
        );
      await waitForLayout();
      expect(visibleIds()[0]).toBe("attention-5");

      await unhoverSidebar("left");
      await vi.waitFor(() => expect(visibleIds()[0]).toBe("attention-0"), {
        timeout: 8_000,
        interval: 16,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("targets the open thread's project from the primary New thread and New workflow actions", async () => {
    const secondProjectId = "project-2" as ProjectId;
    const secondThreadId = "thread-sidebar-primary-actions" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${secondThreadId}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID, title: "Project One thread" }),
            createSnapshotThread({
              id: secondThreadId,
              projectId: secondProjectId,
              title: "Project Two thread",
              lastInteractionAt: "2026-03-01T00:00:00.000Z",
            }),
          ]),
          projects: [
            createSnapshotProject(PROJECT_ID, "Project One"),
            createSnapshotProject(secondProjectId, "Project Two"),
          ],
        };
        nextFixture.welcome = {
          ...nextFixture.welcome,
          bootstrapProjectId: secondProjectId,
          bootstrapThreadId: secondThreadId,
        };
      },
    });

    try {
      const newWorkflow = await waitForElement(
        () => document.querySelector<HTMLButtonElement>("[data-testid='sidebar-new-workflow']"),
        "Primary New workflow action should render.",
      );
      newWorkflow.click();
      await vi.waitFor(
        () => expect(useWorkflowCreateDialogStore.getState().projectId).toBe(secondProjectId),
        { timeout: 8_000, interval: 16 },
      );
      useWorkflowCreateDialogStore.getState().close();

      const newThread = await waitForElement(
        () => document.querySelector<HTMLButtonElement>("[data-testid='sidebar-new-thread']"),
        "Primary New thread action should render.",
      );
      newThread.click();
      const newThreadPath = await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "Primary New thread should navigate to a draft thread route.",
      );
      expect(
        useComposerDraftStore.getState().getDraftThreadByProjectId(secondProjectId)?.threadId,
      ).toBe(newThreadPath.slice(1));
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a newly created New thread immediately in the pinned slot while the sidebar is frozen", async () => {
    const workflowTitle = "Hover workflow";
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({
              id: THREAD_ID,
              title: "Existing thread",
              createdAt: "2026-03-11T12:10:00.000Z",
              lastInteractionAt: "2026-03-11T12:10:00.000Z",
              updatedAt: "2026-03-11T12:10:00.000Z",
            }),
          ]),
          planningWorkflows: [
            createPlanningWorkflow({
              title: workflowTitle,
            }),
          ],
        };
      },
    });

    try {
      await waitForSidebarThreadRow(workflowTitle);
      await waitForSidebarThreadRow("Existing thread");
      await hoverSidebar("left");

      await page.getByTestId("new-thread-button").click();
      await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "Route should switch to the draft thread after opening it while hovered.",
      );
      await waitForSidebarThreadRow("New thread");

      expectSidebarTitleOrder([workflowTitle, "New thread", "Existing thread"]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a draft row visible after navigating away within the same project", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
    });

    try {
      await page.getByTestId("new-thread-button").click();
      await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "Route should switch to the draft thread after opening it.",
      );

      const persistedThreadRow = await waitForSidebarThreadRow(LONG_THREAD_TITLE);
      persistedThreadRow.click();

      await waitForPath(
        mounted.router,
        (pathname) => pathname === `/${THREAD_ID}`,
        "Route should switch back to the persisted thread.",
      );
      expect(querySidebarThreadRowsByTitle("New thread")).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows normal thread status pills on grouped workflow subthreads", async () => {
    const workflowTitle = "Workflow status test";
    const branchAThreadId = "workflow-branch-a" as ThreadId;
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = {
          ...createSnapshot([
            createSnapshotThread({ id: THREAD_ID }),
            createSnapshotThread({
              id: branchAThreadId,
              title: `${workflowTitle} Branch A`,
              createdAt: "2026-03-11T11:59:00.000Z",
              lastInteractionAt: "2026-03-11T11:59:00.000Z",
              updatedAt: "2026-03-11T11:59:00.000Z",
              session: {
                threadId: branchAThreadId,
                status: "running",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: "turn-1" as never,
                lastError: null,
                updatedAt: "2026-03-11T11:59:00.000Z",
              },
            }),
            createSnapshotThread({
              id: "workflow-branch-b" as ThreadId,
              title: `${workflowTitle} Branch B`,
              createdAt: "2026-03-11T11:58:00.000Z",
              lastInteractionAt: "2026-03-11T11:58:00.000Z",
              updatedAt: "2026-03-11T11:58:00.000Z",
            }),
          ]),
          planningWorkflows: [
            createPlanningWorkflow({
              title: workflowTitle,
              branchAThreadId,
              branchBThreadId: "workflow-branch-b" as ThreadId,
            }),
          ],
        };
      },
    });

    try {
      const expandButton = await waitForElement(
        () => queryButtonByAriaLabel(`Expand ${workflowTitle}`),
        "Workflow expand button should render before grouped subthreads are visible.",
      );
      expandButton.click();

      const workflowRow = await waitForSidebarThreadRow("Branch A");
      expect(workflowRow.textContent).toContain("Working");

      workflowRow.click();

      await waitForPath(
        mounted.router,
        (pathname) => pathname === `/${branchAThreadId}`,
        "Workflow thread row should navigate to the workflow thread.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates a persisted draft row from local storage", async () => {
    const draftThreadId = "persisted-sidebar-draft" as ThreadId;
    seedPersistedDraftStorage(draftThreadId);
    await useComposerDraftStore.persist.rehydrate();

    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
    });

    try {
      await waitForSidebarThreadRow("New thread");
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId).toBe(
        draftThreadId,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("avoids duplicate sidebar rows when a draft is promoted to a persisted thread", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
    });

    try {
      await page.getByTestId("new-thread-button").click();
      const draftPath = await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "Route should switch to the draft thread after opening it.",
      );
      const draftThreadId = draftPath.slice(1) as ThreadId;

      expect(querySidebarThreadRowsByTitle("New thread")).toHaveLength(1);

      useStore.getState().syncServerReadModel(addThreadToSnapshot(fixture.snapshot, draftThreadId));
      useComposerDraftStore.getState().clearDraftThread(draftThreadId);
      await waitForLayout();

      expect(mounted.router.state.location.pathname).toBe(draftPath);
      expect(querySidebarThreadRowsByTitle("New thread")).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("treats modifier clicks on draft rows like plain focus instead of multi-select", async () => {
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
    });

    try {
      await page.getByTestId("new-thread-button").click();
      const draftPath = await waitForPath(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "Route should switch to the draft thread after opening it.",
      );
      const persistedThreadRow = await waitForSidebarThreadRow(LONG_THREAD_TITLE);
      const draftThreadRow = await waitForSidebarThreadRow("New thread");

      persistedThreadRow.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          metaKey: true,
        }),
      );
      await waitForLayout();
      expect(useThreadSelectionStore.getState().selectedThreadIds).toEqual(new Set([THREAD_ID]));

      draftThreadRow.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          metaKey: true,
        }),
      );
      await waitForLayout();
      expect(mounted.router.state.location.pathname).toBe(draftPath);
      expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(0);
      expect(useThreadSelectionStore.getState().anchorThreadId).toBeNull();

      persistedThreadRow.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          metaKey: true,
        }),
      );
      await waitForLayout();
      expect(useThreadSelectionStore.getState().selectedThreadIds).toEqual(new Set([THREAD_ID]));

      draftThreadRow.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          shiftKey: true,
        }),
      );
      await waitForLayout();
      expect(mounted.router.state.location.pathname).toBe(draftPath);
      expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(0);
      expect(useThreadSelectionStore.getState().anchorThreadId).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the configured sidebar thread preview count", async () => {
    seedAppSettings({ sidebarThreadPreviewCount: 3 });
    const previewThreads = Array.from({ length: 6 }, (_, index) =>
      createSnapshotThread({
        id: `configured-preview-thread-${index}` as ThreadId,
        title: `Configured preview thread ${index}`,
        createdAt: `2026-03-11T12:0${index}:00.000Z`,
        lastInteractionAt: `2026-03-11T12:0${index}:00.000Z`,
        updatedAt: `2026-03-11T12:0${index}:00.000Z`,
      }),
    ).toReversed();

    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${previewThreads[0]!.id}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot(previewThreads);
        nextFixture.welcome = {
          ...nextFixture.welcome,
          bootstrapThreadId: previewThreads[0]!.id,
        };
      },
    });

    try {
      await waitForSidebarThreadRow("Configured preview thread 5");
      expect(querySidebarThreadRowByTitle("Configured preview thread 3")).toBeTruthy();
      expect(querySidebarThreadRowByTitle("Configured preview thread 2")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });
  it("isolates terminal updates from the sidebar and another thread's chat", async () => {
    const otherId = ThreadId.makeUnsafe("background-terminal");
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({ id: THREAD_ID, title: "Visible thread" }),
          createSnapshotThread({ id: otherId, title: "Background terminal" }),
        ]);
      },
    });
    try {
      const row = page.elementLocator(await waitForSidebarThreadRow("Background terminal"));
      const terminal = useTerminalStateStore.getState();
      terminal.ensureTerminal(otherId, "default");
      terminal.setTerminalActivity(otherId, "default", true);
      await expect
        .element(
          row.getByRole("button", {
            name: "Terminal process running. Show terminal",
          }),
        )
        .toBeVisible();
      const sidebar = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-sidebar-root][data-render-count]"),
        "Sidebar render probe should render.",
      );
      const chat = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-chat-view-thread-id="${THREAD_ID}"][data-render-count]`,
          ),
        "Chat render probe should render.",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const before = [sidebar.dataset.renderCount, chat.dataset.renderCount];
      for (let update = 0; update < 10; update++) {
        terminal.setTerminalHeight(otherId, 300 + update);
        terminal.setTerminalOpen(otherId, update % 2 === 0);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }
      expect([sidebar.dataset.renderCount, chat.dataset.renderCount]).toEqual(before);
      terminal.setTerminalActivity(otherId, "default", false);
      await expect
        .element(
          row.getByRole("button", {
            name: "Terminal process running. Show terminal",
          }),
        )
        .not.toBeInTheDocument();
    } finally {
      useTerminalStateStore.getState().clearTerminalState(otherId);
      await mounted.cleanup();
    }
  });

  it("does not re-render the sidebar or an inactive chat view while another thread streams", async () => {
    const streamingThreadId = "thread-sidebar-streaming" as ThreadId;
    const streamingTitle = "Background streaming thread";
    const mounted = await mountApp({
      width: 1_400,
      initialEntries: [`/${THREAD_ID}`],
      configureFixture: (nextFixture) => {
        nextFixture.snapshot = createSnapshot([
          createSnapshotThread({ id: THREAD_ID, title: "Visible thread" }),
          createSnapshotThread({
            id: streamingThreadId,
            title: streamingTitle,
            lastInteractionAt: "2026-03-11T12:05:00.000Z",
          }),
        ]);
      },
    });

    try {
      await waitForSidebarThreadRow(streamingTitle);
      const sidebarRoot = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-sidebar-root][data-render-count]"),
        "Sidebar render probe should render.",
      );
      const chatView = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-chat-view-thread-id="${THREAD_ID}"][data-render-count]`,
          ),
        "Chat view render probe should render.",
      );
      // Let startup work (detail loads, settings, queue hydration) settle.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const sidebarRendersBefore = sidebarRoot.dataset.renderCount;
      const chatViewRendersBefore = chatView.dataset.renderCount;
      const streamingThreadBefore = useStore
        .getState()
        .threads.find((thread) => thread.id === streamingThreadId);

      const baseSequence = useStore.getState().lastAppliedSequence;
      for (let delta = 1; delta <= 3; delta += 1) {
        const occurredAt = `2026-03-11T12:05:0${delta}.000Z`;
        useStore.getState().applyDomainEvent({
          sequence: baseSequence + delta,
          eventId: `event-background-delta-${delta}` as never,
          aggregateKind: "thread",
          aggregateId: streamingThreadId,
          occurredAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId: streamingThreadId,
            messageId: "msg-background-assistant" as MessageId,
            role: "assistant",
            text: "token ".repeat(delta),
            attachments: undefined,
            turnId: null,
            streaming: true,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
        });
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }

      const streamingThreadAfter = useStore
        .getState()
        .threads.find((thread) => thread.id === streamingThreadId);
      expect(streamingThreadAfter).not.toBe(streamingThreadBefore);
      expect(streamingThreadAfter?.lastInteractionAt).toBe("2026-03-11T12:05:03.000Z");
      expect(sidebarRoot.dataset.renderCount).toBe(sidebarRendersBefore);
      expect(chatView.dataset.renderCount).toBe(chatViewRendersBefore);
    } finally {
      await mounted.cleanup();
    }
  });
});
