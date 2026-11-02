import { describe, expect, it, vi } from "vitest";

import {
  type ExternalLinkContextMenuAction,
  isExternalWebLink,
  showExternalLinkContextMenu,
} from "./externalLinkContextMenu";

function harness(selection: ExternalLinkContextMenuAction | null, canOpenInPreview = true) {
  return {
    canOpenInPreview,
    showContextMenu: vi.fn(async () => selection),
    openInPreview: vi.fn(async (_href: string) => {}),
    openExternal: vi.fn(async (_href: string) => {}),
    copyLink: vi.fn(async (_href: string) => {}),
    onFailure: vi.fn(),
  };
}

describe("chat link context menu", () => {
  it("offers both open actions and Copy Link", async () => {
    const callbacks = harness(null);
    await showExternalLinkContextMenu({
      href: "https://example.com/docs",
      position: { x: 12, y: 24 },
      ...callbacks,
    });
    expect(callbacks.showContextMenu).toHaveBeenCalledWith(
      [
        { id: "open-in-preview", label: "Open in integrated browser" },
        { id: "open-external", label: "Open in system browser" },
        { id: "copy-link", label: "Copy Link" },
      ],
      { x: 12, y: 24 },
    );
    expect(callbacks.openInPreview).not.toHaveBeenCalled();
    expect(callbacks.openExternal).not.toHaveBeenCalled();
    expect(callbacks.copyLink).not.toHaveBeenCalled();
  });

  it("omits the integrated browser when it is unavailable", async () => {
    const callbacks = harness(null, false);
    await showExternalLinkContextMenu({
      href: "https://example.com",
      position: { x: 0, y: 0 },
      ...callbacks,
    });
    expect(callbacks.showContextMenu).toHaveBeenCalledWith(
      [
        { id: "open-external", label: "Open in system browser" },
        { id: "copy-link", label: "Copy Link" },
      ],
      { x: 0, y: 0 },
    );
  });

  it.each([
    ["copy-link", "copyLink"],
    ["open-in-preview", "openInPreview"],
    ["open-external", "openExternal"],
  ] as const)("runs only the %s action with the exact destination", async (selection, callback) => {
    const callbacks = harness(selection);
    const href = "https://example.com/docs?topic=menus#copy";
    await showExternalLinkContextMenu({ href, position: { x: 1, y: 2 }, ...callbacks });
    for (const name of ["copyLink", "openInPreview", "openExternal"] as const) {
      if (name === callback) expect(callbacks[name]).toHaveBeenCalledExactlyOnceWith(href);
      else expect(callbacks[name]).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["copy-link", "copyLink"],
    ["open-in-preview", "openInPreview"],
    ["open-external", "openExternal"],
  ] as const)("reports a failed %s action", async (selection, callback) => {
    const callbacks = harness(selection);
    const cause = new Error("failed");
    callbacks[callback].mockRejectedValue(cause);
    await showExternalLinkContextMenu({
      href: "https://a.test",
      position: { x: 0, y: 0 },
      ...callbacks,
    });
    expect(callbacks.onFailure).toHaveBeenCalledExactlyOnceWith(selection, cause);
  });

  it("reports a menu that cannot be shown and runs no action", async () => {
    const callbacks = harness("copy-link");
    const cause = new Error("menu unavailable");
    callbacks.showContextMenu.mockRejectedValue(cause);
    await showExternalLinkContextMenu({
      href: "https://a.test",
      position: { x: 0, y: 0 },
      ...callbacks,
    });
    expect(callbacks.onFailure).toHaveBeenCalledExactlyOnceWith("show-link-context-menu", cause);
    expect(callbacks.copyLink).not.toHaveBeenCalled();
  });

  it.each([
    ["https://example.com", true],
    ["http://localhost:3000/path", true],
    ["#details", false],
    ["mailto:hello@example.com", false],
    ["file:///tmp/example.txt", false],
    ["javascript:void(0)", false],
    ["not a URL", false],
    [undefined, false],
  ])("treats %s as an external web link: %s", (href, expected) => {
    expect(isExternalWebLink(href)).toBe(expected);
  });
});
