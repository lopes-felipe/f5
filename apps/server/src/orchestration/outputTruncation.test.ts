import { describe, expect, it } from "vitest";

import { truncateMiddleByBytes } from "./outputTruncation.ts";

const MARKER = "\n[...]\n";

describe("truncateMiddleByBytes", () => {
  it("returns the input unchanged when it fits within maxBytes", () => {
    const result = truncateMiddleByBytes("hello world", {
      maxBytes: 1024,
      headBytes: 256,
      marker: MARKER,
    });

    expect(result.truncated).toBe(false);
    expect(result.output).toBe("hello world");
  });

  it("keeps a head and a tail around the marker when over budget", () => {
    const head = "H".repeat(40);
    const tail = "T".repeat(40);
    const input = `${head}${"X".repeat(200)}${tail}`;

    const result = truncateMiddleByBytes(input, {
      maxBytes: 40,
      headBytes: 16,
      marker: MARKER,
    });

    expect(result.truncated).toBe(true);
    expect(result.output).toContain(MARKER);
    expect(result.output.startsWith("H")).toBe(true);
    expect(result.output.endsWith("T")).toBe(true);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(40);
  });

  it("never exceeds maxBytes even when headBytes is larger than maxBytes", () => {
    const input = "A".repeat(10_000);

    const result = truncateMiddleByBytes(input, {
      maxBytes: 100,
      headBytes: 10_000,
      marker: MARKER,
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(100);
  });

  it("does not emit lone UTF-8 replacement chars at cut boundaries", () => {
    // Multi-byte characters around the cut points must not be split into U+FFFD.
    const input = `${"é".repeat(200)}${"ü".repeat(200)}`;

    const result = truncateMiddleByBytes(input, {
      maxBytes: 120,
      headBytes: 48,
      marker: MARKER,
    });

    expect(result.truncated).toBe(true);
    expect(result.output).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(120);
  });

  it("degrades to head + marker when the tail budget is exhausted", () => {
    const input = "Z".repeat(500);
    const marker = "X".repeat(20);

    const result = truncateMiddleByBytes(input, {
      maxBytes: 30,
      headBytes: 30,
      marker,
    });

    expect(result.truncated).toBe(true);
    expect(result.output.startsWith("Z")).toBe(true);
    expect(result.output).toContain(marker);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(30);
  });
});
