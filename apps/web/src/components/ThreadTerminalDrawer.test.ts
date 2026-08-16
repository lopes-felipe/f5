import { describe, expect, it, vi } from "vitest";

import {
  TERMINAL_SELECTION_CONTEXT_MENU_ITEMS,
  applyTerminalFontAppearance,
  resolveTerminalSelectionContextMenuAction,
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./ThreadTerminalDrawer";

describe("terminal font appearance", () => {
  it("updates xterm options and refits without recreating the terminal", () => {
    const terminal = { options: { fontFamily: "old", fontSize: 10 } };
    const fitAddon = { fit: vi.fn() };

    applyTerminalFontAppearance(terminal, fitAddon, {
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 15,
    });

    expect(terminal.options).toEqual({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 15,
    });
    expect(fitAddon.fit).toHaveBeenCalledOnce();
  });
});

describe("terminal selection context menu", () => {
  it("offers copy, copy-and-add, and add-only actions", () => {
    expect(TERMINAL_SELECTION_CONTEXT_MENU_ITEMS).toEqual([
      { id: "copy", label: "Copy" },
      { id: "copy-and-add-to-chat", label: "Copy and add to chat" },
      { id: "add-to-chat", label: "Add to chat" },
    ]);
    expect(resolveTerminalSelectionContextMenuAction("copy")).toEqual({
      copy: true,
      addToChat: false,
    });
    expect(resolveTerminalSelectionContextMenuAction("copy-and-add-to-chat")).toEqual({
      copy: true,
      addToChat: true,
    });
    expect(resolveTerminalSelectionContextMenuAction("add-to-chat")).toEqual({
      copy: false,
      addToChat: true,
    });
    expect(resolveTerminalSelectionContextMenuAction(null)).toBeNull();
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });
});
