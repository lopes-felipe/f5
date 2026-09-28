import { describe, expect, it } from "vitest";
import { terminalClipboardAction } from "./terminalClipboard";
const key = {
  type: "keydown",
  key: "c",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};
describe("terminal clipboard keys", () => {
  it("preserves shell interrupts without a selection", () => {
    expect(terminalClipboardAction(key, false)).toBeNull();
    expect(terminalClipboardAction(key, true)).toBe("copy");
    expect(terminalClipboardAction({ ...key, type: "keyup" }, true)).toBeNull();
  });
  it("supports Insert shortcuts without intercepting other modifiers", () => {
    expect(terminalClipboardAction({ ...key, key: "Insert" }, true)).toBe("copy");
    expect(
      terminalClipboardAction({ ...key, key: "Insert", ctrlKey: false, shiftKey: true }, false),
    ).toBe("paste");
    expect(terminalClipboardAction({ ...key, altKey: true }, true)).toBeNull();
    expect(terminalClipboardAction({ ...key, metaKey: true }, true)).toBeNull();
  });
});
