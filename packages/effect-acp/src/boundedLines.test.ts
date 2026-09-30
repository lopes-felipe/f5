import { describe, expect, it } from "vitest";
import { BoundedLines } from "./_internal/boundedLines";

describe("provider stdout framing", () => {
  it("frames partitioned CRLF and UTF-8 text without changing content", () => {
    const input = 'auth: ok\r\n{"text":"🙂"}\n';
    for (let width = 2; width <= input.length; width++) {
      const lines = new BoundedLines();
      // Decode byte partitions before framing, as the runtime does.
      const bytes = new TextEncoder().encode(input);
      const decoder = new TextDecoder();
      const actual: string[] = [];
      for (let i = 0; i < bytes.length; i += width)
        actual.push(...lines.push(decoder.decode(bytes.slice(i, i + width), { stream: true })));
      actual.push(...lines.push(decoder.decode()));
      expect(actual).toEqual(["auth: ok", '{"text":"🙂"}']);
    }
  });
  it("rejects an oversized unterminated line across chunks", () => {
    const lines = new BoundedLines(8);
    expect(lines.push("🙂")).toEqual([]);
    expect(lines.push("🙂")).toEqual([]);
    expect(() => lines.push("x")).toThrow("limit");
  });
  it("resets the budget at each line", () => {
    expect(new BoundedLines(4).push("1234\n1234\n")).toEqual(["1234", "1234"]);
  });
});
