import { describe, expect, it } from "vitest";

import { extractIcnsPng } from "./icns";
import { fakePng, icns } from "./icns.testkit";

describe("extractIcnsPng", () => {
  it("picks the smallest PNG that covers the requested size", () => {
    const file = icns([
      ["ic10", fakePng(1024)],
      ["ic07", fakePng(128)],
      ["ic11", fakePng(32)],
      ["ic08", fakePng(256)],
    ]);
    expect(extractIcnsPng(file, 96)).toEqual(fakePng(128));
  });

  it("falls back to the largest PNG and skips raw bitmap entries", () => {
    const file = icns([
      ["is32", Buffer.alloc(64, 1)],
      ["icp4", fakePng(16)],
      ["icp5", fakePng(32)],
    ]);
    expect(extractIcnsPng(file, 96)).toEqual(fakePng(32));
  });

  it("returns null for other files, truncated entries and icons without a PNG", () => {
    expect(extractIcnsPng(fakePng(128), 96)).toBeNull();
    expect(extractIcnsPng(icns([["is32", Buffer.alloc(64, 1)]]), 96)).toBeNull();
    const truncated = icns([["ic07", fakePng(128)]]);
    truncated.writeUInt32BE(0xffff, 12);
    expect(extractIcnsPng(truncated, 96)).toBeNull();
  });
});
