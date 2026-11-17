import { useState } from "react";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import "../../index.css";
import { ThemeColorPicker } from "./ThemeColorPicker";

const LABEL = "Primary";

function Harness({
  initial,
  onChange,
}: {
  readonly initial: string;
  readonly onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ThemeColorPicker
      label={LABEL}
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

const trigger = () => page.getByRole("button", { name: `Pick ${LABEL} color` });
const textInput = () => page.getByRole("textbox", { name: LABEL });
const area = () => page.getByRole("slider", { name: `${LABEL} saturation and brightness` });
const hue = () => page.getByRole("slider", { name: `${LABEL} hue` });

async function openPicker() {
  await trigger().click();
  await expect.element(hue()).toBeVisible();
}

it("focuses the text field, not the picker, when the label is clicked", async () => {
  await render(<Harness initial="#3366cc" />);
  await page.getByText(LABEL, { exact: true }).click();
  await expect.element(textInput()).toHaveFocus();
  await expect.element(hue()).not.toBeInTheDocument();
});

it("accumulates rapid key steps and reports the final color", async () => {
  const onChange = vi.fn();
  await render(<Harness initial="#ff0000" onChange={onChange} />);
  await openPicker();
  await area().click({ position: { x: 1, y: 1 } });
  await userEvent.keyboard("{End}");
  await userEvent.keyboard("{PageUp}{PageUp}");
  await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{ArrowDown}{/Shift}");
  await expect.element(area()).toHaveAttribute("aria-valuetext", "Saturation 100%, brightness 70%");
  await expect.poll(() => onChange.mock.lastCall?.[0]).toBe("#b30000");
  await expect.element(textInput()).toHaveValue("#b30000");
});

it("keeps the hue through grey picks while the popover is open", async () => {
  await render(<Harness initial="#00ff00" />);
  await openPicker();
  await expect.element(hue()).toHaveAttribute("aria-valuenow", "120");
  await area().click({ position: { x: 1, y: 1 } });
  await userEvent.keyboard("{Home}");
  await expect.poll(() => textInput().element().getAttribute("value")).not.toBe("#00ff00");
  await userEvent.keyboard(
    "{End}{PageUp}{PageUp}{PageUp}{PageUp}{PageUp}{PageUp}{PageUp}{PageUp}{PageUp}{PageUp}",
  );
  await expect.element(hue()).toHaveAttribute("aria-valuenow", "120");
  await expect.element(textInput()).toHaveValue("#00ff00");
});

it("wraps the hue and supports Home, End and large steps", async () => {
  await render(<Harness initial="#ff0000" />);
  await openPicker();
  await hue().click({ position: { x: 1, y: 6 } });
  await userEvent.keyboard("{Home}{ArrowLeft}");
  await expect.element(hue()).toHaveAttribute("aria-valuenow", "359");
  await expect.element(hue()).toHaveAttribute("aria-valuetext", "359 degrees");
  await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
  await expect.element(hue()).toHaveAttribute("aria-valuenow", "9");
  await userEvent.keyboard("{PageUp}");
  await expect.element(hue()).toHaveAttribute("aria-valuenow", "19");
  await userEvent.keyboard("{End}");
  await expect.element(hue()).toHaveAttribute("aria-valuenow", "360");
});

it("re-seeds the picker from the current value each time it opens", async () => {
  await render(<Harness initial="#ff0000" />);
  await openPicker();
  await expect.element(hue()).toHaveAttribute("aria-valuenow", "0");
  await userEvent.keyboard("{Escape}");
  await expect.element(hue()).not.toBeInTheDocument();
  await textInput().fill("#0000ff");
  await userEvent.keyboard("{Enter}");
  await openPicker();
  await expect.element(hue()).toHaveAttribute("aria-valuenow", "240");
});

it("clears an earlier text error when a color is picked", async () => {
  const onChange = vi.fn();
  await render(<Harness initial="#ff0000" onChange={onChange} />);
  await textInput().fill("not a color");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Invalid theme color: not a color.")).toBeVisible();
  expect(onChange).not.toHaveBeenCalled();
  await openPicker();
  await area().click({ position: { x: 1, y: 1 } });
  await userEvent.keyboard("{End}");
  await expect.element(page.getByText("Invalid theme color: not a color.")).not.toBeInTheDocument();
  await expect.poll(() => onChange.mock.lastCall?.[0]).toMatch(/^#[0-9a-f]{6}$/);
});
