import "../../index.css";
import type { WorktreeCleanupRules } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { WorktreeCleanupRulesEditor } from "./WorktreeCleanupRulesEditor";

const rules: WorktreeCleanupRules = {
  afterDays: null,
  onMerge: false,
  onDelete: false,
  unchanged: true,
  minIdleHours: 24,
};
const label = "Wait before removing unchanged or merged worktrees";
let view: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

it("commits a valid wait and leaves invalid ones uncommitted", async () => {
  const onChange = vi.fn();
  view = await render(<WorktreeCleanupRulesEditor rules={rules} onChange={onChange} />);
  const input = page.getByRole("textbox", { name: label, exact: true });

  for (const value of ["0", "721", ""]) {
    await input.fill(value);
    await userEvent.keyboard("{Enter}");
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
  }
  expect(onChange).not.toHaveBeenCalled();

  await input.fill("6");
  await userEvent.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith({ ...rules, minIdleHours: 6 });
  await expect.element(input).not.toHaveAttribute("aria-invalid");
});

it("disables the wait when neither rule that uses it is on", async () => {
  view = await render(
    <WorktreeCleanupRulesEditor rules={{ ...rules, unchanged: false }} onChange={vi.fn()} />,
  );
  await expect.element(page.getByRole("textbox", { name: label, exact: true })).toBeDisabled();
});
