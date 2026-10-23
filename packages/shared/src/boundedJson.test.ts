import { describe, expect, it } from "vitest";
import { assertJsonSourceWithinLimits, stringifyWithinBytes } from "./boundedJson";
describe("bounded JSON serialization", () => {
  it("checks JSON structure before parsing while ignoring escaped punctuation in strings", () => {
    expect(() =>
      assertJsonSourceWithinLimits(JSON.stringify({ text: '\\"{[,:,:'.repeat(1000) }), 2, 20),
    ).not.toThrow();
    expect(() => assertJsonSourceWithinLimits("[".repeat(65) + "0" + "]".repeat(65))).toThrow(
      /structure limit/,
    );
    expect(() => assertJsonSourceWithinLimits("[" + "0,".repeat(100001) + "0]")).toThrow(
      /structure limit/,
    );
    expect(() => assertJsonSourceWithinLimits('{"a":[1,2]}', 2, 20)).not.toThrow();
  });
  it("matches JSON serialization and exact UTF-8 byte boundaries", () => {
    for (const value of [
      { text: '界\n"', missing: undefined },
      [1, null, true, undefined],
      "hello",
      1e100,
    ]) {
      const expected = JSON.stringify(value),
        bytes = new TextEncoder().encode(expected).byteLength;
      expect(stringifyWithinBytes(value, bytes)).toBe(expected);
      expect(stringifyWithinBytes(value, bytes - 1)).toBeUndefined();
    }
  });
  it("rejects cycles, excess depth, broad arrays, functions and custom serialization", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = null;
    for (let index = 0; index < 34; index++) deep = { child: deep };
    for (const value of [
      cyclic,
      deep,
      Array(10001).fill(0),
      { toJSON: () => "huge" },
      new Date(),
      1n,
    ])
      expect(stringifyWithinBytes(value, 1_000_000)).toBeUndefined();
  });
  it("accepts repeated references and rejects huge strings before serialization", () => {
    const child = { value: "state" };
    expect(stringifyWithinBytes([child, child], 100)).toBe(JSON.stringify([child, child]));
    expect(stringifyWithinBytes({ value: "x".repeat(1_000_000) }, 1024)).toBeUndefined();
  });
});
