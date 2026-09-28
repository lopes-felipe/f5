import { expect, it } from "vitest";
import { shouldSubmitComposer } from "./sendShortcut";

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
