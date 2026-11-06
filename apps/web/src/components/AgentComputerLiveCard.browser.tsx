import { CHROME_BANNER_LINGER_MS, ComputerUseBanner } from "./ComputerUseBanner";
import "../index.css";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { AgentComputerLiveCard } from "./AgentComputerLiveCard";
import { ComputerAccessInbox } from "./ComputerAccessCard";
import { AUTO_ANSWER_GRACE_MS } from "../hooks/usePendingComputerAccessRequests";
import { useState } from "react";
import { ToastProvider, toastManager } from "./ui/toast";
import { Dialog, DialogPopup, DialogTitle, DialogClose } from "./ui/dialog";

// Component regression only: no desktop host, grants or OS input are executed.
const nativeMock = vi.hoisted(() => ({
  api: undefined as import("@t3tools/contracts").NativeApi | undefined,
}));
vi.mock("../nativeApi", () => ({ readNativeApi: () => nativeMock.api }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => async () => {},
  useParams: () => ({}),
}));
const threadId = ThreadId.makeUnsafe("computer-ui-fixture");
it.each(["paused", "recovery"] as const)(
  "uses server-only %s state after a renderer reload",
  async (state) => {
    window.desktopBridge = { computerAutomation: { setPaused: vi.fn() } } as never;
    useAgentComputerActivityStore.getState().setLeases({
      holders: [
        {
          threadId,
          backend: "native",
          delivery: "foreground",
          state,
          leaseHeld: false,
        },
      ],
    });
    const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
    try {
      await expect
        .element(page.getByText(state === "paused" ? "Paused" : "Needs recovery", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  },
);
it.each([
  ["waiting-user", "background"],
  ["waiting-agent", "background"],
  ["waiting-user", "foreground"],
  ["waiting-agent", "foreground"],
] as const)("shows ambient %s/%s without Resume", async (state, delivery) => {
  window.desktopBridge = { computerAutomation: { setPaused: vi.fn() } } as never;
  const store = useAgentComputerActivityStore.getState();
  store.setLeases({
    holders: [
      {
        threadId,
        backend: "native",
        delivery,
        ...(delivery === "background" ? { appId: "com.apple.TextEdit", appName: "TextEdit" } : {}),
        state,
        leaseHeld: false,
      },
    ],
  });
  const screen = await render(
    <>
      <ComputerUseBanner />
      <AgentComputerLiveCard threadId={threadId} />
    </>,
  );
  try {
    const text =
      state === "waiting-user"
        ? delivery === "background"
          ? "Waiting for you to finish in TextEdit"
          : "Waiting while you use the computer"
        : "Waiting for another agent";
    await expect.element(page.getByText(text, { exact: true }).first()).toBeVisible();
    await expect.element(page.getByTestId("computer-use-banner")).toHaveClass("border-border");
    await expect
      .element(page.getByRole("button", { name: "Pause", exact: true }).first())
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Stop", exact: true }).first())
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Resume", exact: true }))
      .not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
it("shows session-only persistence after the native request closes", async () => {
  window.desktopBridge = { computerAutomation: { answerAccess: vi.fn() } } as never;
  const store = useAgentComputerActivityStore.getState();
  store.request({
    requestId: "save-failed",
    threadId,
    backendIncarnation: "fixture",
    kind: "apps",
    reason: "Edit",
    apps: [],
  });
  const screen = await render(<ComputerAccessInbox />);
  try {
    store.settle({
      requestId: "save-failed",
      threadId,
      allowed: true,
      persistence: "session-only",
      persistenceReason: "Disk full",
    });
    await expect
      .element(page.getByText("Permission applies until F5 closes.", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("Disk full", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect.element(page.getByText("Disk full", { exact: true })).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
beforeEach(() => {
  nativeMock.api = undefined;
  useAgentComputerActivityStore.getState().resetConnection();
});
afterEach(() => {
  toastManager.close();
  vi.restoreAllMocks();
  delete window.desktopBridge;
  useAgentComputerActivityStore.getState().resetConnection();
});

it("updates an already-mounted live region for each queued access request", async () => {
  const store = useAgentComputerActivityStore.getState();
  window.desktopBridge = { computerAutomation: { answerAccess: vi.fn() } } as never;
  const screen = await render(<ComputerAccessInbox />);
  try {
    const region = page.getByRole("status").element();
    expect(region.textContent?.trim()).toBe("");
    for (const requestId of ["announce-first", "announce-next"])
      store.request({
        requestId,
        threadId,
        backendIncarnation: "fixture-backend",
        kind: "apps",
        reason: "Synthetic announcement test",
        apps: [{ appId: "fixture", name: "Synthetic fixture", tier: "full" }],
      });
    await expect.element(region).toHaveTextContent("Computer access request 1 is waiting.");
    store.settle({ requestId: "announce-first", threadId, allowed: false });
    await expect.element(region).toHaveTextContent("Computer access request 2 is waiting.");
    expect(page.getByRole("status").element()).toBe(region);
    expect(region.textContent).not.toContain("Expires");
    store.settle({ requestId: "announce-next", threadId, allowed: false });
    await expect.element(region).toBeEmptyDOMElement();
  } finally {
    await screen.unmount();
  }
});

function AccessLayoutFixture() {
  const [open, setOpen] = useState(false);
  return (
    <ToastProvider>
      <main className="min-h-screen bg-background text-foreground">
        <button type="button" className="fixed top-4 left-4" onClick={() => setOpen(true)}>
          Open editor confirmation
        </button>
        <textarea
          aria-label="Multi-line composer"
          className="fixed right-4 bottom-4 left-4 h-40 rounded-lg border bg-background p-4"
          defaultValue={"Keep writing while access is pending.\nA second line.\nA third line."}
        />
        <ComputerAccessInbox />
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup>
            <DialogTitle className="p-6">Editor confirmation</DialogTitle>
            <DialogClose className="p-6">Close editor</DialogClose>
          </DialogPopup>
        </Dialog>
      </main>
    </ToastProvider>
  );
}

async function waitForLayoutAnimations() {
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})),
  );
}

it.each([1280, 840, 390])(
  "keeps access above a tall composer, clear of toasts, and respects modal focus at %spx",
  async (width) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(width, 900);
    const store = useAgentComputerActivityStore.getState();
    const answerAccess = vi.fn(async () => {});
    window.desktopBridge = { computerAutomation: { answerAccess } } as never;
    const screen = await render(<AccessLayoutFixture />);
    try {
      store.request({
        requestId: "layout",
        threadId,
        backendIncarnation: "fixture-backend",
        kind: "apps",
        reason: "Edit the document while you keep working",
        apps: [{ appId: "fixture", name: "Document editor", tier: "full" }],
      });
      toastManager.add({ type: "info", title: "Layout notification", timeout: 0 });
      await expect.element(page.getByText("Layout notification", { exact: true })).toBeVisible();
      await waitForLayoutAnimations();
      const panel = page.getByRole("dialog", { name: "Computer access", exact: true }).element();
      const panelRect = panel.getBoundingClientRect();
      const composer = page.getByRole("textbox", { name: "Multi-line composer" });
      expect(panelRect.bottom).toBeLessThan(composer.element().getBoundingClientRect().top);
      const toast = page
        .getByText("Layout notification", { exact: true })
        .element()
        .closest('[data-slot="toast-root"]')!;
      await expect
        .poll(() => {
          const a = panel.getBoundingClientRect();
          const b = toast.getBoundingClientRect();
          return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        })
        .toBe(false);
      await page.screenshot({
        path: "../../.playwright/screenshots/computer-access-composer-toast-" + width + ".png",
      });
      await page.getByRole("button", { name: "Open editor confirmation" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Editor confirmation", exact: true }))
        .toBeVisible();
      await waitForLayoutAnimations();
      await page.screenshot({
        path: "../../.playwright/screenshots/computer-access-editor-modal-" + width + ".png",
      });
      await page.getByRole("button", { name: "Close editor", exact: true }).click();
      await page.getByRole("button", { name: "Review access", exact: true }).click();
      expect(answerAccess).toHaveBeenCalledOnce();
      await composer.click();
      await expect.element(composer).toHaveFocus();
    } finally {
      await screen.unmount();
      await page.viewport(viewport.width, viewport.height);
    }
  },
);

it("shows Pause after an old action's lease ends and keeps Resume visible once paused", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  const store = useAgentComputerActivityStore.getState();
  const pause = vi.fn(async (id: string, paused: boolean) => store.setPaused(id, paused));
  window.desktopBridge = { computerAutomation: { setPaused: pause } } as never;
  store.record({ threadId, op: "type", status: "completed", backend: "native" });
  store.setLeases({
    holders: [{ threadId, backend: "native", delivery: "foreground", state: "active" }],
  });
  clock.mockReturnValue(130000);
  store.setLeases({ holders: [] });
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(pause).toHaveBeenCalledWith(threadId, true);
    clock.mockReturnValue(200000);
    await expect.element(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("keeps the access inbox non-modal without stealing composer focus", async () => {
  const store = useAgentComputerActivityStore.getState();
  window.desktopBridge = { computerAutomation: { answerAccess: vi.fn() } } as never;
  const screen = await render(
    <>
      <input aria-label="Composer fixture" />
      <button type="button">Outside action</button>
      <ComputerAccessInbox />
    </>,
  );
  try {
    const composer = page.getByRole("textbox", { name: "Composer fixture" });
    await composer.click();
    store.request({
      requestId: "non-modal",
      threadId,
      backendIncarnation: "fixture-backend",
      kind: "apps",
      reason: "Synthetic component test",
      apps: [{ appId: "fixture", name: "Synthetic fixture", tier: "full" }],
    });
    await expect
      .element(page.getByRole("dialog", { name: "Computer access" }))
      .toHaveAttribute("aria-modal", "false");
    await expect.element(composer).toHaveFocus();
    await userEvent.keyboard("still working");
    await expect.element(composer).toHaveValue("still working");
    await page.getByRole("button", { name: "Outside action" }).click();
    await expect.element(page.getByRole("button", { name: "Outside action" })).toHaveFocus();
  } finally {
    await screen.unmount();
  }
});

it("closes the access inbox only when its matching settlement arrives", async () => {
  const store = useAgentComputerActivityStore.getState();
  const answer = vi.fn(async () => {});
  window.desktopBridge = { computerAutomation: { answerAccess: answer } } as never;
  store.request({
    requestId: "consent",
    threadId,
    backendIncarnation: "fixture-backend",
    kind: "apps",
    reason: "Synthetic component test",
    apps: [{ appId: "fixture", name: "Synthetic fixture", tier: "full" }],
  });
  const screen = await render(<ComputerAccessInbox />);
  try {
    await expect.element(page.getByRole("dialog", { name: "Computer access" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(answer).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Review access", exact: true }).click();
    expect(answer).toHaveBeenCalledExactlyOnceWith({
      requestId: "consent",
      backendIncarnation: "fixture-backend",
      decisions: [],
    });
    store.settle({ requestId: "other", threadId, allowed: true });
    await expect.element(page.getByRole("dialog", { name: "Computer access" })).toBeVisible();
    store.settle({ requestId: "consent", threadId, allowed: true });
    await expect
      .element(page.getByRole("dialog", { name: "Computer access" }))
      .not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("holds a Codex Chrome session request briefly so one main answers never flashes a dialog", async () => {
  const store = useAgentComputerActivityStore.getState();
  window.desktopBridge = { computerAutomation: { answerAccess: vi.fn() } } as never;
  const session = (requestId: string) =>
    store.request({
      requestId,
      threadId,
      backendIncarnation: "fixture-backend",
      kind: "chrome-session",
      reason: "Synthetic component test",
      apps: [],
      chromeSession: { integration: "codex-chrome" },
    });
  const screen = await render(<ComputerAccessInbox />);
  const dialog = page.getByRole("dialog", { name: "Computer access" });
  try {
    session("auto");
    await new Promise((resolve) => setTimeout(resolve, AUTO_ANSWER_GRACE_MS / 2));
    expect(dialog.query()).toBeNull();
    store.settle({ requestId: "auto", threadId, allowed: true });
    await new Promise((resolve) => setTimeout(resolve, AUTO_ANSWER_GRACE_MS));
    expect(dialog.query()).toBeNull();
    // One nobody answers asks once the hold ends.
    session("asked");
    expect(dialog.query()).toBeNull();
    await expect.element(dialog).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("holds a Claude in Chrome setup request the same way", async () => {
  const store = useAgentComputerActivityStore.getState();
  window.desktopBridge = { computerAutomation: { answerAccess: vi.fn() } } as never;
  const screen = await render(<ComputerAccessInbox />);
  const dialog = page.getByRole("dialog", { name: "Browser integration setup" });
  try {
    store.request({
      requestId: "claude-setup",
      threadId,
      backendIncarnation: "fixture-backend",
      kind: "chrome-setup",
      reason: "Synthetic component test",
      apps: [],
      chromeSetup: {
        provider: "claude",
        previousTargets: ["/terminal/wrapper"],
        targetPath: "/f5/wrapper",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, AUTO_ANSWER_GRACE_MS / 2));
    expect(dialog.query()).toBeNull();
    await expect.element(dialog).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("retains idle controls while apps are granted and removes them after access is revoked", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  const store = useAgentComputerActivityStore.getState();
  store.record({ threadId, op: "type", status: "completed", backend: "native" });
  store.setLeases({
    holders: [{ threadId, backend: "native", delivery: "foreground", state: "active" }],
  });
  store.setLeases({ holders: [] });
  store.setGrants(threadId, [{ appId: "fixture", tier: "full", allowTyping: false }]);
  clock.mockReturnValue(200000);
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Revoke fixture", exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("fixture · Full control", { exact: true })).toBeVisible();
    store.setGrants(threadId, []);
    await expect.element(page.getByTestId("computer-live-card")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("clears an earlier capture after a no-image action", async () => {
  const store = useAgentComputerActivityStore.getState();
  store.setGrants(threadId, [{ appId: "fixture", tier: "full", allowTyping: false }]);
  store.record({
    threadId,
    op: "activateApp",
    status: "completed",
    backend: "native",
    appName: "Synthetic fixture",
    thumbnailDataUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3Crect width='2' height='2' fill='gray'/%3E%3C/svg%3E",
  });
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    const image = page.getByAltText("Last captured computer action");
    await expect.element(image).toBeVisible();
    store.record({ threadId, op: "type", status: "completed", backend: "native" });
    await expect.element(image).not.toBeInTheDocument();
    await expect
      .element(page.getByTitle("Last capture · Synthetic fixture"))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Typed", { exact: true })).toBeVisible();
    store.setGrants(threadId, []);
    await expect.element(image).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

const accessRequest = (requestId: string, reason: string) => ({
  requestId,
  threadId,
  backendIncarnation: "fixture-backend",
  kind: "apps" as const,
  reason,
  apps: [{ appId: requestId, name: `App ${requestId}`, tier: "click" as const }],
});

it("lists allowed, refused and pending requests in the history popover", async () => {
  const store = useAgentComputerActivityStore.getState();
  store.request(accessRequest("a", "First reason"));
  store.request(accessRequest("b", "Second reason"));
  store.request(accessRequest("c", "Third reason"));
  store.request({ ...accessRequest("d", "Fourth reason"), kind: "session-actions", apps: [] });
  store.settle({ requestId: "a", threadId, allowed: true });
  store.settle({ requestId: "b", threadId, allowed: false });
  store.settle({ requestId: "d", threadId, allowed: true });
  store.setGrants(threadId, [
    { appId: "a", tier: "click", allowTyping: false },
    { appId: "b", tier: "click", allowTyping: true },
  ]);
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByText("App a · Click", { exact: true })).toBeVisible();
    await expect.element(page.getByText("App b · Click + typing", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "History (4)", exact: true }).click();
    const list = page.getByTestId("computer-access-history");
    await expect.element(list).toBeVisible();
    const rows = list.getByRole("listitem");
    await expect.element(rows.nth(0)).toHaveTextContent("Requested: Session actionsFourth reason");
    await expect.element(rows.nth(1)).toHaveTextContent("Requested: App c · ClickThird reason");
    await expect.element(rows.nth(1).getByLabelText("Pending")).toBeInTheDocument();
    await expect.element(rows.nth(2).getByLabelText("Not allowed")).toBeInTheDocument();
    await expect.element(rows.nth(3).getByLabelText("Allowed")).toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("shows a compact summary that follows the latest request when only history remains", async () => {
  const store = useAgentComputerActivityStore.getState();
  store.request(accessRequest("a", "Only reason"));
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect
      .element(page.getByText("Computer access · last request pending", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByTestId("computer-live-card")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "History (1)" }).click();
    const list = page.getByTestId("computer-access-history");
    await expect.element(list.getByLabelText("Pending")).toBeInTheDocument();
    store.settle({ requestId: "a", threadId, allowed: false });
    await expect.element(list.getByLabelText("Not allowed")).toBeInTheDocument();
    await expect
      .element(page.getByText("Computer access · last request not allowed", { exact: true }))
      .toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("keeps Stop visible and clickable at a narrow width", async () => {
  const store = useAgentComputerActivityStore.getState();
  const setPaused = vi.fn(async () => {});
  window.desktopBridge = { computerAutomation: { setPaused } } as never;
  await page.viewport(320, 640);
  store.request(accessRequest("a", "Only reason"));
  store.settle({ requestId: "a", threadId, allowed: true });
  store.setGrants(threadId, [{ appId: "a", tier: "click", allowTyping: true }]);
  store.record({
    threadId,
    op: "activateApp",
    status: "failed",
    backend: "native",
    source: "tool",
  });
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByRole("button", { name: "Actions (1)" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "History (1)" })).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect.element(stop).toBeVisible();
    const rect = stop.element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    await stop.click();
    expect(setPaused).toHaveBeenCalledWith(threadId, true);
  } finally {
    await screen.unmount();
    await page.viewport(414, 896);
  }
});

it("names a built-in backend in the strip", async () => {
  const store = useAgentComputerActivityStore.getState();
  store.record({ threadId, op: "click", status: "started", backend: "claude-builtin" });
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByText("Clicking…", { exact: true })).toBeVisible();
    await expect.element(page.getByText("· via Claude", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("shows the tier badge and browser warning in the consent dialog", async () => {
  const store = useAgentComputerActivityStore.getState();
  window.desktopBridge = { computerAutomation: { answerAccess: vi.fn() } } as never;
  store.request({
    requestId: "consent-browser",
    threadId,
    backendIncarnation: "fixture-backend",
    kind: "apps",
    reason: "Open the dashboard",
    apps: [{ appId: "browser", name: "Synthetic browser", tier: "full", warning: "browser" }],
  });
  const screen = await render(<ComputerAccessInbox />);
  try {
    const dialog = page.getByRole("dialog", { name: "Computer access" });
    await expect.element(dialog.getByText("Full control", { exact: true })).toBeVisible();
    await expect
      .element(dialog.getByText("Can act on sites you're signed in to", { exact: true }))
      .toBeVisible();
    await expect.element(dialog.getByText("Open the dashboard", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("shows consent deadlines and the number waiting, and records tool actions only once", async () => {
  const store = useAgentComputerActivityStore.getState();
  window.desktopBridge = { computerAutomation: { answerAccess: vi.fn() } } as never;
  store.request({ ...accessRequest("deadline", "Review"), expiresAtMs: Date.now() + 65_000 });
  store.request(accessRequest("waiting", "Other"));
  const screen = await render(<ComputerAccessInbox />);
  try {
    await expect.element(page.getByText(/Expires in 1:0[45]/)).toBeVisible();
    await expect.element(page.getByText("1 more requests waiting")).toBeVisible();
  } finally {
    await screen.unmount();
  }
  store.settle({ requestId: "deadline", threadId, allowed: true });
  store.settle({ requestId: "waiting", threadId, allowed: true });
  store.record({ threadId, backend: "native", op: "type", status: "interrupted" });
  store.record({
    threadId,
    source: "tool",
    backend: "native",
    op: "type",
    status: "failed",
    outcome: "OutcomeUnknown",
  });
  const card = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await page.getByRole("button", { name: "Actions (1)" }).click();
    await expect.element(page.getByText("OutcomeUnknown · 0s ago")).toBeVisible();
  } finally {
    await card.unmount();
  }
});
it("expires staggered activity and lease feedback without an interval", async () => {
  const store = useAgentComputerActivityStore.getState();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now - 14_800);
  store.record({ threadId, backend: "native", op: "wait", status: "completed" });
  store.setLeases({ holders: [{ threadId, delivery: "foreground", state: "active" }] });
  clock.mockReturnValue(now - 14_200);
  store.setLeases({ holders: [] });
  clock.mockRestore();
  const interval = vi.spyOn(globalThis, "setInterval");
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect.element(page.getByTestId("computer-live-card")).toBeVisible();
    await expect.element(page.getByTestId("computer-live-card")).not.toBeInTheDocument();
    expect(interval).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("Pause all always pauses its snapshot and a partial failure never resumes another target", async () => {
  const store = useAgentComputerActivityStore.getState();
  const other = ThreadId.makeUnsafe("other-computer");
  const pause = vi.fn(async (id: string, paused: boolean) => {
    if (id === other) throw new Error("fixture refusal");
    store.setPaused(id, paused);
  });
  nativeMock.api = { preview: { automation: { setPaused: async () => {} } } } as never;
  window.desktopBridge = { computerAutomation: { setPaused: pause } } as never;
  store.setLeases({
    holders: [
      { threadId, delivery: "background", state: "active" },
      { threadId: other, delivery: "background", state: "active" },
    ],
  });
  const screen = await render(<ComputerUseBanner />);
  try {
    await page.getByRole("button", { name: "Pause all" }).click();
    await vi.waitFor(() => expect(pause).toHaveBeenCalledTimes(2));
    expect(pause.mock.calls).toEqual([
      [threadId, true],
      [other, true],
    ]);
    expect(useAgentComputerActivityStore.getState().paused[threadId]).toBe(true);
    await expect.element(page.getByRole("button", { name: "Stop all" })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});
it("keeps a failed suspension unconfirmed after successful interruption and exposes an explicit retry", async () => {
  const store = useAgentComputerActivityStore.getState();
  const dispatch = vi.fn(async () => {});
  nativeMock.api = {
    orchestration: { dispatchCommand: dispatch },
    preview: { automation: { setPaused: async () => {} } },
  } as never;
  window.desktopBridge = {
    computerAutomation: {
      setPaused: vi.fn(async () => {
        throw new Error("fixture refusal");
      }),
    },
  } as never;
  store.setLeases({ holders: [{ threadId, delivery: "foreground", state: "active" }] });
  const screen = await render(<ComputerUseBanner />);
  try {
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.element(page.getByText(/Stop unconfirmed/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Retry Stop" })).toBeVisible();
    expect(dispatch).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatch).toHaveBeenCalledOnce();
    store.setLeases({
      holders: [{ threadId, delivery: "foreground", state: "paused", leaseHeld: false }],
    });
    await expect.element(page.getByRole("button", { name: "Retry Stop" })).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
it.each([
  ["ambient", { delivery: "background" as const }],
  ["foreground", { delivery: "foreground" as const }],
])("keeps the %s banner's Stop clickable over the window drag region", async (_, holder) => {
  useAgentComputerActivityStore.getState().setLeases({
    holders: [{ threadId, state: "active", appName: "Notes", ...holder }],
  });
  const screen = await render(
    <>
      <div className="drag-region fixed inset-x-0 top-0 h-12" />
      <ComputerUseBanner />
    </>,
  );
  try {
    const banner = page.getByTestId("computer-use-banner");
    await expect.element(banner).toBeVisible();
    expect(getComputedStyle(banner.element()).getPropertyValue("-webkit-app-region")).toBe(
      "no-drag",
    );
  } finally {
    await screen.unmount();
  }
});
it("keeps the Chrome banner up between calls and hides it once the runtime stays idle", async () => {
  const store = useAgentComputerActivityStore.getState();
  const chrome = { threadId, delivery: "foreground" as const, state: "active" as const };
  const banner = () => document.querySelector('[data-testid="computer-use-banner"]');
  // Lets the banner's effect schedule (or cancel) its linger timer before time moves.
  const settle = (browser: "idle" | "working") => {
    store.setLeases({ holders: [{ ...chrome, browser }] });
    return vi.waitFor(() => expect(vi.getTimerCount()).toBe(browser === "idle" ? 1 : 0));
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.setLeases({ holders: [{ ...chrome, browser: "working" }] });
  const screen = await render(<ComputerUseBanner />);
  try {
    await vi.waitFor(() => expect(banner()?.textContent).toContain("An agent is using Chrome"));
    await settle("idle");
    await vi.advanceTimersByTimeAsync(CHROME_BANNER_LINGER_MS - 500);
    expect(banner()?.textContent).toContain("An agent is using Chrome");
    await settle("working");
    await vi.advanceTimersByTimeAsync(CHROME_BANNER_LINGER_MS);
    expect(banner()?.textContent).toContain("An agent is using Chrome");
    await settle("idle");
    await vi.advanceTimersByTimeAsync(CHROME_BANNER_LINGER_MS);
    await vi.waitFor(() => expect(banner()).toBeNull());
  } finally {
    await screen.unmount();
    vi.useRealTimers();
  }
});
