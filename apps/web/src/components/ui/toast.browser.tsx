import "../../index.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { DesktopTrackpadScrollEvent } from "@t3tools/contracts";

import { AnchoredToastProvider, anchoredToastManager, ToastProvider, toastManager } from "./toast";

function createTestRouter(component: () => ReactNode = ToastHarness) {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component,
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
      // The glyph sits on the title's line, left of it, and the body is indented under the title.
      expect(
        Math.abs(icon.getBoundingClientRect().top - title.getBoundingClientRect().top),
      ).toBeLessThan(4);
      expect(icon.getBoundingClientRect().right).toBeLessThanOrEqual(
        title.getBoundingClientRect().left,
      );
      expect(
        Math.abs(description.getBoundingClientRect().left - title.getBoundingClientRect().left),
      ).toBeLessThan(2);
      // A status rail runs down the card's left edge.
      const rail = document.querySelector<HTMLElement>('[data-slot="toast-rail"]')!;
      expect(rail.dataset.tone).toBe("info");
      expect(rail.getBoundingClientRect().right).toBeLessThanOrEqual(
        icon.getBoundingClientRect().left,
      );
      expect(rail.getBoundingClientRect().height).toBeGreaterThan(
        title.getBoundingClientRect().height,
      );
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

  it("colours the rail by status and puts a detail on the buttons' line", async () => {
    const screen = await render(<RouterProvider router={createTestRouter()} />);
    try {
      toastManager.add({
        type: "warning",
        title: "Approval needed",
        timeout: 0,
        data: {
          threadStatus: "pending-approval",
          detail: "bun run test apps/web",
          actions: [
            { label: "Deny", onClick: () => undefined },
            { label: "Approve", variant: "primary", onClick: () => undefined },
          ],
        },
      });
      toastManager.add({ type: "error", title: "Could not push", timeout: 0 });
      const approvalRoot = (await waitForToastTitle("Approval needed")).closest<HTMLElement>(
        '[data-slot="toast-root"]',
      )!;
      const errorRoot = (await waitForToastTitle("Could not push")).closest<HTMLElement>(
        '[data-slot="toast-root"]',
      )!;
      expect(
        approvalRoot.querySelector<HTMLElement>('[data-slot="toast-rail"]')?.dataset.tone,
      ).toBe("warning");
      expect(errorRoot.querySelector<HTMLElement>('[data-slot="toast-rail"]')?.dataset.tone).toBe(
        "destructive",
      );

      const detail = approvalRoot.querySelector<HTMLElement>('[data-slot="toast-detail"]')!;
      const buttons = approvalRoot.querySelectorAll<HTMLElement>('[data-slot="toast-action"]');
      expect(buttons).toHaveLength(2);
      const detailRect = detail.getBoundingClientRect();
      const buttonRect = buttons[0]!.getBoundingClientRect();
      expect(detailRect.right).toBeLessThanOrEqual(buttonRect.left);
      expect(
        Math.abs(detailRect.top + detailRect.height / 2 - (buttonRect.top + buttonRect.height / 2)),
      ).toBeLessThan(3);
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

describe("Trackpad scroll to dismiss", () => {
  afterEach(() => {
    toastManager.close();
    document.body.innerHTML = "";
  });

  function toastRoot(title: string): HTMLElement | null {
    const match = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]'),
    ).find((candidate) => candidate.textContent === title);
    return match?.closest<HTMLElement>('[data-slot="toast-root"]') ?? null;
  }

  /** A two-finger swipe: `deltaX < 0` is the fingers moving right, with natural scrolling. */
  function swipe(target: Element, deltas: ReadonlyArray<[number, number]>): boolean[] {
    return deltas.map(([deltaX, deltaY]) => {
      const event = new WheelEvent("wheel", {
        deltaX,
        deltaY,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    });
  }

  const outward = Array.from({ length: 10 }, (): [number, number] => [-20, 0]);
  const idle = () => new Promise((resolve) => setTimeout(resolve, 220));

  it("dismisses a toast swiped toward the screen edge", async () => {
    const screen = await render(<RouterProvider router={createTestRouter()} />);
    try {
      toastManager.add({ type: "info", title: "Swipe me away", timeout: 0 });
      await waitForToastTitle("Swipe me away");
      const prevented = swipe(toastRoot("Swipe me away")!, outward);
      expect(prevented.at(-1)).toBe(true);
      await waitForToastTitleRemoved("Swipe me away");
    } finally {
      await screen.unmount();
    }
  });

  it("snaps a short swipe back and ignores vertical scrolling", async () => {
    const screen = await render(<RouterProvider router={createTestRouter()} />);
    try {
      toastManager.add({ type: "info", title: "Stay put", timeout: 0 });
      await waitForToastTitle("Stay put");
      const root = toastRoot("Stay put")!;
      swipe(root, [
        [-6, 0],
        [-10, 0],
        [-14, 0],
      ]);
      expect(root.style.translate).toBe("30px");
      expect(root.hasAttribute("data-wheel-dragging")).toBe(true);
      await idle();
      expect(root.style.translate).toBe("");
      expect(root.hasAttribute("data-wheel-dragging")).toBe(false);

      const prevented = swipe(root, [
        [0, 20],
        [-2, 40],
        [-40, 0],
      ]);
      expect(prevented).toEqual([false, false, false]);
      expect(root.style.translate).toBe("");
      await idle();
      expect(toastRoot("Stay put")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a dismissing swipe's momentum from reaching the next toast", async () => {
    const screen = await render(<RouterProvider router={createTestRouter()} />);
    try {
      toastManager.add({ type: "info", title: "Back toast", timeout: 0 });
      toastManager.add({ type: "info", title: "Front toast", timeout: 0 });
      await waitForToastTitle("Front toast");
      const front = toastRoot("Front toast")!;
      swipe(front, outward);
      // Momentum keeps arriving, now over whatever toast slid into place.
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        swipe(toastRoot("Back toast") ?? document.body, outward);
      }
      await waitForToastTitleRemoved("Front toast");
      await idle();
      expect(toastRoot("Back toast")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  let setHarnessPosition: ((position: "top-left" | "top-right" | "bottom-right") => void) | null =
    null;
  function PositionedHarness() {
    const [position, setPosition] = useState<"top-left" | "top-right" | "bottom-right">(
      "top-right",
    );
    useEffect(() => {
      setHarnessPosition = setPosition;
      return () => {
        setHarnessPosition = null;
      };
    }, []);
    return (
      <ToastProvider position={position}>
        <span />
      </ToastProvider>
    );
  }

  it("dismisses a left-hand stack's toast to the left, and only rubber-bands it to the right", async () => {
    const screen = await render(<RouterProvider router={createTestRouter(PositionedHarness)} />);
    try {
      await vi.waitFor(() => expect(setHarnessPosition).not.toBeNull());
      setHarnessPosition!("top-left");
      toastManager.add({ type: "info", title: "Left stack", timeout: 0 });
      await waitForToastTitle("Left stack");
      await vi.waitFor(() =>
        expect(toastRoot("Left stack")!.getAttribute("data-position")).toBe("top-left"),
      );
      const root = toastRoot("Left stack")!;
      swipe(root, outward);
      // Fingers moving right push a left-hand toast inward: rubber band, capped at 16px.
      expect(root.style.translate).toBe("16px");
      await idle();
      expect(toastRoot("Left stack")).not.toBeNull();
      swipe(
        root,
        outward.map(([deltaX, deltaY]): [number, number] => [-deltaX, deltaY]),
      );
      await waitForToastTitleRemoved("Left stack");
    } finally {
      await screen.unmount();
    }
  });

  it("closes right away, so the position changing or a repeat arriving mid-exit loses nothing", async () => {
    const screen = await render(<RouterProvider router={createTestRouter(PositionedHarness)} />);
    try {
      await vi.waitFor(() => expect(setHarnessPosition).not.toBeNull());
      toastManager.add({ type: "error", title: "Repeat me", timeout: 0 });
      await waitForToastTitle("Repeat me");
      const first = toastRoot("Repeat me")!;
      swipe(first, outward);
      // The same toast again, during the exit animation: a new toast, not a merge into the old.
      toastManager.add({ type: "error", title: "Repeat me", timeout: 0 });
      setHarnessPosition!("bottom-right");
      await vi.waitFor(() => {
        const roots = Array.from(
          document.querySelectorAll<HTMLElement>('[data-slot="toast-root"]'),
        );
        expect(roots).toHaveLength(1);
        expect(roots[0]!.getAttribute("data-position")).toBe("bottom-right");
        expect(roots[0]!.style.opacity).toBe("");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("fades without sliding under reduced motion", async () => {
    const matchMedia = window.matchMedia.bind(window);
    const spy = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const real = matchMedia(query);
      if (query !== "(prefers-reduced-motion: reduce)") return real;
      return new Proxy(real, {
        get: (target, property) => {
          if (property === "matches") return true;
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const screen = await render(<RouterProvider router={createTestRouter()} />);
    try {
      toastManager.add({ type: "info", title: "Fade only", timeout: 0 });
      await waitForToastTitle("Fade only");
      const root = toastRoot("Fade only")!;
      swipe(root, outward);
      expect(root.style.opacity).toBe("0");
      // It fades where the fingers left it instead of sliding past its own width.
      expect(Number.parseFloat(root.style.translate)).toBeLessThan(
        root.getBoundingClientRect().width,
      );
      expect(root.style.transition).not.toContain("translate");
      await waitForToastTitleRemoved("Fade only");
    } finally {
      spy.mockRestore();
      await screen.unmount();
    }
  });

  it("ignores a mouse wheel the desktop app reports as imprecise", async () => {
    let listener: ((event: DesktopTrackpadScrollEvent) => void) | null = null;
    const bridge = {
      onTrackpadScroll: (next: (event: DesktopTrackpadScrollEvent) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    };
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: bridge });
    const screen = await render(<RouterProvider router={createTestRouter()} />);
    try {
      toastManager.add({ type: "info", title: "Mouse wheel", timeout: 0 });
      await waitForToastTitle("Mouse wheel");
      await vi.waitFor(() => expect(listener).not.toBeNull());
      const root = toastRoot("Mouse wheel")!;
      // The scroll's begin can arrive after its first wheel event.
      swipe(root, outward.slice(0, 2));
      listener!({ phase: "begin", precise: false });
      expect(root.style.translate).toBe("");
      expect(swipe(root, outward)).toEqual(outward.map(() => false));
      listener!({ phase: "end" });
      await idle();
      expect(toastRoot("Mouse wheel")).not.toBeNull();

      // A trackpad scroll afterwards still swipes.
      listener!({ phase: "begin", precise: true });
      swipe(root, outward);
      await waitForToastTitleRemoved("Mouse wheel");
    } finally {
      await screen.unmount();
      Reflect.deleteProperty(window, "desktopBridge");
    }
  });
});
