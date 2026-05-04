import "../../index.css";

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

import { AnchoredToastProvider, anchoredToastManager, ToastProvider, toastManager } from "./toast";

function createTestRouter() {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: ToastHarness,
  });

  return createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([indexRoute]),
  });
}

function ToastHarness() {
  return (
    <>
      <ToastProvider>
        <span />
      </ToastProvider>
      <AnchoredToastProvider>
        <span />
      </AnchoredToastProvider>
    </>
  );
}

async function waitForToastTitle(title: string): Promise<HTMLElement> {
  let element: HTMLElement | null = null;
  await vi.waitFor(
    () => {
      element =
        Array.from(document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')).find(
          (candidate) => candidate.textContent === title,
        ) ?? null;
      expect(element, `Expected toast title "${title}" to render.`).toBeTruthy();
    },
    { timeout: 4_000, interval: 16 },
  );
  return element!;
}

async function waitForToastTitleRemoved(title: string): Promise<void> {
  await vi.waitFor(
    () => {
      const match = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]'),
      ).find((candidate) => candidate.textContent === title);
      expect(match, `Expected toast title "${title}" to be removed.`).toBeUndefined();
    },
    { timeout: 4_000, interval: 16 },
  );
}

describe("Toast close controls", () => {
  afterEach(() => {
    toastManager.close();
    anchoredToastManager.close();
    document.body.innerHTML = "";
  });

  it("renders and activates a dismiss button on stacked toasts", async () => {
    const router = createTestRouter();
    const screen = await render(<RouterProvider router={router} />);

    try {
      toastManager.add({
        type: "info",
        title: "Stacked toast with close",
        description: "Dismissible notification",
        timeout: 0,
      });

      await waitForToastTitle("Stacked toast with close");
      const closeButton = document.querySelector<HTMLButtonElement>('[data-slot="toast-close"]');
      expect(closeButton?.getAttribute("aria-label")).toBe("Dismiss");
      closeButton?.click();

      await waitForToastTitleRemoved("Stacked toast with close");
    } finally {
      await screen.unmount();
    }
  });

  it("renders and activates a dismiss button on anchored toasts", async () => {
    const anchor = document.createElement("button");
    anchor.type = "button";
    anchor.textContent = "Anchor";
    document.body.append(anchor);
    const router = createTestRouter();
    const screen = await render(<RouterProvider router={router} />);

    try {
      anchoredToastManager.add({
        type: "info",
        title: "Anchored toast with close",
        description: "Dismissible anchored notification",
        timeout: 0,
        positionerProps: { anchor },
      });

      await waitForToastTitle("Anchored toast with close");
      const closeButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-slot="toast-close"]'),
      );
      const closeButton = closeButtons.find(
        (button) => button.getAttribute("aria-label") === "Dismiss",
      );
      expect(closeButton).toBeTruthy();
      closeButton?.click();

      await waitForToastTitleRemoved("Anchored toast with close");
    } finally {
      await screen.unmount();
      anchor.remove();
    }
  });
});
