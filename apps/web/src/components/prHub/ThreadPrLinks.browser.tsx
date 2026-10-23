import { useRightPanelStore } from "../../rightPanelStore";
import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PullRequestKey,
  ThreadId,
  type PullRequestWatchChanged,
  type PullRequestWatchEntry,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ThreadPrLinks } from "./ThreadPrLinks";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  onChanged: vi.fn(),
  getThreadLinks: vi.fn(),
  peek: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ pullRequestWatches: api, prHub: api }),
}));
const threadId = ThreadId.makeUnsafe("thread-watch-browser");
const key = PullRequestKey.makeUnsafe("github:github.com/org/repo#7");
const url = "https://github.com/org/repo/pull/7";
const timestamp = "2026-10-19T12:00:00.000Z";
const entry: PullRequestWatchEntry = {
  threadId,
  key,
  watch: {
    startedAt: timestamp,
    headSha: "head",
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: timestamp,
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  },
};
let changed: ((input: PullRequestWatchChanged) => void) | undefined;
let saved: PullRequestWatchEntry[];
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  useRightPanelStore.setState({ byThreadId: {}, closedHistory: [] });
  saved = [];
  api.list.mockReset().mockImplementation(async () => saved);
  api.start.mockReset().mockImplementation(async () => {
    saved = [entry];
    return entry;
  });
  api.stop.mockReset().mockImplementation(async () => {
    saved = [];
  });
  api.onChanged.mockReset().mockImplementation((handler: typeof changed) => {
    changed = handler;
    return () => {
      changed = undefined;
    };
  });
  api.getThreadLinks.mockReset().mockResolvedValue([
    {
      provider: "github",
      host: "github.com",
      repository: "org/repo",
      number: 7,
      title: "Change",
      url,
    },
  ]);
  api.peek.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});
async function mount() {
  active = await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThreadPrLinks threadId={threadId} />
    </QueryClientProvider>,
  );
}
it("starts from the PR menu and stops from the header eye", async () => {
  await mount();
  await page.getByRole("button", { name: "PR #7 actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Watch", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Stop watching PR #7", exact: true }))
    .toBeVisible();
  expect(api.start).toHaveBeenCalledWith({ threadId, pr: url });
  await page.getByRole("button", { name: "Stop watching PR #7", exact: true }).click();
  await expect.poll(() => api.stop.mock.calls.length).toBe(1);
  await expect
    .element(page.getByRole("button", { name: "Stop watching PR #7", exact: true }))
    .not.toBeInTheDocument();
});
it("updates from server pushes and exposes watches without a linked PR", async () => {
  api.getThreadLinks.mockResolvedValue([]);
  await mount();
  await expect.poll(() => changed !== undefined).toBe(true);
  saved = [entry];
  changed?.({ threadId });
  await expect
    .element(page.getByRole("button", { name: `Stop watching ${key}`, exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: `Stop watching ${key}`, exact: true }).click();
  await expect.poll(() => api.stop.mock.calls.length).toBe(1);
  expect(api.stop).toHaveBeenCalledWith({ threadId, pr: key });
});
it("keeps a failed watch start visible as an error without a watched indicator", async () => {
  api.start.mockRejectedValue(new Error("private provider details"));
  await mount();
  await page.getByRole("button", { name: "PR #7 actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Watch", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Could not update the PR watch.");
  expect(page.getByRole("button", { name: "Stop watching PR #7", exact: true }).query()).toBeNull();
  expect(page.getByText("private provider details").query()).toBeNull();
});

it("exports a linked PR drag as a reference without starting a watch or sending a turn", async () => {
  await mount();
  await expect.element(page.getByRole("link", { name: "github #7", exact: true })).toBeVisible();
  const transfer = new DataTransfer();
  page
    .getByRole("link", { name: "github #7", exact: true })
    .element()
    .dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  expect(JSON.parse(transfer.getData("application/x-f5-pull-request-reference"))).toEqual({
    version: 1,
    url,
  });
  expect(transfer.getData("text/plain")).toBe(`[PR #7](${url})`);
  expect(api.start).not.toHaveBeenCalled();
});

it("opens the same linked-PR actions on right-click without a host read", async () => {
  await mount();
  await expect.element(page.getByRole("link", { name: "github #7", exact: true })).toBeVisible();
  page
    .getByRole("link", { name: "github #7", exact: true })
    .element()
    .dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
    );
  await expect
    .element(page.getByRole("menuitem", { name: "Copy link", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Watch", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Close…", exact: true }).click();
  expect(useRightPanelStore.getState().byThreadId[threadId]).toMatchObject({
    activeSurfaceId: `pr:${key}`,
    surfaces: [
      expect.objectContaining({
        kind: "pull-request",
        initialAction: { kind: "close", id: expect.any(String) },
      }),
    ],
  });
  expect(api.start).not.toHaveBeenCalled();
});
it("shows Shift-only linked PR actions and clears them on blur", async () => {
  await mount();
  await expect.element(page.getByRole("link", { name: "github #7", exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: "Close PR #7", exact: true }).query()).toBeNull();
  await userEvent.keyboard("{Shift>}");
  await expect
    .element(page.getByRole("button", { name: "Close PR #7", exact: true }))
    .toBeVisible();
  window.dispatchEvent(new Event("blur"));
  await expect
    .element(page.getByRole("button", { name: "Close PR #7", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{/Shift}");
});
