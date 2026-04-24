import "../index.css";

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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
  const screen = await render(
    <StoreProvider>
      <ThreadStatusNotificationControllerContent navigateToThread={navigateToThread} />
    </StoreProvider>,
    { container: host },
  );

  return {
    host,
    navigateToThread,
    cleanup: async () => {
      await screen.unmount();
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
});
