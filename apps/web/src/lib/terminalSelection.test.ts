import { describe, expect, it, vi } from "vitest";
import { createTerminalOutputWriter, currentTerminalContextSelection } from "./terminalSelection";

function harness() {
  let text = "selected";
  let changed = () => {};
  const callbacks: Array<() => void> = [];
  const terminal = {
    cols: 80,
    element: undefined,
    getSelectionPosition: vi.fn(() => ({ start: { x: 0, y: 0 }, end: { x: 8, y: 0 } })),
    getSelection: vi.fn(() => text),
    clearSelection: vi.fn(),
    write: vi.fn((_data: string | Uint8Array, callback?: () => void) => {
      if (callback) callbacks.push(callback);
    }),
    onSelectionChange: vi.fn((listener: () => void) => {
      changed = listener;
      return { dispose: vi.fn() };
    }),
  };
  const writer = createTerminalOutputWriter(terminal);
  return {
    terminal,
    writer,
    parsed(value = text) {
      text = value;
      callbacks.shift()!();
    },
    changeSelection(value: string) {
      text = value;
      changed();
    },
  };
}

describe("terminal output selection", () => {
  it("compares after parsing, retaining unchanged redraws and clearing changed text", () => {
    const h = harness();
    h.writer.write("\r\x1b[2Kselected");
    h.writer.write("\r\x1b[2Kchanged");
    expect(h.terminal.write).toHaveBeenCalledTimes(2);
    h.parsed();
    expect(h.terminal.clearSelection).not.toHaveBeenCalled();
    expect(h.terminal.write).toHaveBeenCalledTimes(2);
    h.parsed("changed");
    expect(h.terminal.clearSelection).toHaveBeenCalledOnce();
  });

  it("bounds formatting work to 3,000 cells", () => {
    const h = harness();
    h.terminal.cols = 100;
    h.terminal.getSelectionPosition.mockReturnValue({
      start: { x: 0, y: 0 },
      end: { x: 8, y: 29 },
    });
    h.writer.write("redraw");
    h.parsed();
    expect(h.terminal.getSelection).toHaveBeenCalledTimes(2);
    expect(h.terminal.clearSelection).not.toHaveBeenCalled();
    h.terminal.getSelection.mockClear();
    h.terminal.getSelectionPosition.mockReturnValue({
      start: { x: 0, y: 0 },
      end: { x: 8, y: 30 },
    });
    h.writer.write("redraw");
    h.parsed();
    expect(h.terminal.getSelection).not.toHaveBeenCalled();
    expect(h.terminal.clearSelection).not.toHaveBeenCalled();
  });

  it("does not clear a newer gesture while parsing output", () => {
    const h = harness();
    h.writer.write("output");
    h.changeSelection("new selection");
    h.parsed();
    expect(h.terminal.clearSelection).not.toHaveBeenCalled();
  });

  it("submits all output to xterm immediately and ignores callbacks after disposal", () => {
    const h = harness();
    h.writer.write("");
    expect(h.terminal.getSelection).not.toHaveBeenCalled();
    h.writer.write("first");
    h.writer.write("second");
    h.writer.dispose();
    h.parsed("changed");
    h.writer.write("disposed");
    expect(h.terminal.write).toHaveBeenCalledTimes(2);
    expect(h.terminal.clearSelection).not.toHaveBeenCalled();
  });

  it("takes current line numbers only when the menu's text is still selected", () => {
    const original = { text: "selected", lineStart: 10, lineEnd: 11 };
    const current = { ...original, lineStart: 8, lineEnd: 9 };
    expect(currentTerminalContextSelection(original, current)).toBe(current);
    expect(currentTerminalContextSelection(original, { ...current, text: "changed" })).toBeNull();
    expect(currentTerminalContextSelection(original, null)).toBeNull();
  });
});
