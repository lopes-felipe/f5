import "../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  PullRequestKey,
  ThreadId,
  type PrHubListPage,
  type TrackedPullRequest,
} from "@t3tools/contracts";

import ChatMarkdown from "./ChatMarkdown";
import { OpenLinkThread } from "../hooks/useOpenLink";
import { setPrHubAccount } from "../lib/prHubAccount";
import { prHubListQueryOptions } from "../lib/prHubReactQuery";

const openLink = vi.hoisted(() =>
  vi.fn(async (_url: string, _options?: { external?: boolean; preview?: boolean }) => {}),
);
vi.mock("../hooks/useOpenLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useOpenLink")>()),
  useOpenLink: () => openLink,
}));
const showContextMenu = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
const peekPullRequest = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({ contextMenu: { show: showContextMenu } }) as never,
  ensureNativeApi: () => ({ prHub: { peek: peekPullRequest } }),
}));

afterEach(() => {
  openLink.mockClear();
  showContextMenu.mockReset().mockResolvedValue(null);
  peekPullRequest.mockReset().mockResolvedValue(null);
  setPrHubAccount(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("opens a PR preview with the listed title while the server read is pending", async () => {
  const href = "https://github.com/org/repo/pull/7";
  const generation = "preview-account";
  setPrHubAccount({ host: "github.com", generation, viewerId: 7 });
  const tracked = {
    key: PullRequestKey.makeUnsafe("github:github.com/org/repo#7"),
    title: "Known title from PR Hub",
    url: href,
    provider: "github",
    host: "github.com",
    repository: { nameWithOwner: "org/repo" },
    number: 7,
    state: "open",
    author: "alice",
    isDraft: false,
    additions: 1,
    deletions: 0,
    checkRollup: "none",
    reviewDecision: "none",
    mergeable: "unknown",
    unresolvedThreadCount: 0,
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:00.000Z",
  } as TrackedPullRequest;
  const client = new QueryClient();
  const page = {
    status: "ok",
    revision: "one",
    accountGeneration: generation,
    pullRequests: [tracked],
    nextCursor: null,
  } satisfies PrHubListPage;
  client.setQueryData(prHubListQueryOptions({}, "one").queryKey, {
    pages: [page],
    pageParams: [undefined],
  });
  let finishRead!: (value: null) => void;
  peekPullRequest.mockReturnValue(
    new Promise((resolve) => {
      finishRead = resolve;
    }),
  );
  const view = await render(
    <QueryClientProvider client={client}>
      <ChatMarkdown text={"[the PR](" + href + ")"} cwd={undefined} />
    </QueryClientProvider>,
  );
  try {
    await view.getByRole("link", { name: "the PR" }).hover();
    await expect.element(view.getByText(tracked.title)).toBeVisible();
    expect(peekPullRequest).toHaveBeenCalledOnce();
  } finally {
    finishRead(null);
    await view.unmount();
    client.clear();
  }
});

function click(link: HTMLElement, init: MouseEventInit = {}) {
  return link.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
  );
}

function contextMenu(link: HTMLElement, clientX = 0, clientY = 0) {
  return link.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX, clientY }),
  );
}

it.each(["cursor", "vscode"])("opens %s editor file links from chat", async (scheme) => {
  const href = scheme + "://file/Users/me/src/main.ts:186";
  const view = await render(<ChatMarkdown text={"[Open in editor](" + href + ")"} cwd="/repo" />);
  try {
    const link = view.getByRole("link", { name: "Open in editor" });
    await expect.element(link).toHaveAttribute("href", href);
    await link.click();
    expect(openLink).toHaveBeenCalledWith(href, undefined);
  } finally {
    await view.unmount();
  }
});

