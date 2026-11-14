import { unlockThreadNotificationSound } from "../threadAttention";
import { ToastProvider, toastManager } from "./ui/toast";
import { registerApprovalResponder, registerNotificationHost } from "../notificationCenter/notify";
import { NotificationCenterHost } from "../notificationCenter/NotificationCenterHost";
import { focusAppWindow } from "../notificationCenter/openTarget";
import "../index.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import {
  SCHEDULED_TASK_TURN_SUBMITTED_ACTIVITY_KIND,
  type ProjectId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => ({
  findRunForTurn: vi.fn(),
  getThreadTailDetails: vi.fn(),
}));
vi.mock("../nativeApi", async (importOriginal) => {
  const api = () => ({
    scheduledTasks: { findRunForTurn: nativeApi.findRunForTurn },
    orchestration: { getThreadTailDetails: nativeApi.getThreadTailDetails },
  });
  return {
    ...(await importOriginal<typeof import("../nativeApi")>()),
    ensureNativeApi: api,
    readNativeApi: api,
  };
});

import { StoreProvider, useStore } from "../store";
import type { Thread } from "../types";
import { ThreadStatusNotificationControllerContent } from "./ThreadStatusNotificationController";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const THREAD_STATUS_NOTIFICATION_PROMPT_STORAGE_KEY = "t3code:thread-status-notification-prompt:v1";
const PROJECT_ID = "project-browser" as ProjectId;
const THREAD_ID = "thread-browser" as ThreadId;

let hasFocus = true;
let visibilityState: DocumentVisibilityState = "visible";

class MockNotification {
  static permission: NotificationPermission = "default";
  static instances: MockNotification[] = [];
  static requestPermission = vi.fn(async () => MockNotification.permission);

  clickListener: ((event: Event) => void) | null = null;
  close = vi.fn();

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    MockNotification.instances.push(this);
  }

  static reset() {
    MockNotification.permission = "default";
    MockNotification.instances = [];
    MockNotification.requestPermission.mockReset();
    MockNotification.requestPermission.mockImplementation(async () => MockNotification.permission);
  }

  addEventListener(type: "click", listener: (event: Event) => void) {
    this.clickListener = listener;
  }
}

function createThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Audit status transitions",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "ready",
      createdAt: "2026-03-10T12:00:00.000Z",
      updatedAt: "2026-03-10T12:00:00.000Z",
      orchestrationStatus: "ready",
    },
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    error: null,
    createdAt: "2026-03-10T12:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-03-10T12:00:00.000Z",
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    lastVisitedAt: "2026-03-10T12:00:00.000Z",
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    sessionNotes: null,
    threadReferences: [],
    ...overrides,
  };
}

function setNotificationSetting(enabled: boolean) {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      enableThreadStatusNotifications: enabled,
    }),
  );
}

function setStoreThread(thread: Thread, threadsHydrated = true) {
  useStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        name: "Repo",
        cwd: "/repo",
        model: "gpt-5.4",
        createdAt: "2026-03-10T12:00:00.000Z",
        expanded: true,
        scripts: [],
        memories: [],
      },
    ],
    threads: [thread],
    threadsHydrated,
  });
}

function findButton(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | null;
}

