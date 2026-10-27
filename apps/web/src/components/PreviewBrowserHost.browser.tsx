import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PreviewBrowserHost, PreviewPanelProjection } from "./PreviewBrowserHost";

vi.mock("./PreviewPanel", () => ({
  default: ({ threadId }: { threadId: string }) => <div data-preview-thread={threadId}>Guest</div>,
}));

const first = ThreadId.make("first");
const second = ThreadId.make("second");
const close = () => {};

it("keeps persistent guest ancestors in place when projection changes LRU order", async () => {
  const view = (visible: boolean) => (
    <PreviewBrowserHost>
      <PreviewPanelProjection threadId={first} visible={visible} onClose={close} />
      <PreviewPanelProjection threadId={second} visible onClose={close} />
    </PreviewBrowserHost>
  );
  const screen = await render(view(true));
  let observer: MutationObserver | undefined;
  try {
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-preview-thread]")).toHaveLength(2),
    );
    const guest = document.querySelector('[data-preview-thread="first"]')!;
    const host = guest.closest('[data-find-scope="preview"]')!;
    const parent = host.parentElement!;
    const removed: Node[] = [];
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) removed.push(...mutation.removedNodes);
    });
    observer.observe(parent, { childList: true });
    // Re-projecting first makes it newest in the LRU Map, after second.
    await screen.rerender(view(false));
    await vi.waitFor(() => expect(host.getAttribute("aria-hidden")).toBe("true"));
    expect(removed).not.toContain(host);
    expect(document.querySelector('[data-preview-thread="first"]')).toBe(guest);
  } finally {
    observer?.disconnect();
    await screen.unmount();
  }
});