it("opens an Option/Alt-clicked chat link in the system browser", async () => {
  const href = "https://example.com/docs";
  const view = await render(<ChatMarkdown text={`[docs](${href})`} cwd={undefined} />);
  const link = view.getByRole("link", { name: "docs" }).element() as HTMLElement;

  expect(click(link)).toBe(false);
  expect(openLink).toHaveBeenLastCalledWith(href, undefined);

  expect(click(link, { altKey: true })).toBe(false);
  expect(openLink).toHaveBeenLastCalledWith(href, { external: true });

  // Cmd, Ctrl and Shift clicks stay with the shell's own _blank handling.
  openLink.mockClear();
  click(link, { metaKey: true });
  expect(openLink).not.toHaveBeenCalled();
});

it("offers Copy Link and the open actions from a chat link's context menu on desktop", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  showContextMenu.mockResolvedValueOnce("copy-link");
  const href = "https://example.com/docs?topic=menus#copy";
  const view = await render(<ChatMarkdown text={`[docs](${href})`} cwd={undefined} />);
  const link = view.getByRole("link", { name: "docs" }).element() as HTMLElement;
  // Only the click-time check matters; a full bridge would also drive theme syncing.
  vi.stubGlobal("desktopBridge", {});

  expect(contextMenu(link, 12, 24)).toBe(false);
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(href));
  expect(showContextMenu).toHaveBeenCalledWith(
    [
      { id: "open-external", label: "Open in system browser" },
      { id: "copy-link", label: "Copy Link" },
    ],
    { x: 12, y: 24 },
  );
  expect(openLink).not.toHaveBeenCalled();

  showContextMenu.mockResolvedValueOnce("open-external");
  contextMenu(link);
  await vi.waitFor(() => expect(openLink).toHaveBeenCalledWith(href, { external: true }));
});

it("keeps the default menu for non-web links and outside the desktop app", async () => {
  const view = await render(
    <ChatMarkdown
      text={"[web](https://example.com) [mail](mailto:a@example.com)"}
      cwd={undefined}
    />,
  );
  expect(contextMenu(view.getByRole("link", { name: "web" }).element() as HTMLElement)).toBe(true);
  vi.stubGlobal("desktopBridge", {});
  expect(contextMenu(view.getByRole("link", { name: "mail" }).element() as HTMLElement)).toBe(true);
  expect(showContextMenu).not.toHaveBeenCalled();
});

it("offers the link menu on pull request links", async () => {
  const href = "https://github.com/org/repo/pull/7";
  const view = await render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatMarkdown text={`[the PR](${href})`} cwd={undefined} />
    </QueryClientProvider>,
  );
  const link = view.getByRole("link", { name: "the PR" }).element() as HTMLElement;
  vi.stubGlobal("desktopBridge", {});
  showContextMenu.mockResolvedValueOnce("open-external");

  expect(contextMenu(link)).toBe(false);
  await vi.waitFor(() => expect(openLink).toHaveBeenCalledWith(href, { external: true }));
  expect(showContextMenu).toHaveBeenCalledWith(
    expect.arrayContaining([{ id: "copy-link", label: "Copy Link" }]),
    { x: 0, y: 0 },
  );
});

it("offers the integrated browser for a link in a thread", async () => {
  vi.stubGlobal("desktopBridge", { preview: {}, setTheme: async () => {} });
  showContextMenu.mockResolvedValueOnce("open-in-preview");
  const href = "https://example.com/docs";
  const view = await render(
    <OpenLinkThread.Provider value={ThreadId.makeUnsafe("thread-with-preview")}>
      <ChatMarkdown text={`[docs](${href})`} cwd={undefined} />
    </OpenLinkThread.Provider>,
  );

  contextMenu(view.getByRole("link", { name: "docs" }).element() as HTMLElement);
  await vi.waitFor(() => expect(openLink).toHaveBeenCalledWith(href, { preview: true }));
  expect(showContextMenu).toHaveBeenCalledWith(
    [
      { id: "open-in-preview", label: "Open in integrated browser" },
      { id: "open-external", label: "Open in system browser" },
      { id: "copy-link", label: "Copy Link" },
    ],
    { x: 0, y: 0 },
  );
});
