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
});
