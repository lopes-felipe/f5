import { describe, expect, it } from "vitest";
import { terminalClipboardAction, terminalRightClickPastes } from "./terminalClipboard";
const key = {
  type: "keydown",
  key: "c",
  code: "KeyC",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};
describe("terminal clipboard keys", () => {
  it("preserves shell interrupts without a selection", () => {
    expect(terminalClipboardAction(key, false, "Linux")).toBeNull();
    expect(terminalClipboardAction(key, true, "Linux")).toBe("copy");
    expect(terminalClipboardAction({ ...key, type: "keyup" }, true, "Linux")).toBeNull();
  });
  it("supports Insert shortcuts without intercepting other modifiers", () => {
    expect(terminalClipboardAction({ ...key, key: "Insert" }, true, "Linux")).toBe("copy");
    expect(
      terminalClipboardAction(
        { ...key, key: "Insert", ctrlKey: false, shiftKey: true },
        false,
        "Linux",
      ),
    ).toBe("paste");
    expect(terminalClipboardAction({ ...key, altKey: true }, true, "Linux")).toBeNull();
    expect(terminalClipboardAction({ ...key, metaKey: true }, true, "Linux")).toBeNull();
  });
});

it("preserves macOS Ctrl+C and disables right-click paste", () => {
  expect(terminalClipboardAction(key, true, "MacIntel")).toBeNull();
  expect(terminalRightClickPastes("MacIntel")).toBe(false);
  expect(terminalRightClickPastes("Linux x86_64")).toBe(true);
  expect(terminalRightClickPastes("Win32")).toBe(true);
});

it("copies the physical C key on non-Latin layouts without stealing modified interrupts", () => {
  const cyrillic = { ...key, key: "с" };
  expect(terminalClipboardAction(cyrillic, true, "Linux")).toBe("copy");
  expect(terminalClipboardAction(cyrillic, false, "Linux")).toBeNull();
  expect(terminalClipboardAction({ ...cyrillic, altKey: true }, true, "Linux")).toBeNull();
  expect(terminalClipboardAction({ ...cyrillic, metaKey: true }, true, "Linux")).toBeNull();
  expect(terminalClipboardAction(cyrillic, true, "MacIntel")).toBeNull();
});