async function mountController() {
  const host = document.createElement("div");
  document.body.append(host);
  const navigateToThread = vi.fn();
  // Notifications open their target through the registered host; the app's host navigates.
  const unregisterHost = registerNotificationHost({
    openTarget: (target) => {
      focusAppWindow();
      if (target.kind === "thread") navigateToThread(target.threadId);
    },
    activeThreadId: () => null,
    playSound: () => undefined,
  });
  // The permission prompt renders as a toast, so the harness mounts the toast stack too.
  const rootRoute = createRootRoute({
    component: () => (
      <ToastProvider>
        <StoreProvider>
          <ThreadStatusNotificationControllerContent />
        </StoreProvider>
      </ToastProvider>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  const screen = await render(<RouterProvider router={router} />, { container: host });

  return {
    host,
    navigateToThread,
    cleanup: async () => {
      await screen.unmount();
      unregisterHost();
      host.remove();
    },
  };
}

describe("ThreadStatusNotificationController", () => {
  beforeEach(() => {
    localStorage.clear();
    setNotificationSetting(true);
    useStore.setState({ projects: [], threads: [], threadsHydrated: false });
    MockNotification.reset();
    nativeApi.findRunForTurn.mockReset();
    nativeApi.getThreadTailDetails.mockReset();
    nativeApi.getThreadTailDetails.mockResolvedValue({ activities: [] });
    hasFocus = true;
    visibilityState = "visible";

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    document.hasFocus = () => hasFocus;

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: MockNotification,
    });
  });

  afterEach(() => {
    localStorage.removeItem(THREAD_STATUS_NOTIFICATION_PROMPT_STORAGE_KEY);
    document.body.innerHTML = "";
  });

  it("shows the permission CTA when enabled and permission has not been requested", async () => {
    const mounted = await mountController();

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Enable notifications");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("requests permission from the CTA action", async () => {
    MockNotification.requestPermission.mockImplementation(async () => {
      MockNotification.permission = "granted";
      return "granted";
    });

    const mounted = await mountController();

    try {
      const button = findButton("Enable notifications");
      expect(button).toBeTruthy();
      button?.click();

      await vi.waitFor(() => {
        expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not show the CTA again after a reload when the user ignored it", async () => {
    const firstMount = await mountController();

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Enable notifications");
      });
    } finally {
      await firstMount.cleanup();
    }

    const secondMount = await mountController();

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain("Enable notifications");
      });
    } finally {
      await secondMount.cleanup();
    }
  });

  it("dispatches a notification for a status transition while the app is hidden", async () => {
    const revealWindow = vi.fn(async () => undefined);
    vi.stubGlobal("desktopBridge", { revealWindow });
    MockNotification.permission = "granted";
    hasFocus = false;
    visibilityState = "hidden";

    const mounted = await mountController();

    try {
      setStoreThread(createThread(), true);

      await vi.waitFor(() => {
        expect(MockNotification.instances).toHaveLength(0);
      });

      setStoreThread(
        createThread({
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-10T12:00:00.000Z",
            updatedAt: "2026-03-10T12:01:00.000Z",
            orchestrationStatus: "running",
          },
          activities: [
            {
              id: "activity-1" as never,
              tone: "approval",
              kind: "approval.requested",
              summary: "Needs approval",
              payload: {
                requestId: "request-1",
                requestKind: "command",
              },
              turnId: null,
              createdAt: "2026-03-10T12:01:00.000Z",
            },
          ],
        }),
        true,
      );

      await vi.waitFor(() => {
        expect(MockNotification.instances).toHaveLength(1);
        expect(MockNotification.instances[0]?.title).toBe("Pending Approval");
        expect(MockNotification.instances[0]?.options?.body).toBe(
          "Repo · Audit status transitions",
        );
      });
      MockNotification.instances[0]?.clickListener?.(new Event("click"));
      expect(revealWindow).toHaveBeenCalledTimes(1);
      expect(mounted.navigateToThread).toHaveBeenCalledWith(THREAD_ID);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not keep prompting after the user denies permission", async () => {
    MockNotification.requestPermission.mockImplementation(async () => {
      MockNotification.permission = "denied";
      return "denied";
    });

    const mounted = await mountController();

    try {
      const button = findButton("Enable notifications");
      expect(button).toBeTruthy();
      button?.click();

      await vi.waitFor(() => {
        expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).not.toContain("Enable notifications");
      });

      window.dispatchEvent(new Event("focus"));

      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain("Enable notifications");
      });
    } finally {
      await mounted.cleanup();
    }
  });
  it("shows in-app attention without system permission and suppresses snoozed threads", async () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        notificationMode: "off",
        inAppThreadNotifications: true,
        showAttentionBadge: true,
      }),
    );
    MockNotification.permission = "denied";
    const badge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: badge });
    const toast = vi.spyOn(toastManager, "add");
    const mounted = await mountController();
    try {
      setStoreThread(createThread(), true);
      await vi.waitFor(() => expect(useStore.getState().threadsHydrated).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const pending = createThread({
        activities: [
          {
            id: "attention" as never,
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval",
            payload: { requestId: "request", requestKind: "command" },
            turnId: null,
            createdAt: "2026-03-10T12:01:00.000Z",
          },
        ],
      });
      setStoreThread({ ...pending, snoozedUntil: "2099-01-01T00:00:00Z" }, true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(toast).not.toHaveBeenCalled();
      expect(MockNotification.instances).toHaveLength(0);
      setStoreThread(createThread(), true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      setStoreThread(pending, true);
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Pending Approval",
            data: expect.objectContaining({
              source: "thread",
              threadStatus: "pending-approval",
              urgent: true,
            }),
          }),
        ),
      );
      expect(badge).toHaveBeenLastCalledWith(1);
      expect(MockNotification.instances).toHaveLength(0);
    } finally {
      await mounted.cleanup();
      toast.mockRestore();
      Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: undefined });
    }
  });

  it("answers a single command approval from the toast", async () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ notificationMode: "off", inAppThreadNotifications: true }),
    );
    const approvalActivity = {
      id: "approval-activity" as never,
      tone: "approval" as const,
      kind: "approval.requested",
      summary: "Approval",
      payload: { requestId: "request-inline", requestKind: "command", detail: "bun install" },
      turnId: null,
      createdAt: "2026-03-10T12:01:00.000Z",
    };
    nativeApi.getThreadTailDetails.mockResolvedValue({ activities: [approvalActivity] });
    const responder = vi.fn(async () => undefined);
    const unregisterResponder = registerApprovalResponder(responder);
    const mounted = await mountController();
    try {
      setStoreThread(createThread(), true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      setStoreThread(createThread({ activities: [approvalActivity] }), true);
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="toast-detail"]')?.textContent).toBe(
          "bun install",
        );
        expect(findButton("Approve")).toBeTruthy();
      });
      findButton("Approve")!.click();
      await vi.waitFor(() => {
        expect(responder).toHaveBeenCalledWith(
          expect.objectContaining({ threadId: THREAD_ID, requestId: "request-inline" }),
          "accept",
        );
        expect(findButton("Approve")).toBeFalsy();
      });
    } finally {
      unregisterResponder();
      await mounted.cleanup();
    }
  });

  it("drops an approval notice whose request was answered while it was being looked up", async () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ notificationMode: "off", inAppThreadNotifications: true }),
    );
    const approvalActivity = {
      id: "approval-activity" as never,
      tone: "approval" as const,
      kind: "approval.requested",
      summary: "Approval",
      payload: { requestId: "request-stale", requestKind: "command", detail: "bun install" },
      turnId: null,
      createdAt: "2026-03-10T12:01:00.000Z",
    };
    let finishLookup: (value: { activities: unknown[] }) => void = () => undefined;
    nativeApi.getThreadTailDetails.mockImplementation(
      () => new Promise((resolve) => (finishLookup = resolve)),
    );
    const toast = vi.spyOn(toastManager, "add");
    const mounted = await mountController();
    try {
      setStoreThread(createThread(), true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      setStoreThread(createThread({ activities: [approvalActivity] }), true);
      await vi.waitFor(() => expect(nativeApi.getThreadTailDetails).toHaveBeenCalled());
      // Answered in the chat before the lookup returns: the thread is working again.
      setStoreThread(createThread(), true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      finishLookup({ activities: [approvalActivity] });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(toast).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Pending Approval" }),
      );
    } finally {
      toast.mockRestore();
      await mounted.cleanup();
    }
  });

  it("closes an urgent toast without inline buttons when the thread moves on", async () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ notificationMode: "off", inAppThreadNotifications: true }),
    );
    // Two requests at once: no inline buttons, so only the thread moving on can close it.
    const activity = (requestId: string) => ({
      id: `approval-${requestId}` as never,
      tone: "approval" as const,
      kind: "approval.requested",
      summary: "Approval",
      payload: { requestId, requestKind: "command" },
      turnId: null,
      createdAt: "2026-03-10T12:01:00.000Z",
    });
    const activities = [activity("one"), activity("two")];
    nativeApi.getThreadTailDetails.mockResolvedValue({ activities });
    const close = vi.spyOn(toastManager, "close");
    const toast = vi.spyOn(toastManager, "add");
    const mounted = await mountController();
    try {
      setStoreThread(createThread(), true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      setStoreThread(createThread({ activities }), true);
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Pending Approval" })),
      );
      const toastId = toast.mock.results.find(
        (_result, index) => toast.mock.calls[index]![0].title === "Pending Approval",
      )!.value as string;
      setStoreThread(createThread(), true);
      await vi.waitFor(() => expect(close).toHaveBeenCalledWith(toastId));
    } finally {
      toast.mockRestore();
      close.mockRestore();
      await mounted.cleanup();
    }
  });

  describe("scheduled runs in a conversation", () => {
    const turnId = "turn-scheduled" as TurnId;
    const scheduledActivity = {
      id: "scheduled-activity:submission" as never,
      tone: "info" as const,
      kind: SCHEDULED_TASK_TURN_SUBMITTED_ACTIVITY_KIND,
      summary: 'Queued by scheduled task "Daily check"',
      payload: {},
      turnId: null,
      createdAt: "2026-03-10T12:00:30.000Z",
    };
    async function transition(overrides: Partial<Thread>) {
      MockNotification.permission = "granted";
      hasFocus = false;
      visibilityState = "hidden";
      const mounted = await mountController();
      const base = {
        latestTurn: {
          turnId,
          state: "running" as const,
          assistantMessageId: null,
          requestedAt: "2026-03-10T12:00:30.000Z",
          startedAt: "2026-03-10T12:00:30.000Z",
          completedAt: null,
        },
        ...overrides,
      };
      setStoreThread(createThread(base), true);
      // Let the controller record the starting status before the transition.
      await new Promise((resolve) => setTimeout(resolve, 50));
      setStoreThread(
        createThread({
          ...base,
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-10T12:00:00.000Z",
            updatedAt: "2026-03-10T12:01:00.000Z",
            orchestrationStatus: "running",
          },
          activities: [
            ...(base.activities ?? []),
            {
              id: "activity-approval" as never,
              tone: "approval",
              kind: "approval.requested",
              summary: "Needs approval",
              payload: { requestId: "request-1", requestKind: "command" },
              turnId,
              createdAt: "2026-03-10T12:01:00.000Z",
            },
          ],
        }),
        true,
      );
      return mounted;
    }

    it("leaves a scheduled turn's notice to the scheduler", async () => {
      nativeApi.findRunForTurn.mockResolvedValue({ runId: "run" });
      const mounted = await transition({ activities: [scheduledActivity] });
      try {
        await vi.waitFor(() =>
          expect(nativeApi.findRunForTurn).toHaveBeenCalledWith({ threadId: THREAD_ID, turnId }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(MockNotification.instances).toHaveLength(0);
      } finally {
        await mounted.cleanup();
      }
    });

    it("notifies for the user's own turns in the same conversation", async () => {
      nativeApi.findRunForTurn.mockResolvedValue({ runId: null });
      const mounted = await transition({ activities: [scheduledActivity] });
      try {
        await vi.waitFor(() => expect(MockNotification.instances).toHaveLength(1));
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps the notice when the run lookup fails", async () => {
      nativeApi.findRunForTurn.mockRejectedValue(new Error("offline"));
      const mounted = await transition({ activities: [scheduledActivity] });
      try {
        await vi.waitFor(() => expect(MockNotification.instances).toHaveLength(1));
      } finally {
        await mounted.cleanup();
      }
    });

    // Background conversations load without activities, so only the server knows the turn's origin.
    it("asks the server when the conversation's activities are not loaded", async () => {
      nativeApi.findRunForTurn.mockResolvedValue({ runId: "run" });
      const scheduled = await transition({ detailsLoaded: false });
      try {
        await vi.waitFor(() =>
          expect(nativeApi.findRunForTurn).toHaveBeenCalledWith({ threadId: THREAD_ID, turnId }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(MockNotification.instances).toHaveLength(0);
      } finally {
        await scheduled.cleanup();
      }
      nativeApi.findRunForTurn.mockResolvedValue({ runId: null });
      const ordinary = await transition({ detailsLoaded: false });
      try {
        await vi.waitFor(() => expect(MockNotification.instances).toHaveLength(1));
      } finally {
        await ordinary.cleanup();
      }
    });
  });
});

it("unlocks controller audio synchronously in the sound settings gesture", async () => {
  const resume = vi.fn().mockResolvedValue(undefined),
    close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal(
    "AudioContext",
    class {
      resume = resume;
      close = close;
    },
  );
  // The notification host owns the chime now.
  const rootRoute = createRootRoute({ component: () => <NotificationCenterHost /> });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  const screen = await render(<RouterProvider router={router} />);
  try {
    await vi.waitFor(() => expect(router.state.status).toBe("idle"));
    unlockThreadNotificationSound();
    expect(resume).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
    vi.unstubAllGlobals();
  }
  expect(close).toHaveBeenCalled();
});

import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
it.each(["settlement", "expiry"] as const)(
  "raises computer consent attention and clears it on %s",
  async (ending) => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        notificationMode: "off",
        inAppThreadNotifications: true,
        showAttentionBadge: true,
      }),
    );
    useStore.setState({ projects: [], threads: [], threadsHydrated: false });
    const badge = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: badge });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: clear });
    const mounted = await mountController();
    const store = useAgentComputerActivityStore.getState();
    try {
      setStoreThread(createThread(), true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      store.request({
        requestId: "computer-attention",
        backendIncarnation: "b",
        threadId: THREAD_ID,
        kind: "apps",
        apps: [],
        reason: "Test",
        ...(ending === "expiry" ? { expiresAtMs: Date.now() + 350 } : {}),
      });
      await vi.waitFor(() => expect(badge).toHaveBeenLastCalledWith(1));
      clear.mockClear();
      if (ending === "settlement")
        store.settle({ requestId: "computer-attention", threadId: THREAD_ID, allowed: false });
      await vi.waitFor(() => expect(clear).toHaveBeenCalled());
      if (ending === "expiry")
        expect(
          useAgentComputerActivityStore.getState().requests["computer-attention"]?.settled,
        ).toBeUndefined();
    } finally {
      store.resetConnection();
      await mounted.cleanup();
      Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: undefined });
      Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: undefined });
    }
  },
);
