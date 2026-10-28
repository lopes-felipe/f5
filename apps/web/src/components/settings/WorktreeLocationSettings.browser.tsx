import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { WorktreeLocationSettings } from "./WorktreeLocationSettings";

const state = vi.hoisted(() => ({ directory: "/worktrees", save: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (settings: { worktreesDirectory: string }) => unknown) =>
    select({ worktreesDirectory: state.directory }),
  useUpdateSettings: () => ({ updateSettings: state.save }),
}));
beforeEach(() => {
  state.directory = "/worktrees";
  state.save.mockReset().mockImplementation(async ({ worktreesDirectory }) => {
    state.directory = worktreesDirectory;
  });
});

it("resets once without saving the blurred draft", async () => {
  const view = await render(<WorktreeLocationSettings />);
  try {
    await page.getByRole("textbox", { name: "Worktree location" }).fill("/unused-draft");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(state.save).toHaveBeenCalledExactlyOnceWith({ worktreesDirectory: "" });
    await expect.element(page.getByRole("textbox")).toHaveValue("");
  } finally {
    await view.unmount();
  }
});

it("saves on Enter and keeps validation failures next to the draft", async () => {
  state.save.mockRejectedValue(new Error("Worktree location must be an absolute folder."));
  const view = await render(<WorktreeLocationSettings />);
  try {
    const field = page.getByRole("textbox", { name: "Worktree location" });
    await field.fill("relative");
    await userEvent.keyboard("{Enter}");
    expect(state.save).toHaveBeenCalledExactlyOnceWith({ worktreesDirectory: "relative" });
    await expect.element(page.getByRole("alert")).toHaveTextContent("must be an absolute folder");
    await expect.element(field).toHaveAttribute("aria-invalid", "true");
    await expect.element(field).toHaveValue("relative");
  } finally {
    await view.unmount();
  }
});
