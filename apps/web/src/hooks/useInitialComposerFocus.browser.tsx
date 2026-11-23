import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useInitialComposerFocus } from "./useInitialComposerFocus";

function Harness(props: { threadId?: string; terminalOpen?: boolean; focus: () => void }) {
  useInitialComposerFocus(props.threadId, props.terminalOpen ?? false, props.focus);
  return (
    <div contentEditable suppressContentEditableWarning data-testid="draft">
      Before selected After
    </div>
  );
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

afterEach(() => {
  useCommandPaletteStore.getState().setOpen(false);
  window.getSelection()?.removeAllRanges();
});

describe("initial composer focus", () => {
  it("offers focus when a thread loads into an idle document", async () => {
    const focus = vi.fn();
    const screen = await render(<Harness focus={focus} />);
    await screen.rerender(<Harness threadId="thread" focus={focus} />);
    await nextFrame();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not offer focus while a terminal is open", async () => {
    const focus = vi.fn();
    const screen = await render(<Harness focus={focus} />);
    await screen.rerender(<Harness threadId="thread" terminalOpen focus={focus} />);
    await nextFrame();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each([
    { start: 6, end: 6 },
    { start: 7, end: 15 },
    { start: 15, end: 7 },
  ])(
    "preserves an editor selection made before thread hydration ($start,$end)",
    async ({ start, end }) => {
      const focus = vi.fn();
      const screen = await render(<Harness focus={focus} />);
      const editor = screen.container.querySelector<HTMLElement>("[contenteditable]")!;
      editor.focus();
      const selection = window.getSelection()!;
      selection.setBaseAndExtent(editor.firstChild!, start, editor.firstChild!, end);
      await screen.rerender(<Harness threadId="thread" focus={focus} />);
      await nextFrame();
      expect(focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(editor);
      expect(selection.anchorOffset).toBe(start);
      expect(selection.focusOffset).toBe(end);
    },
  );

  it("does not take focus from add-project search after thread hydration", async () => {
    const focus = vi.fn();
    const screen = await render(<Harness focus={focus} />);
    const input = document.createElement("input");
    input.placeholder = "Enter path";
    document.body.append(input);
    try {
      input.focus();
      await screen.rerender(<Harness threadId="thread" focus={focus} />);
      await nextFrame();
      expect(focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
    } finally {
      input.remove();
    }
  });

  it("does not race a palette that has requested opening but has not rendered", async () => {
    const focus = vi.fn();
    const screen = await render(<Harness focus={focus} />);
    useCommandPaletteStore.getState().openAddProject();
    await screen.rerender(<Harness threadId="thread" focus={focus} />);
    await nextFrame();
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not take focus while a visible dialog is waiting for its initial focus", async () => {
    const focus = vi.fn();
    const screen = await render(<Harness focus={focus} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.textContent = "Dialog";
    document.body.append(dialog);
    try {
      await screen.rerender(<Harness threadId="thread" focus={focus} />);
      await nextFrame();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it("ignores a closed dialog when offering initial focus", async () => {
    const focus = vi.fn();
    const screen = await render(<Harness focus={focus} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "closed");
    dialog.textContent = "Closed dialog";
    document.body.append(dialog);
    try {
      await screen.rerender(<Harness threadId="thread" focus={focus} />);
      await nextFrame();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      dialog.remove();
    }
  });

  it("does not disturb text selected outside an input", async () => {
    const focus = vi.fn();
    const screen = await render(<Harness focus={focus} />);
    const message = document.createElement("p");
    message.textContent = "Selected response";
    document.body.append(message);
    try {
      const selection = window.getSelection()!;
      selection.selectAllChildren(message);
      await screen.rerender(<Harness threadId="thread" focus={focus} />);
      await nextFrame();
      expect(focus).not.toHaveBeenCalled();
      expect(selection.toString()).toBe("Selected response");
    } finally {
      message.remove();
    }
  });
});
