import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { createWorkspaceFocusController } from "./workspaceFocus";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  const controller = createWorkspaceFocusController(document);
  cleanups.push(() => {
    controller.dispose();
    root.remove();
  });
  const area = (name: string, order: number, parent: HTMLElement = root) => {
    const element = document.createElement("section");
    element.dataset.workspaceArea = name;
    element.dataset.workspaceOrder = String(order);
    const button = document.createElement("button");
    button.textContent = name;
    element.append(button);
    parent.append(element);
    return { element, button };
  };
  const append = (html: string) => {
    root.insertAdjacentHTML("beforeend", html);
    return root.lastElementChild as HTMLElement;
  };
  return { area, append, controller };
}

describe("workspace area focus", () => {
  it("cycles in workspace order in both directions, independent of DOM order", () => {
    const fixture = setup();
    const panel = fixture.area("panel", 3);
    const sidebar = fixture.area("sidebar", 0);
    const conversation = fixture.area("conversation", 1);
    const composer = fixture.area("composer", 2);
    sidebar.button.focus();
    fixture.controller.move(1);
    // The conversation is a region; it takes focus itself rather than its first button.
    expect(document.activeElement).toBe(conversation.element);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(panel.button);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(sidebar.button);
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(panel.button);
  });

  it("treats a composer floating inside the conversation as its own area", () => {
    const fixture = setup();
    const conversation = fixture.area("conversation", 1);
    const composer = fixture.area("composer", 2, conversation.element);
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "Draft";
    composer.element.append(editor);
    editor.focus();
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(conversation.element);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(editor);
  });

  it("skips hidden, inert, and unavailable areas", () => {
    const fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const composer = fixture.area("composer", 2);
    const panel = fixture.area("panel", 3);
    const terminal = fixture.area("terminal", 4);
    composer.element.hidden = true;
    panel.element.dataset.workspaceUnavailable = "true";
    terminal.element.inert = true;
    sidebar.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(sidebar.button);
  });

  it("restores the last focused control and falls back when it is removed", () => {
    const fixture = setup();
    fixture.area("sidebar", 0);
    const composer = fixture.area("composer", 2);
    const remembered = document.createElement("button");
    remembered.textContent = "remembered";
    composer.element.append(remembered);
    remembered.focus();
    fixture.controller.move(-1);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(remembered);
    fixture.controller.move(-1);
    remembered.remove();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
  });

  it("keeps focus inside a dialog or an open popup", () => {
    const fixture = setup();
    fixture.area("sidebar", 0);
    fixture.area("panel", 3);
    const dialog = fixture.append('<div role="dialog" tabindex="-1">Confirm</div>');
    dialog.focus();
    expect(fixture.controller.move(1)).toBe(false);
    expect(document.activeElement).toBe(dialog);
    dialog.remove();

    const popup = fixture.append(
      '<div role="listbox" data-slot="select-popup"><button role="option">Choice</button></div>',
    );
    const choice = popup.querySelector("button")!;
    choice.focus();
    expect(fixture.controller.move(1)).toBe(false);
    expect(document.activeElement).toBe(choice);
  });

  it("keeps moving while a non-modal notification or an unfocused hover popup is visible", () => {
    const fixture = setup();
    const composer = fixture.area("composer", 2);
    const panel = fixture.area("panel", 4);
    fixture.append(
      '<div data-slot="toast-viewport"><div role="dialog" aria-modal="false" tabindex="0">Update available</div></div>',
    );
    fixture.append('<div data-slot="popover-popup">New split terminal</div>');
    composer.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(panel.button);
  });

  it("brings a restored control back into view inside its own list", () => {
    const fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const list = document.createElement("div");
    list.style.cssText = "height: 50px; overflow-y: auto";
    const spacer = document.createElement("div");
    spacer.style.height = "400px";
    const row = document.createElement("button");
    row.textContent = "Last thread";
    list.append(spacer, row);
    sidebar.element.append(list);
    const composer = fixture.area("composer", 2);
    row.focus();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    list.scrollTop = 0;
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(row);
    expect(list.scrollTop).toBeGreaterThan(0);
  });

  it("does not scroll the conversation to an old control", () => {
    const fixture = setup();
    const conversation = fixture.area("conversation", 1);
    const timeline = document.createElement("div");
    timeline.style.cssText = "height: 50px; overflow-y: auto";
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    timeline.append(copy, Object.assign(document.createElement("div"), { style: "height: 400px" }));
    conversation.element.append(timeline);
    const composer = fixture.area("composer", 2);
    copy.focus();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    // Live follow moved the timeline to the newest output.
    timeline.scrollTop = 300;
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(conversation.element);
    expect(timeline.scrollTop).toBe(300);
  });

  it("keeps keyboard scrolling in the list after a click on an area's text", async () => {
    const fixture = setup();
    const conversation = fixture.area("conversation", 1);
    const composer = fixture.area("composer", 2);
    const timeline = document.createElement("div");
    timeline.style.cssText = "height: 100px; overflow-y: auto";
    const text = document.createElement("p");
    text.textContent = "Message text";
    timeline.append(
      text,
      Object.assign(document.createElement("div"), { style: "height: 2000px" }),
    );
    conversation.element.append(timeline);
    // F6 focuses the conversation itself, then lets it go once focus leaves.
    composer.button.focus();
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(conversation.element);
    composer.button.focus();
    expect(conversation.element.hasAttribute("tabindex")).toBe(false);

    await userEvent.click(text);
    expect(document.activeElement).not.toBe(conversation.element);
    await userEvent.keyboard("{PageDown}");
    await vi.waitFor(() => expect(timeline.scrollTop).toBeGreaterThan(0));
  });

  it("starts from the panel when a forwarded key names it", () => {
    const fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const composer = fixture.area("composer", 2);
    fixture.area("panel", 4);
    // The renderer still reports the composer, but a preview guest held the keyboard.
    composer.button.focus();
    fixture.controller.move(1, "panel");
    expect(document.activeElement).toBe(sidebar.button);
  });
});
