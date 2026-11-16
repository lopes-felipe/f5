import "../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ThreadId } from "@t3tools/contracts";
import { OpenLinkThread, useOpenLink } from "../hooks/useOpenLink";
import { OpenLinkAnchor } from "./OpenLinkAnchor";
import { useRightPanelStore } from "../rightPanelStore";
const api = vi.hoisted(() => ({ navigate: vi.fn(), openExternal: vi.fn(), previewOpen: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: api.navigate }),
}));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ preview: { open: api.previewOpen } }),
}));
const thread = ThreadId.makeUnsafe("pr-link-owner");
const url = "https://github.com/org/repo/pull/7";
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.desktopBridge = { openExternal: api.openExternal, preview: {} } as never;
  useRightPanelStore.setState({ byThreadId: {}, closedHistory: [] });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  localStorage.clear();
  delete window.desktopBridge;
});
async function mount(owner: ThreadId | undefined = thread) {
  active = await render(
    <OpenLinkThread.Provider value={owner}>
      <label>
        Composer
        <input aria-label="Composer" defaultValue="Keep my draft" />
      </label>
      <OpenLinkAnchor href={url}>Linked PR</OpenLinkAnchor>
    </OpenLinkThread.Provider>,
  );
}
function click(event: MouseEventInit = {}) {
  page
    .getByRole("link", { name: "Linked PR" })
    .element()
    .dispatchEvent(
      new MouseEvent(event.button === 1 ? "auxclick" : "click", {
        bubbles: true,
        cancelable: true,
        ...event,
      }),
    );
}
it("opens the PR beside its owner without navigating or replacing the draft", async () => {
  await mount();
  await page.getByRole("link", { name: "Linked PR" }).click();
  expect(useRightPanelStore.getState().byThreadId[thread]).toMatchObject({
    isOpen: true,
    activeSurfaceId: "pr:github:github.com/org/repo#7",
    surfaces: [{ kind: "pull-request", url }],
  });
  await expect
    .element(page.getByRole("textbox", { name: "Composer" }))
    .toHaveValue("Keep my draft");
  expect(api.navigate).not.toHaveBeenCalled();
  expect(api.openExternal).not.toHaveBeenCalled();
  expect(api.previewOpen).not.toHaveBeenCalled();
});
it.each([{ metaKey: true }, { ctrlKey: true }, { button: 1 }, { altKey: true }])(
  "opens modified and middle clicks in the system browser: %j",
  async (event) => {
    await mount();
    click(event);
    expect(api.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(useRightPanelStore.getState().byThreadId[thread]).toBeUndefined();
    expect(api.navigate).not.toHaveBeenCalled();
  },
);
it("the persisted forge setting bypasses the panel and the preview browser", async () => {
  localStorage.setItem(
    "t3code:app-settings:v1",
    JSON.stringify({ pullRequestLinksOpenInApp: false, linkOpenTarget: "preview" }),
  );
  await mount();
  click();
  expect(api.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  expect(api.previewOpen).not.toHaveBeenCalled();
  expect(useRightPanelStore.getState().byThreadId[thread]).toBeUndefined();
});
function OpenInPreview({ href }: { href: string }) {
  const open = useOpenLink();
  return (
    <button type="button" onClick={() => void open(href, { preview: true })}>
      Open in integrated browser
    </button>
  );
}
async function openInPreview(href: string, owner: ThreadId | null = thread) {
  active = await render(
    <OpenLinkThread.Provider value={owner ?? undefined}>
      <OpenInPreview href={href} />
    </OpenLinkThread.Provider>,
  );
  await page.getByRole("button", { name: "Open in integrated browser" }).click();
}
it.each([
  ["a page, with the system browser as the link target", "https://example.com/docs"],
  ["a PR that would otherwise open in its panel", url],
])("opens %s in the integrated browser on request", async (_, href) => {
  await openInPreview(href);
  await vi.waitFor(() =>
    expect(api.previewOpen).toHaveBeenCalledExactlyOnceWith({
      threadId: thread,
      url: href,
      colorScheme: "system",
    }),
  );
  expect(useRightPanelStore.getState().byThreadId[thread]?.surfaces).not.toContainEqual(
    expect.objectContaining({ kind: "pull-request" }),
  );
  expect(api.openExternal).not.toHaveBeenCalled();
  expect(api.navigate).not.toHaveBeenCalled();
});
it("falls back to the system browser for a preview request without a thread", async () => {
  await openInPreview("https://example.com/docs", null);
  await vi.waitFor(() =>
    expect(api.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/docs"),
  );
  expect(api.previewOpen).not.toHaveBeenCalled();
});
it("opens the in-app PR page when there is no current thread", async () => {
  // Pass through a separate provider because an omitted argument selects the default owner.
  active = await render(
    <OpenLinkThread.Provider value={undefined}>
      <OpenLinkAnchor href={url}>Linked PR</OpenLinkAnchor>
    </OpenLinkThread.Provider>,
  );
  click();
  expect(api.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/pull-requests", search: { url } });
  expect(api.openExternal).not.toHaveBeenCalled();
});
