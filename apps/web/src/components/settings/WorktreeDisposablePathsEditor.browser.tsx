import "../../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  parseDisposablePathsInput,
  WorktreeDisposablePathsEditor,
} from "./WorktreeDisposablePathsEditor";

it("parses one trimmed, deduplicated glob per line", () => {
  expect(parseDisposablePathsInput("  a.js \n\n**/__screenshots__/\na.js\n")).toEqual([
    "a.js",
    "**/__screenshots__/",
  ]);
});

it("saves edited disposable paths and stays disabled while unchanged", async () => {
  const onSave = vi.fn();
  const view = await render(
    <WorktreeDisposablePathsEditor
      value={["apps/web/public/mockServiceWorker.js"]}
      onSave={onSave}
    />,
  );
  try {
    const save = page.getByRole("button", { name: "Save disposable paths" });
    await expect.element(save).toBeDisabled();
    const field = page.getByRole("textbox", { name: "Disposable worktree changes" });
    await field.fill("apps/web/public/mockServiceWorker.js\n**/__screenshots__/\n");
    await save.click();
    expect(onSave).toHaveBeenCalledWith([
      "apps/web/public/mockServiceWorker.js",
      "**/__screenshots__/",
    ]);
  } finally {
    await view.unmount();
  }
});
