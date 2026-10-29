import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { dismissContextMenuFallback, showContextMenuFallback } from "./contextMenuFallback";

const items = [
  { id: "disabled", label: "Unavailable", disabled: true },
  { id: "rename", label: "Rename" },
  { id: "pin", label: "Pin", separatorBefore: true },
  { id: "archive", label: "Archive" },
];

const cleanups: Array<() => void> = [];

afterEach(() => {
  dismissContextMenuFallback(false);
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function setup() {
  const origin = document.createElement("button");
  origin.textContent = "Selected thread";
  const after = document.createElement("button");
  after.textContent = "Next control";
  document.body.append(origin, after);
  cleanups.push(() => {
    origin.remove();
    after.remove();
  });
  // A real Tab keeps the opener :focus-visible, as when the menu key opens the menu.
  document.body.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(origin);
  return { origin, after };
}

const label = () => document.activeElement?.textContent;

it("starts a keyboard-opened menu on its first action and wraps through enabled actions", async () => {
  await setup();
  void showContextMenuFallback(items);
  expect(label()).toBe("Rename");
  await userEvent.keyboard("{ArrowUp}");
  expect(label()).toBe("Archive");
  await userEvent.keyboard("{ArrowDown}");
  expect(label()).toBe("Rename");
  await userEvent.keyboard("{End}");
  expect(label()).toBe("Archive");
  await userEvent.keyboard("{Home}");
  expect(label()).toBe("Rename");
});

it("activates the focused action with Enter and returns focus to the opener on Escape", async () => {
  const fixture = await setup();
  const chosen = showContextMenuFallback(items);
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect(chosen).resolves.toBe("pin");

  fixture.origin.focus();
  const dismissed = showContextMenuFallback(items);
  await userEvent.keyboard("{Escape}");
  await expect(dismissed).resolves.toBeNull();
  expect(document.activeElement).toBe(fixture.origin);
});

it("closes on Tab and continues the Tab order from the opener", async () => {
  const fixture = await setup();
  const result = showContextMenuFallback(items);
  await userEvent.tab();
  await expect(result).resolves.toBeNull();
  expect(document.activeElement).toBe(fixture.after);
});

it("closes without taking focus back when focus moves elsewhere", async () => {
  const fixture = await setup();
  const result = showContextMenuFallback(items);
  fixture.after.focus();
  await expect(result).resolves.toBeNull();
  expect(document.activeElement).toBe(fixture.after);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("keeps only one menu open at a time", async () => {
  await setup();
  const first = showContextMenuFallback(items);
  const second = showContextMenuFallback(items);
  await expect(first).resolves.toBeNull();
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  dismissContextMenuFallback();
  await expect(second).resolves.toBeNull();
});
