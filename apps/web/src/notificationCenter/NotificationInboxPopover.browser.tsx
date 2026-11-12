import "../index.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  APP_SETTINGS_STORAGE_KEY,
  parsePersistedAppSettings,
  updateAppSettings,
} from "../appSettings";
import { StoreProvider } from "../store";
import { useNotificationInbox, useNotificationInboxPopover } from "./inboxStore";
import { NotificationsBell } from "./NotificationsBell";
import { DEFAULT_NOTIFICATION_PREFERENCES, DO_NOT_DISTURB_FOREVER } from "./preferences";

function getAppSettings() {
  return parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
}

// The bell reads its shortcut from the server config; no server runs here.
vi.mock("../keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../keybindings")>()),
  useServerKeybindings: () => [],
}));

async function mountBell() {
  const rootRoute = createRootRoute({
    component: () => (
      <StoreProvider>
        {/* Like the desktop title bar the bell sits in. */}
        <div className="drag-region">
          <NotificationsBell />
        </div>
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

function viewSegment(view: "all" | "needs-you" | "unread") {
  return document.querySelector<HTMLElement>(`[data-inbox-view="${view}"]`)!;
}

function sectionRowIds(section: string) {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-inbox-section="${section}"] [data-inbox-row]`),
  ).map((row) => row.dataset.inboxRow);
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
    expect(viewSegment("unread").textContent).toBe("Unread2");

    await page.getByTestId("inbox-source-filter").click();
    await page.getByRole("menuitemradio", { name: "Errors", exact: true }).click();
    await expect.poll(() => rows().map((row) => row.dataset.inboxRow)).toEqual(["err"]);
    expect(viewSegment("unread").textContent).toBe("Unread1");

    // Opening a row with no target reads it without closing the popover.
    rows()[0]!.click();
    await expect.poll(() => bell.textContent).toContain("1 unread");

    await screen.unmount();
  });

  it("hides a source whose Inbox switch is off from the badge, list and filters", async () => {
    seed();
    const errorsOff = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      errors: { ...DEFAULT_NOTIFICATION_PREFERENCES.errors, inbox: false },
    };
    updateAppSettings({ notificationPreferences: errorsOff });
    const screen = await mountBell();
    const bell = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-notifications"]',
    )!;
    expect(bell.textContent).toContain("1 unread");

    bell.click();
    await expect.poll(() => rows().map((row) => row.dataset.inboxRow)).toEqual(["pr"]);
    const sourceOptions = () =>
      Array.from(document.querySelectorAll('[role="menuitemradio"]')).map(
        (option) => option.textContent,
      );
    await page.getByTestId("inbox-source-filter").click();
    await expect.poll(sourceOptions).toContain("Pull requests");
    expect(sourceOptions()).not.toContain("Errors");
    await page.getByRole("menuitemradio", { name: "All sources", exact: true }).click();
    await expect.poll(sourceOptions).toEqual([]);

    // Turning the switch back on brings the earlier entries back.
    updateAppSettings({ notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES });
    await expect.poll(() => rows().length).toBe(2);
    await page.getByTestId("inbox-source-filter").click();
    await expect.poll(sourceOptions).toContain("Errors");
    await expect.poll(() => bell.textContent).toContain("2 unread");

    await screen.unmount();
  });

  it("narrows the list to unread entries and groups by day", async () => {
    seed();
    useNotificationInbox.getState().markRead("pr");
    const screen = await mountBell();
    useNotificationInboxPopover.getState().setOpen(true);
    await expect.poll(() => sectionRowIds("Today")).toEqual(["err", "pr"]);
    // Nothing waits on the user here, so there is no pinned section.
    expect(sectionRowIds("needs-you")).toEqual([]);

    await page.getByRole("button", { name: /^Unread/ }).click();
    await expect.poll(() => sectionRowIds("Today")).toEqual(["err"]);

    await page.getByRole("button", { name: /^Needs you/ }).click();
    await expect
      .poll(() => document.querySelector('[data-testid="notification-inbox"]')?.textContent)
      .toContain("Nothing needs you");
    await screen.unmount();
  });

  it("snoozes and turns off Do Not Disturb from the header", async () => {
    updateAppSettings({ doNotDisturbUntil: null });
    const screen = await mountBell();
    useNotificationInboxPopover.getState().setOpen(true);
    const moon = page.getByTestId("inbox-do-not-disturb");
    await moon.click();
    await page.getByRole("menuitem", { name: "Until I turn it off", exact: true }).click();
    await expect.poll(() => getAppSettings().doNotDisturbUntil).toBe(DO_NOT_DISTURB_FOREVER);
    await expect.element(moon).toHaveAttribute("data-active", "");

    await moon.click();
    await page.getByRole("menuitem", { name: "Turn off", exact: true }).click();
    await expect.poll(() => getAppSettings().doNotDisturbUntil).toBeNull();
    await expect.element(moon).not.toHaveAttribute("data-active");
    await screen.unmount();
  });

  it("stays clickable inside the desktop title bar's drag region", async () => {
    const screen = await mountBell();
    const bell = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-notifications"]',
    )!;
    expect(getComputedStyle(bell.parentElement!).getPropertyValue("-webkit-app-region")).toBe(
      "drag",
    );
    expect(getComputedStyle(bell).getPropertyValue("-webkit-app-region")).toBe("no-drag");
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
