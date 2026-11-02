import "../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadId } from "@t3tools/contracts";

import ChatMarkdown from "./ChatMarkdown";
import { OpenLinkThread } from "../hooks/useOpenLink";

const openLink = vi.hoisted(() =>
  vi.fn(async (_url: string, _options?: { external?: boolean; preview?: boolean }) => {}),
);
vi.mock("../hooks/useOpenLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useOpenLink")>()),
  useOpenLink: () => openLink,
}));
const showContextMenu = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({ contextMenu: { show: showContextMenu } }) as never,
}));

afterEach(() => {
  openLink.mockClear();
  showContextMenu.mockReset().mockResolvedValue(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
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
  const view = await render(<ChatMarkdown text={`[the PR](${href})`} cwd={undefined} />);
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
