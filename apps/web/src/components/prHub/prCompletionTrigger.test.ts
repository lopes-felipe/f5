import { describe, expect, it } from "vitest";
import { prCompletionTrigger } from "./prCompletionTrigger";

describe("PR completion triggers", () => {
  it("finds mentions and references at the caret", () => {
    expect(prCompletionTrigger("Thanks (@al) later", 11)).toEqual({
      start: 8,
      end: 11,
      sigil: "@",
      query: "al",
    });
    expect(prCompletionTrigger("#123", 4)?.query).toBe("123");
    expect(prCompletionTrigger("see !", 5)?.sigil).toBe("!");
    expect(prCompletionTrigger("@", 1)?.query).toBe("");
  });
  it("ignores email, URL, selected text, and completed tokens", () => {
    for (const text of ["a@b", "https://a/#12", "hello #12 ", "word!123"])
      expect(prCompletionTrigger(text, text.length)).toBeNull();
    expect(prCompletionTrigger("@alice", 3, 6)).toBeNull();
  });
});
