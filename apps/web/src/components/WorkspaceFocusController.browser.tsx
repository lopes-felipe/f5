import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { workspaceAreaProps } from "~/lib/workspaceFocus";
import { WorkspaceFocusController } from "./WorkspaceFocusController";

const f6 = (shiftKey: boolean) => ({
  key: "f6",
  metaKey: false,
  ctrlKey: false,
  shiftKey,
  altKey: false,
  modKey: false,
});
vi.mock("~/keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/keybindings")>()),
  useServerKeybindings: () => [
    { command: "workspace.focusNext", shortcut: f6(false) },
    { command: "workspace.focusPrevious", shortcut: f6(true) },
  ],
}));

let menuActionListener: ((action: string) => void) | undefined;

afterEach(() => {
  menuActionListener = undefined;
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

function Areas() {
  return (
    <>
      <nav {...workspaceAreaProps("sidebar", 0, "Threads")}>
        <button type="button">Thread</button>
      </nav>
      <section {...workspaceAreaProps("composer", 2, "Message input")}>
        <textarea aria-label="Message" />
      </section>
      <aside {...workspaceAreaProps("panel", 4, "Workspace panel")}>
        <button type="button">Diff tab</button>
      </aside>
    </>
  );
}

const press = (shiftKey = false) => {
  const event = new KeyboardEvent("keydown", {
    key: "F6",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
};

it("moves between areas on F6 and Shift+F6, and consumes the key inside a dialog", async () => {
  const screen = await render(
    <>
      <WorkspaceFocusController />
      <Areas />
    </>,
  );
  const dialog = document.createElement("div");
  try {
    const thread = screen.container.querySelector("button")!;
    thread.focus();
    expect(press().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.container.querySelector("textarea"));
    press(true);
    expect(document.activeElement).toBe(thread);

    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.tabIndex = -1;
    dialog.textContent = "Confirm";
    document.body.append(dialog);
    dialog.focus();
    expect(press().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  } finally {
    dialog.remove();
    await screen.unmount();
  }
});

it("moves on from the panel when a focused preview forwards F6", async () => {
  (window as { desktopBridge?: unknown }).desktopBridge = {
    onMenuAction: (listener: (action: string) => void) => {
      menuActionListener = listener;
      return () => {
        menuActionListener = undefined;
      };
    },
  };
  const screen = await render(
    <>
      <WorkspaceFocusController />
      <Areas />
    </>,
  );
  try {
    // The renderer still reports the composer, but the preview guest held the keyboard.
    screen.container.querySelector("textarea")!.focus();
    menuActionListener?.("workspace.focusNext");
    expect(document.activeElement).toBe(screen.container.querySelector("nav button"));
    menuActionListener?.("workspace.focusPrevious");
    expect(document.activeElement).toBe(screen.container.querySelector("textarea"));
  } finally {
    await screen.unmount();
  }
  expect(menuActionListener).toBeUndefined();
});
