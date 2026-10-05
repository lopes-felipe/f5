import { expect, it } from "vitest";
import { composerSendShortcutLabel, shouldSubmitComposer } from "./sendShortcut";

it.each([
  ["enter", "one", false, true],
  ["enter", "one\ntwo", false, true],
  ["mod-enter", "one", false, false],
  ["mod-enter", "one", true, true],
  ["mod-enter-multiline", "one", false, true],
  ["mod-enter-multiline", "one\ntwo", false, false],
  ["mod-enter-multiline", "one\ntwo", true, true],
] as const)("%s with %j and modifier=%s submits=%s", (shortcut, prompt, modifierKey, expected) => {
  expect(
    shouldSubmitComposer({ shortcut, prompt, modifierKey, shiftKey: false, altKey: false }),
  ).toBe(expected);
  expect(
    shouldSubmitComposer({ shortcut, prompt, modifierKey, shiftKey: true, altKey: false }),
  ).toBe(false);
});

it.each([
  ["enter", "one\ntwo", true, "Enter"],
  ["mod-enter", "one", true, "⌘Enter"],
  ["mod-enter", "one", false, "Ctrl+Enter"],
  ["mod-enter-multiline", "one", true, "Enter"],
  ["mod-enter-multiline", "one\ntwo", false, "Ctrl+Enter"],
] as const)(
  "labels the %s send shortcut for %j (mac %s) as %s",
  (shortcut, prompt, isMac, label) => {
    expect(composerSendShortcutLabel(shortcut, prompt, isMac)).toBe(label);
  },
);
