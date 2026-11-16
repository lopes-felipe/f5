import { describe, expect, it } from "vitest";

import { truncateMessagePreview } from "./turnAssistantMessage";

describe("truncateMessagePreview", () => {
  it("trims, truncates by code point and marks the cut", () => {
    expect(truncateMessagePreview("  short  ", 10)).toBe("short");
    expect(truncateMessagePreview("abcdef", 4)).toBe("abc…");
    expect(truncateMessagePreview("ab   cdef", 4)).toBe("ab…");
    expect(truncateMessagePreview("😀😀😀😀", 3)).toBe("😀😀…");
  });
});
