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

      const title = await waitForToastTitle("Stacked toast with close");
      const icon = document.querySelector<HTMLElement>('[data-slot="toast-icon"]')!;
      const description = document.querySelector<HTMLElement>('[data-slot="toast-description"]')!;
      // macOS layout: the tile sits left of a text column the description shares with the title.
      expect(
        Math.abs(icon.getBoundingClientRect().top - title.getBoundingClientRect().top),
      ).toBeLessThan(4);
      expect(icon.getBoundingClientRect().right).toBeLessThanOrEqual(
        title.getBoundingClientRect().left,
      );
      expect(
        Math.abs(description.getBoundingClientRect().left - title.getBoundingClientRect().left),
      ).toBeLessThan(2);
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

describe("Notification-style toasts", () => {
  afterEach(() => {
    toastManager.close();
    document.body.innerHTML = "";
  });

  it("collapses repeated toasts into one with a count", async () => {
    const screen = await render(<RouterProvider router={createTestRouter()} />);
    try {
      for (let index = 0; index < 3; index += 1)
        toastManager.add({ type: "error", title: "Could not push branch", timeout: 0 });
      await waitForToastTitle("Could not push branch");
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-slot="toast-root"]')).toHaveLength(1);
        expect(document.querySelector('[data-slot="toast-count"]')?.textContent).toBe("×3");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("runs an item row and closes the toast", async () => {
    const onSelect = vi.fn();
    const screen = await render(<RouterProvider router={createTestRouter()} />);
    try {
      toastManager.add({
        type: "warning",
        title: "2 pull requests need you",
        timeout: 0,
        data: {
          source: "pr",
          items: [
            { id: "a", label: "o/r#1", trailing: "Review", onSelect },
            { id: "b", label: "o/r#2", trailing: "Fix CI", onSelect: vi.fn() },
          ],
        },
      });
      await waitForToastTitle("2 pull requests need you");
      const rows = document.querySelectorAll<HTMLButtonElement>('[data-slot="toast-item"]');
      expect(rows).toHaveLength(2);
      rows[0]!.click();
      expect(onSelect).toHaveBeenCalledTimes(1);
      await waitForToastTitleRemoved("2 pull requests need you");
    } finally {
      await screen.unmount();
    }
  });

  it("starts the stack below a strip marked data-toast-avoid", async () => {
    const strip = document.createElement("div");
    strip.setAttribute("data-toast-avoid", "");
    Object.assign(strip.style, {
      position: "fixed",
      top: "60px",
      right: "12px",
      width: "240px",
      height: "24px",
    });
    document.body.append(strip);
    const screen = await render(<RouterProvider router={createTestRouter()} />);
    try {
      toastManager.add({ type: "info", title: "Below the strip", timeout: 0 });
      await waitForToastTitle("Below the strip");
      await vi.waitFor(() => {
        const viewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]')!;
        expect(viewport.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          strip.getBoundingClientRect().bottom,
        );
      });
    } finally {
      await screen.unmount();
      strip.remove();
    }
  });
});
