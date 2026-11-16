import { expect, it } from "vitest";
import { shouldRunNativeAsideShortcut } from "./ChatView.logic";

const input = {
  prompt: "/aside Why?",
  sessionProvider: "codex",
  sessionInstanceId: "instance",
  selectedInstanceId: "instance",
  nativeAsideSupported: true,
};
it("admits aside only for the selected supported Codex session", () => {
  expect(shouldRunNativeAsideShortcut(input)).toBe(true);
  expect(shouldRunNativeAsideShortcut({ ...input, nativeAsideSupported: false })).toBe(false);
  expect(shouldRunNativeAsideShortcut({ ...input, selectedInstanceId: "another" })).toBe(false);
  expect(shouldRunNativeAsideShortcut({ ...input, sessionProvider: "claudeAgent" })).toBe(false);
  expect(shouldRunNativeAsideShortcut({ ...input, prompt: "/aside-other" })).toBe(false);
});
