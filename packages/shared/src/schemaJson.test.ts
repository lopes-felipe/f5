import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { fromLenientJson } from "./schemaJson";

describe("lenient JSON strings", () => {
  const decode = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));
  it("preserves commas and escaped quotes inside strings while removing comments and trailing commas", () => {
    expect(
      decode(String.raw`{
      // configuration comment
      "note": "a,]",
      "escaped": "say \"x,}\"",
      "values": ["x,}", 1,],
    }`),
    ).toEqual({
      note: "a,]",
      escaped: 'say "x,}"',
      values: ["x,}", 1],
    });
    expect(() => decode('{"enabled": true,,}')).toThrow();
  });

  it("keeps a URL inside a block comment from swallowing the rest of the line", () => {
    expect(
      decode(`{
        "enabled": /* See "https://example.com/config" // still in the block */ true,
        "values": [1, 2,],
      }`),
    ).toEqual({ enabled: true, values: [1, 2] });
    expect(() => decode("[1/* https://example.com */2]")).toThrow();
    expect(decode('"1/* https://example.com */2"')).toBe("1/* https://example.com */2");
  });
});
