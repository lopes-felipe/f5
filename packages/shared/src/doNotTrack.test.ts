import { describe, expect, it } from "vitest";
import { isDoNotTrackSet } from "./doNotTrack";

describe("isDoNotTrackSet", () => {
  it.each(["1", "true", "TRUE", " yes ", "on", "Y"])("treats %j as set", (value) => {
    expect(isDoNotTrackSet({ DO_NOT_TRACK: value })).toBe(true);
  });

  it.each([undefined, "", "0", "false", "no", "off", "2", "enabled"])(
    "treats %j as not set",
    (value) => {
      expect(isDoNotTrackSet(value === undefined ? {} : { DO_NOT_TRACK: value })).toBe(false);
    },
  );
});
