import "../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import ProjectScriptDialog from "./ProjectScriptDialog";

it("round-trips the stop-on-settlement option and lets it be disabled", async () => {
  const script = {
    id: "dev",
    name: "Dev",
    command: "bun dev",
    icon: "play" as const,
    runOnWorktreeCreate: false,
    stopOnSettle: true,
  };
  const update = vi.fn();
  render(
    <ProjectScriptDialog
      open
      onOpenChange={() => {}}
      editingScript={script}
      scripts={[script]}
      keybindings={[]}
      onAddScript={() => {}}
      onUpdateScript={update}
      onDeleteScript={() => {}}
    />,
  );
  const stop = page.getByRole("switch", { name: "Stop this action when the thread settles" });
  await expect.element(stop).toBeChecked();
  await page.getByRole("button", { name: "Save changes" }).click();
  expect(update).toHaveBeenCalledWith("dev", expect.objectContaining({ stopOnSettle: true }));
  await stop.click();
  await page.getByRole("button", { name: "Save changes" }).click();
  expect(update).toHaveBeenLastCalledWith("dev", expect.objectContaining({ stopOnSettle: false }));
});
