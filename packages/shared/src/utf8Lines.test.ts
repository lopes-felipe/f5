import { describe, expect, it } from "vitest";
import { Utf8LineOverflowError, Utf8Lines } from "./utf8Lines";

describe("UTF-8 line framing", () => {
  it("preserves every byte partition, empty lines and final unterminated output", () => {
    const bytes = new TextEncoder().encode('🙂\r\n\n{"text":"résumé中"}');
    for (let width = 1; width <= bytes.length; width++) {
      const framer = new Utf8Lines();
      const actual: string[] = [];
      for (let index = 0; index < bytes.length; index += width)
        actual.push(...framer.push(bytes.subarray(index, index + width)));
      actual.push(...framer.finish());
      expect(actual).toEqual(["🙂", "", '{"text":"résumé中"}']);
      expect(framer.finish()).toEqual([]);
    }
  });
  it("accepts large Codex frames while bounded transports enforce their own policy", () => {
    const huge = "x".repeat(17 * 1024 * 1024);
    expect(new Utf8Lines().push(huge + "\n")).toEqual([huge]);
    expect(() => new Utf8Lines(8).push("🙂🙂x")).toThrow("limit");
    expect(() => new Utf8Lines(8).push("🙂🙂\n")).not.toThrow();
    expect(() => new Utf8Lines(8).push("é".repeat(4) + "\n")).not.toThrow();
    expect(() => new Utf8Lines(8).push("中中中\n")).toThrow("limit");
    const stderr = new Utf8Lines(8, "truncate");
    expect(stderr.push("🙂🙂x\nnext\n")).toEqual(["🙂🙂 [truncated]", "next"]);
  });
  it("reports the lines completed before an oversized line in the same chunk", () => {
    let caught: unknown;
    try {
      new Utf8Lines(8).push("ok\nnext\n" + "x".repeat(9));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Utf8LineOverflowError);
    expect((caught as Utf8LineOverflowError).lines).toEqual(["ok", "next"]);
  });
});
