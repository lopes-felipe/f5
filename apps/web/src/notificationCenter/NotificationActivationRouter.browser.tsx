import type { DesktopBridge, DesktopNotificationActivation } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { NotificationActivationRouter } from "./NotificationActivationRouter";

vi.mock("~/lib/startupReady", () => ({ useStartupReady: () => true }));

function installBridge(initial: DesktopNotificationActivation[] = []) {
  let queue = [...initial];
  const listeners = new Set<() => void>();
  const takeActivations = vi.fn(async () => {
    const taken = queue;
    queue = [];
    return taken;
  });
  window.desktopBridge = {
    notifications: {
      show: vi.fn(async () => true),
      takeActivations,
      onActivationsAvailable: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as DesktopBridge;
  return {
    takeActivations,
    listenerCount: () => listeners.size,
    click(activation: DesktopNotificationActivation) {
      queue.push(activation);
      for (const listener of listeners) listener();
    },
    queueOnly(activation: DesktopNotificationActivation) {
      queue.push(activation);
    },
  };
}

async function mount() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <NotificationActivationRouter />
        <Outlet />
      </>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
    createRoute({ getParentRoute: () => rootRoute, path: "/pull-requests", component: () => null }),
    createRoute({ getParentRoute: () => rootRoute, path: "/$threadId", component: () => null }),
  ]);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree,
  });
  const screen = await render(<RouterProvider router={router} />);
  return { router, screen };
}

const thread = (id: string, threadId: string): DesktopNotificationActivation => ({
  id,
  target: { kind: "thread", threadId },
});

describe("NotificationActivationRouter", () => {
  afterEach(() => {
    delete window.desktopBridge;
  });

  it("opens a click queued before the window loaded", async () => {
    installBridge([thread("a", "thread-early")]);
    const { router, screen } = await mount();
    await expect.poll(() => router.state.location.pathname).toBe("/thread-early");
    await screen.unmount();
  });

  it("opens the last target when told, and takes again on focus", async () => {
    const bridge = installBridge();
    const { router, screen } = await mount();
    await expect.poll(() => bridge.takeActivations.mock.calls.length).toBeGreaterThan(0);

    bridge.click(thread("a", "thread-1"));
    await expect.poll(() => router.state.location.pathname).toBe("/thread-1");

    bridge.queueOnly({ id: "b", target: { kind: "prHub", prKey: "o/r#1" } });
    bridge.queueOnly({ id: "c", target: { kind: "none" } });
    window.dispatchEvent(new Event("focus"));
    await expect.poll(() => router.state.location.pathname).toBe("/pull-requests");
    expect(router.state.location.search).toEqual({ pr: "o/r#1" });
    await screen.unmount();
  });

  it("stops listening when unmounted", async () => {
    const bridge = installBridge();
    const { screen } = await mount();
    await expect.poll(() => bridge.listenerCount()).toBe(1);
    await screen.unmount();
    expect(bridge.listenerCount()).toBe(0);
    const calls = bridge.takeActivations.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    expect(bridge.takeActivations.mock.calls.length).toBe(calls);
  });
});
