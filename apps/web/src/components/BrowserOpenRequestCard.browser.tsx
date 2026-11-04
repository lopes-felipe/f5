import "../index.css";
import type { DesktopBrowserOpenRequest } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BrowserOpenRequestCard } from "./BrowserOpenRequestCard";

// Component regression only: main's validation and the browser launch are not exercised.
const url = "https://github.com/login/device?code=" + "x".repeat(200);
const request = (overrides: Partial<DesktopBrowserOpenRequest> = {}) => ({
  requestId: "first",
  host: "github.com",
  url,
  profileName: "Work",
  expiresAtMs: Date.now() + 4 * 60_000 + 30_000,
  waiting: 0,
  ...overrides,
});

function setup(current: DesktopBrowserOpenRequest | null = null) {
  const listeners = {
    requested: new Set<(request: DesktopBrowserOpenRequest) => void>(),
    settled: new Set<(requestId: string) => void>(),
  };
  const bridge = {
    current: vi.fn(async () => current),
    onRequested: (listener: (request: DesktopBrowserOpenRequest) => void) => {
      listeners.requested.add(listener);
      return () => listeners.requested.delete(listener);
    },
    onSettled: (listener: (requestId: string) => void) => {
      listeners.settled.add(listener);
      return () => listeners.settled.delete(listener);
    },
    acknowledge: vi.fn(async (_requestId: string) => {}),
    answer: vi.fn(async (_requestId: string, _choice: string) => {}),
  };
  window.desktopBridge = { browserOpen: bridge } as never;
  return {
    bridge,
    push: (next: DesktopBrowserOpenRequest) => listeners.requested.forEach((fn) => fn(next)),
    settle: (requestId: string) => listeners.settled.forEach((fn) => fn(requestId)),
  };
}

const card = () => page.getByRole("region", { name: "Browser open request" });

afterEach(() => {
  delete window.desktopBridge;
});

it("shows a request main already had and acknowledges it once without taking focus", async () => {
  const h = setup(request({ waiting: 2 }));
  const before = document.activeElement;
  const screen = await render(<BrowserOpenRequestCard />);
  try {
    await expect.element(card()).toBeVisible();
    const title = page.getByRole("button", { name: "Show full URL" });
    await expect.element(title).toHaveTextContent(/^Open\sgithub\.com\/login\/device\?code=x+\?$/);
    await expect.element(title).toHaveAttribute("title", url);
    await expect.element(page.getByText("Work", { exact: true })).toBeVisible();
    await expect.element(page.getByTitle(/Expires in 4:(29|30)/)).toHaveTextContent(/^4:(29|30)$/);
    await expect.element(page.getByTitle("2 more waiting")).toHaveTextContent("1/3");
    // The pushed copy of the same request does not acknowledge it a second time.
    h.push(request({ waiting: 2 }));
    await vi.waitFor(() => expect(h.bridge.acknowledge).toHaveBeenCalledExactlyOnceWith("first"));
    expect(document.activeElement).toBe(before);
    await title.click();
    await expect.element(page.getByLabelText("Full URL", { exact: true })).toHaveTextContent(url);
    await page.getByRole("button", { name: "Hide full URL" }).click();
    await expect.element(page.getByLabelText("Full URL", { exact: true })).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("names a loopback server by host and port", async () => {
  const h = setup();
  const screen = await render(<BrowserOpenRequestCard />);
  try {
    h.push(request({ host: "127.0.0.1", url: "http://127.0.0.1:62115/abc" }));
    await expect
      .element(page.getByRole("button", { name: "Show full URL" }))
      .toHaveTextContent(/^Open\s127\.0\.0\.1:62115\/abc\?$/);
    await expect.element(page.getByTitle(/more waiting/)).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it.each([
  ["Open", "open"],
  ["Copy link", "copy"],
  ["Cancel", "cancel"],
] as const)("reports %s as %s", async (label, choice) => {
  const h = setup();
  const screen = await render(<BrowserOpenRequestCard />);
  try {
    h.push(request());
    await page.getByRole("button", { name: label, exact: true }).click();
    expect(h.bridge.answer).toHaveBeenCalledExactlyOnceWith("first", choice);
  } finally {
    await screen.unmount();
  }
});

it("offers the session host grant from the Open menu", async () => {
  const h = setup();
  const screen = await render(<BrowserOpenRequestCard />);
  try {
    h.push(request());
    await page.getByRole("button", { name: "More open options" }).click();
    await page.getByRole("menuitem", { name: "Always allow github.com until F5 quits" }).click();
    expect(h.bridge.answer).toHaveBeenCalledExactlyOnceWith("first", "allow-host");
  } finally {
    await screen.unmount();
  }
});

it("closes only on its own settlement and shows the next request", async () => {
  const h = setup();
  const screen = await render(<BrowserOpenRequestCard />);
  try {
    h.push(request());
    await expect.element(card()).toBeVisible();
    h.settle("other");
    await expect.element(card()).toBeVisible();
    h.settle("first");
    await expect.element(card()).not.toBeInTheDocument();
    h.push(request({ requestId: "second", host: "example.com", url: "https://example.com/" }));
    await expect
      .element(page.getByRole("button", { name: "Show full URL" }))
      .toHaveTextContent(/^Open\sexample\.com\?$/);
    await vi.waitFor(() => expect(h.bridge.acknowledge).toHaveBeenLastCalledWith("second"));
  } finally {
    await screen.unmount();
  }
});

it("re-enables the buttons with an inline error when main rejects the answer", async () => {
  const h = setup();
  h.bridge.answer.mockRejectedValueOnce(new Error("no longer pending"));
  const screen = await render(<BrowserOpenRequestCard />);
  try {
    h.push(request());
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Open", exact: true })).toBeEnabled();
  } finally {
    await screen.unmount();
  }
});
