import { describe, expect, it } from "vitest";

import { selectRuntimePtyAdapter } from "./serverLayers.ts";

describe("selectRuntimePtyAdapter", () => {
  it("always selects NodePTY on Windows, including under Bun", () => {
    expect(selectRuntimePtyAdapter("win32", true)).toBe("node");
    expect(selectRuntimePtyAdapter("win32", false)).toBe("node");
  });

  it("uses BunPTY only for Bun on POSIX", () => {
    expect(selectRuntimePtyAdapter("darwin", true)).toBe("bun");
    expect(selectRuntimePtyAdapter("linux", false)).toBe("node");
  });
});
