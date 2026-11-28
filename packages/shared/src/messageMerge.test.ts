import { expect, it } from "vitest";
import { mergeMessageText } from "./messageMerge";

it("merges text and reasoning consistently across patches and completion", () => {
  const initial = { text: "a", reasoningText: "b" };
  const next = mergeMessageText(initial, { text: "c", reasoningText: "d", streaming: true });
  expect(next).toEqual({ text: "ac", reasoningText: "bd" });
  expect(mergeMessageText(next, { text: "", reasoningText: "", streaming: false })).toEqual(next);
  expect(mergeMessageText(next, { text: "reset", replace: true, streaming: false })).toEqual({
    text: "reset",
  });
});
