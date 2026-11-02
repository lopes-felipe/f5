import "../index.css";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { updateAppSettings } from "../appSettings";
import { ChangedFileTree, type ChangedFileTreeEntry } from "./ChangedFileTree";

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock("../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard }),
}));

beforeEach(() => {
  updateAppSettings({ diffFileTreeOrder: "folders", diffCollapsedFolders: {} });
});

afterEach(() => {
  updateAppSettings({ diffFileTreeOrder: "folders", diffCollapsedFolders: {} });
  vi.clearAllMocks();
});

it("keeps a colliding file selectable and its folder collapsible with real paths and icons", async () => {
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  const files = [{ path: "office/config.ts" }, { path: "office", previousPath: "old-office" }];
  const screen = await render(
    <ChangedFileTree
      files={files}
      scope="collision"
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    />,
  );
  try {
    await screen.getByText("Changed files (2)", { exact: true }).click();
    const folder = screen.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const file = screen.container.querySelector<HTMLButtonElement>(
      'button[title="old-office → office"]',
    )!;
    expect(folder.querySelector(".lucide-folder")).not.toBeNull();
    expect(file.querySelector(".lucide-file")).not.toBeNull();
    expect(file.hasAttribute("aria-expanded")).toBe(false);

    await screen.getByRole("button", { name: "config.ts", exact: true }).click();
    await screen.getByRole("button", { name: "office", exact: true }).all()[1]!.click();
    expect(onSelect.mock.calls).toEqual([["office/config.ts"], ["office"]]);
    file.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(onContextMenu).toHaveBeenCalledWith(expect.anything(), "office");
    await screen.getByRole("button", { name: "Copy path office", exact: true }).click();
    expect(copyToClipboard).toHaveBeenCalledWith("office", undefined);

    await screen.getByRole("button", { name: "office", exact: true }).all()[0]!.click();
    await expect.element(folder).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByRole("button", { name: "config.ts", exact: true }))
      .not.toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledTimes(2);
    await screen.getByRole("button", { name: "office", exact: true }).all()[1]!.click();
    expect(onSelect.mock.calls.at(-1)).toEqual(["office"]);
    await screen.getByRole("button", { name: "Expand folders", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "config.ts", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Collapse folders", exact: true }).click();
    await expect.element(folder).toHaveAttribute("aria-expanded", "false");
    await screen.getByRole("button", { name: "Sort by full path", exact: true }).click();
    await screen.getByRole("button", { name: "office/config.ts", exact: true }).click();
    expect(onSelect.mock.calls.at(-1)).toEqual(["office/config.ts"]);
  } finally {
    await screen.unmount();
  }
});

it("preserves file focus and collapsed folders as colliding paths arrive and refresh", async () => {
  const onSelect = vi.fn();
  const view = (files: ChangedFileTreeEntry[]) => (
    <ChangedFileTree files={files} scope="paging" onSelect={onSelect} />
  );
  const files = [{ path: "office" }, { path: "src/route.ts" }];
  const screen = await render(view(files));
  try {
    await screen.getByText("Changed files (2)", { exact: true }).click();
    await screen.getByRole("button", { name: "src", exact: true }).click();
    await screen.getByRole("button", { name: "office", exact: true }).click();
    const file = document.activeElement;
    const appended = [...files, { path: "office/config.ts" }];
    await screen.rerender(view(appended));
    expect(document.activeElement).toBe(file);
    expect(onSelect.mock.calls).toEqual([["office"]]);
    await expect
      .element(screen.getByRole("button", { name: "src", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await screen.getByRole("button", { name: "office", exact: true }).all()[0]!.click();
    await screen.rerender(view(appended.map((entry) => ({ ...entry }))));
    await expect
      .element(screen.getByRole("button", { name: "office", exact: true }).all()[0]!)
      .toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByRole("button", { name: "src", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await screen.getByRole("button", { name: "office", exact: true }).all()[1]!.click();
    expect(onSelect.mock.calls).toEqual([["office"], ["office"]]);
  } finally {
    await screen.unmount();
  }
});
