import { describe, expect, it } from "vitest";

import { tightestQuotaWindow } from "./TightestLimitCallout";

const now = Date.parse("2026-11-05T10:00:00.000Z");
const window = (windowKey: string, usedPercent: number | null, resetsAt: string | null) => ({
  windowKey,
  label: windowKey,
  usedPercent,
  resetsAt,
});

describe("tightestQuotaWindow", () => {
  it("picks the live window with the most used", () => {
    expect(
      tightestQuotaWindow(
        [
          window("five_hour", 14, "2026-11-05T14:00:00.000Z"),
          window("seven_day", 91, "2026-11-06T05:00:00.000Z"),
        ],
        now,
      )?.windowKey,
    ).toBe("seven_day");
  });

  it("ignores a window whose reset has already passed", () => {
    expect(
      tightestQuotaWindow(
        [
          window("five_hour", 100, "2026-11-05T09:00:00.000Z"),
          window("seven_day", 40, "2026-11-06T05:00:00.000Z"),
          window("seven_day_opus", 10, null),
        ],
        now,
      )?.windowKey,
    ).toBe("seven_day");
  });

  it("needs two live windows with known usage", () => {
    expect(
      tightestQuotaWindow(
        [window("five_hour", null, null), window("seven_day", 40, "2026-11-06T05:00:00.000Z")],
        now,
      ),
    ).toBeNull();
    expect(
      tightestQuotaWindow(
        [
          window("five_hour", 100, "2026-11-05T09:00:00.000Z"),
          window("seven_day", 40, "2026-11-06T05:00:00.000Z"),
        ],
        now,
      ),
    ).toBeNull();
  });
});
