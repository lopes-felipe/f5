import { describe, expect, it } from "vitest";

import { getTimestampFormatOptions, resolveTimestampLocale } from "./timestampFormat";

describe("getTimestampFormatOptions", () => {
  it("omits hour12 when locale formatting is requested", () => {
    expect(getTimestampFormatOptions("locale", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("builds a 12-hour formatter with seconds when requested", () => {
    expect(getTimestampFormatOptions("12-hour", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  });

  it("builds a 24-hour formatter without seconds when requested", () => {
    expect(getTimestampFormatOptions("24-hour", false)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  });
});

describe("resolveTimestampLocale", () => {
  it("accepts the OS locale and safely falls back for missing or malformed values", () => {
    expect(resolveTimestampLocale(" de-DE ")).toBe("de-DE");
    expect(resolveTimestampLocale("de_DE")).toBeUndefined();
    expect(resolveTimestampLocale(null)).toBeUndefined();
    expect(resolveTimestampLocale("")).toBeUndefined();
  });
});
