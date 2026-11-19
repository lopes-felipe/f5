import "../index.css";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { parsePatchFiles } from "@pierre/diffs";
import { SearchableDiffView } from "./SearchableDiffView";
import { PREFERRED_HIGHLIGHTER } from "../lib/diffRendering";

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
