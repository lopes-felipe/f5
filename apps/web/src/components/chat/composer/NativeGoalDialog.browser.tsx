import "../../../index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { NativeGoalDialog } from "./NativeGoalDialog";

function renderInComposerForm(
  overrides: Partial<Parameters<typeof NativeGoalDialog>[0]> = {},
  onComposerSubmit = vi.fn(),
) {
  const onOpenChange = vi.fn();
  const onSubmit = vi.fn(async () => true);
  // The real dialog is rendered from inside the composer's <form>.
  return {
    onComposerSubmit,
    onOpenChange,
    onSubmit,
    screen: render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onComposerSubmit();
        }}
      >
        <NativeGoalDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} {...overrides} />
      </form>,
    ),
  };
}

describe("NativeGoalDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("starts the goal without submitting the surrounding composer form", async () => {
    const { onComposerSubmit, onOpenChange, onSubmit, screen } = renderInComposerForm();
    const mounted = await screen;
    try {
      const start = page.getByRole("button", { name: "Start goal" });
      await expect.element(start).toBeDisabled();
      await page.getByLabelText("Objective").fill("Ship the tray");
      await page.getByLabelText("Token budget").fill("500");
      await start.click();
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Ship the tray", 500));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onComposerSubmit).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the dialog open when the provider does not admit the goal", async () => {
    const onSubmit = vi.fn(async () => false);
    const { onOpenChange, screen } = renderInComposerForm({ onSubmit });
    const mounted = await screen;
    try {
      await page.getByLabelText("Objective").fill("Ship the tray");
      await page.getByRole("button", { name: "Start goal" }).click();
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("rejects invalid budgets and refuses to submit once a turn starts", async () => {
    const { onSubmit, screen } = renderInComposerForm({ disabled: true });
    const mounted = await screen;
    try {
      await page.getByLabelText("Objective").fill("Ship the tray");
      await expect.element(page.getByRole("button", { name: "Start goal" })).toBeDisabled();
      await mounted.rerender(
        <form>
          <NativeGoalDialog open onOpenChange={() => {}} onSubmit={onSubmit} />
        </form>,
      );
      // The rerender reattaches the portaled popup. Let its opening focus task
      // and transitions settle before Playwright focuses and fills the number input.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const popup = page.getByRole("dialog").element();
      await Promise.all(
        popup.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
      const budget = page.getByLabelText("Token budget");
      await budget.click();
      await vi.waitFor(() => expect(document.activeElement).toBe(budget.element()));
      await budget.fill("0");
      await expect.element(budget).toHaveValue(0);
      await expect.element(page.getByLabelText("Objective")).toHaveValue("Ship the tray");
      await expect.element(page.getByRole("button", { name: "Start goal" })).toBeDisabled();
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});
