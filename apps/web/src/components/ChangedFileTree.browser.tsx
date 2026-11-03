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

it("keeps a colliding file selectable and its folder collapsible with real paths", async () => {
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
    const folder = screen.getByRole("button", { name: "Folder office", exact: true });
    const file = screen.getByRole("button", { name: "File office", exact: true });
    await expect.element(file).toHaveAttribute("title", "old-office → office");
    await expect.element(file).not.toHaveAttribute("aria-expanded");

    await screen.getByRole("button", { name: "File office/config.ts", exact: true }).click();
    await file.click();
    expect(onSelect.mock.calls).toEqual([["office/config.ts"], ["office"]]);
    file.element().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(onContextMenu).toHaveBeenCalledWith(expect.anything(), "office");
    await screen.getByRole("button", { name: "Copy path office", exact: true }).click();
    expect(copyToClipboard).toHaveBeenCalledWith("office", undefined);

    await folder.click();
    await expect.element(folder).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByRole("button", { name: "File office/config.ts", exact: true }))
      .not.toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledTimes(2);
    await file.click();
    expect(onSelect.mock.calls.at(-1)).toEqual(["office"]);
    await screen.getByRole("button", { name: "Expand folders", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "File office/config.ts", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Collapse folders", exact: true }).click();
    await expect.element(folder).toHaveAttribute("aria-expanded", "false");
    await screen.getByRole("button", { name: "Sort by full path", exact: true }).click();
    await screen.getByRole("button", { name: "File office/config.ts", exact: true }).click();
    expect(onSelect.mock.calls.at(-1)).toEqual(["office/config.ts"]);
  } finally {
    await screen.unmount();
  }
});

it("preserves file focus, icons and collapsed folders as colliding paths arrive and refresh", async () => {
  const onSelect = vi.fn();
  const view = (files: ChangedFileTreeEntry[]) => (
    <ChangedFileTree files={files} scope="paging" onSelect={onSelect} />
  );
  const files = [{ path: "office" }, { path: "src/route.ts" }];
  const screen = await render(view(files));
  try {
    await screen.getByText("Changed files (2)", { exact: true }).click();
    await screen.getByRole("button", { name: "Folder src", exact: true }).click();
    const officeFile = screen.getByRole("button", { name: "File office", exact: true });
    await officeFile.click();
    const fileIcon = officeFile.element().querySelector("svg")!.outerHTML;
    const file = document.activeElement;
    const appended = [...files, { path: "office/config.ts" }];
    await screen.rerender(view(appended));
    expect(document.activeElement).toBe(file);
    expect(officeFile.element().querySelector("svg")!.outerHTML).toBe(fileIcon);
    expect(onSelect.mock.calls).toEqual([["office"]]);
    await expect
      .element(screen.getByRole("button", { name: "Folder src", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    const officeFolder = screen.getByRole("button", { name: "Folder office", exact: true });
    await officeFolder.click();
    await screen.rerender(view(appended.map((entry) => ({ ...entry }))));
    await expect.element(officeFolder).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByRole("button", { name: "Folder src", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await officeFile.click();
    expect(onSelect.mock.calls).toEqual([["office"], ["office"]]);
  } finally {
    await screen.unmount();
  }
});
