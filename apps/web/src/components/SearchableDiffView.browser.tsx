import "../index.css";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { parsePatchFiles } from "@pierre/diffs";
import { SearchableDiffView } from "./SearchableDiffView";
import { PREFERRED_HIGHLIGHTER } from "../lib/diffRendering";
import type { CodeViewHandle } from "@pierre/diffs/react";

const patch =
  "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+needle\n";
const fileDiff = parsePatchFiles(patch)[0]!.files[0]!;
const reveal = vi.fn();
function Harness() {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div style={{ height: 400 }}>
      <SearchableDiffView
        className="diff-render-surface h-full overflow-auto"
        files={[{ id: "example", fileDiff, collapsed }]}
        options={{ theme: "pierre-dark", preferredHighlighter: PREFERRED_HIGHLIGHTER }}
        onCollapse={(_id, next) => {
          reveal(next);
          setCollapsed(next);
        }}
      />
    </div>
  );
}
it("opens find with the keyboard and unfolds a matching file", async () => {
  const screen = await render(<Harness />);
  try {
    const root = document.querySelector<HTMLElement>(".diff-render-surface")!;
    root.focus();
    const mac = navigator.platform.toLowerCase().includes("mac");
    root.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        ctrlKey: !mac,
        metaKey: mac,
        bubbles: true,
        composed: true,
      }),
    );
    await page.getByPlaceholder("Search", { exact: true }).fill("needle");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => reveal.mock.calls.some(([value]) => value === false)).toBe(true);
    await expect.element(page.getByRole("button", { name: "Collapse example.ts" })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("keeps item versions stable across parent renders and changes only the folded item", async () => {
  let handle: CodeViewHandle<undefined, undefined> | null = null;
  const view = (collapsed: boolean) => (
    <SearchableDiffView
      viewerRef={(next) => {
        handle = next;
      }}
      className="diff-render-surface h-96 overflow-auto"
      files={[
        { id: "first", fileDiff, collapsed },
        { id: "second", fileDiff, collapsed: false },
      ]}
      options={{ theme: "pierre-dark", preferredHighlighter: PREFERRED_HIGHLIGHTER }}
    />
  );
  const screen = await render(view(false));
  try {
    const version = (id: string) => handle!.getItem(id)!.version;
    const first = version("first"),
      second = version("second");
    await screen.rerender(view(false));
    expect(version("first")).toBe(first);
    expect(version("second")).toBe(second);
    await screen.rerender(view(true));
    expect(version("first")).not.toBe(first);
    expect(version("second")).toBe(second);
  } finally {
    await screen.unmount();
  }
});

it("shows both rename paths and folds from the file header while preserving open and copy controls", async () => {
  const renamedFile = parsePatchFiles(
    "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
  )[0]!.files[0]!;
  const collapse = vi.fn();
  const open = vi.fn();
  const screen = await render(
    <SearchableDiffView
      className="diff-render-surface h-96 overflow-auto"
      files={[{ id: "renamed", fileDiff: renamedFile, collapsed: false }]}
      options={{ theme: "pierre-dark", preferredHighlighter: PREFERRED_HIGHLIGHTER }}
      onCollapse={collapse}
      onOpenFile={open}
    />,
  );
  try {
    const path = page.getByRole("button", { name: "old.ts → new.ts" });
    await expect.element(path).toBeVisible();
    const card = path.element().closest("diffs-container");
    expect(card).not.toBeNull();
    expect(getComputedStyle(card!).outlineStyle).toBe("solid");
    await path.click();
    expect(open).toHaveBeenCalledWith("new.ts");
    expect(collapse).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Copy path: new.ts" })).toBeVisible();
    await page.getByRole("button", { name: "Collapse new.ts" }).click({
      position: { x: 4, y: 4 },
    });
    expect(collapse).toHaveBeenCalledExactlyOnceWith("renamed", true);
  } finally {
    await screen.unmount();
  }
});
