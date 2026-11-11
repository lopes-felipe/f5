import "../index.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { StoreProvider } from "../store";
import { useNotificationInbox, useNotificationInboxPopover } from "./inboxStore";
import { NotificationsBell } from "./NotificationsBell";

// The bell reads its shortcut from the server config; no server runs here.
vi.mock("../keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../keybindings")>()),
  useServerKeybindings: () => [],
}));

async function mountBell() {
  const rootRoute = createRootRoute({
    component: () => (
      <StoreProvider>
        <NotificationsBell />
      </StoreProvider>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  return render(<RouterProvider router={router} />);
}

function seed() {
  const record = useNotificationInbox.getState().record;
  const now = Date.now();
  record({
    id: "pr",
    source: "pr",
    severity: "attention",
    title: "acme/app#12 needs review",
    target: { kind: "prHub" },
    createdAt: now - 1000,
  });
  record({
    id: "err",
    source: "errors",
    severity: "error",
    title: "Could not push branch",
    target: { kind: "none" },
    createdAt: now,
  });
}

function rows() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-inbox-row]"));
}

describe("notification inbox", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotificationInbox.getState().clear();
    useNotificationInboxPopover.getState().setOpen(false);
  });
  afterEach(() => {
    useNotificationInbox.getState().clear();
    useNotificationInboxPopover.getState().setOpen(false);
  });

  it("shows the unread count on the bell and filters the popover", async () => {
    seed();
    const screen = await mountBell();
    const bell = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-notifications"]',
    )!;
    expect(bell.textContent).toContain("2 unread");

    bell.click();
    await expect.poll(() => rows().length).toBe(2);
    expect(document.querySelector('[data-testid="notification-inbox"]')?.textContent).toContain(
      "2 new",
    );

    document.querySelector<HTMLElement>('[role="tab"]:nth-child(6)')!.click();
    await expect.poll(() => rows().map((row) => row.dataset.inboxRow)).toEqual(["err"]);

    // Opening a row with no target reads it without closing the popover.
    rows()[0]!.click();
    await expect.poll(() => bell.textContent).toContain("1 unread");

    await screen.unmount();
  });

  it("stays clickable inside the desktop title bar's drag region", async () => {
    const screen = await mountBell();
    const bell = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-notifications"]',
    )!;
    expect(bell.classList.contains("no-drag")).toBe(true);
    expect(bell.getAttribute("aria-pressed")).toBe("false");
    await screen.unmount();
  });

  it("opens and closes from the store toggle the shortcut uses", async () => {
    seed();
    const screen = await mountBell();
    useNotificationInboxPopover.getState().toggle();
    await expect
      .poll(() => document.querySelector('[data-testid="notification-inbox"]'))
      .not.toBeNull();
    useNotificationInboxPopover.getState().toggle();
    await expect
      .poll(() => document.querySelector('[data-testid="notification-inbox"]'))
      .toBeNull();
    await screen.unmount();
  });

  it("removes the focused row with Backspace and shows the empty state", async () => {
    useNotificationInbox.getState().record({
      id: "only",
      source: "errors",
      severity: "error",
      title: "Lonely error",
      target: { kind: "none" },
      createdAt: Date.now(),
    });
    const screen = await mountBell();
    useNotificationInboxPopover.getState().setOpen(true);
    await expect.poll(() => rows().length).toBe(1);
    rows()[0]!.focus();
    rows()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    await expect
      .poll(() => document.querySelector('[data-testid="notification-inbox"]')?.textContent)
      .toContain("You're all caught up");
    await screen.unmount();
  });
});
