import "../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";

const openLink = vi.hoisted(() =>
  vi.fn(async (_url: string, _options?: { external?: boolean }) => {}),
);
vi.mock("../hooks/useOpenLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useOpenLink")>()),
  useOpenLink: () => openLink,
}));

afterEach(() => {
  openLink.mockClear();
  document.body.innerHTML = "";
});

function click(link: HTMLElement, init: MouseEventInit = {}) {
  return link.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
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
