import { expect, it } from "vitest";
import { ComputerSharedAppState } from "./ComputerSharedAppState";

it("leaves a lone writer unaffected and rejects sharing without a field press", () => {
  const state = new ComputerSharedAppState();
  state.assertTyping("app", "a", false);
  state.mutated("app", "a", false);
  state.assertTyping("app", "a", false);
  expect(() => state.assertTyping("app", "b", true)).toThrow("shared-focus");
  state.mutated("app", "b", true);
  state.assertTyping("app", "b", true);
});
it("does not hide another writer behind a later write by the original agent", () => {
  const state = new ComputerSharedAppState();
  state.mutated("app", "a", true);
  state.mutated("app", "b", false);
  state.mutated("app", "a", false);
  expect(() => state.assertTyping("app", "a", false)).toThrow("shared-focus");
  state.mutated("app", "a", true);
  state.assertTyping("app", "a", true);
});
it("drops presses on yield and owner cleanup and resets history on helper restart", () => {
  const state = new ComputerSharedAppState();
  state.mutated("app", "a", true);
  state.yielded("app");
  expect(() => state.assertTyping("app", "a", true)).toThrow("shared-focus");
  state.mutated("app", "a", true);
  state.releaseOwner("a");
  expect(() => state.assertTyping("app", "a", true)).toThrow("shared-focus");
  state.reset();
  state.assertTyping("app", "b", false);
});
