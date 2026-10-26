import { describe, expect, it } from "vitest";
import {
  CRON_EXPRESSION_MAX_LENGTH,
  ScheduleError,
  describeSchedule,
  nextScheduleFires,
  normalizeCron,
  oneShotCron,
  previewCronSchedule,
  SCHEDULE_PRESETS,
} from "./cronSchedule";
const next = (cron: string, zone: string, after: string, n = 1) =>
  nextScheduleFires(cron, zone, new Date(after), n);
describe("cron schedule contract", () => {
  it.each(Object.values(SCHEDULE_PRESETS))("previews preset %s", (cron) =>
    expect(previewCronSchedule(cron, "UTC", new Date("2026-01-01Z")).nextFireTimes).toHaveLength(5),
  );
  it("normalizes whitespace and supported aliases", () => {
    expect(normalizeCron("  0  9 * * mon ")).toBe("0 9 * * MON");
    expect(normalizeCron("@hourly")).toBe(SCHEDULE_PRESETS.hourly);
  });
  it.each([
    "@reboot",
    "0 * * * * *",
    "1 0 9 1 1 * 2027",
    "0 0 L * *",
    "0 0 1W * *",
    "0 0 * * +MON",
    "0 0 ? * *",
    "2026-12-25",
    "0 0 * * MON#6",
    "0 0 * * MON#1,TUE#2",
  ])("rejects unsupported grammar %s", (cron) => expect(() => normalizeCron(cron)).toThrow());
  it.each([
    ["60 * * * *", 0],
    ["0 24 * * *", 1],
    ["0 0 0 * *", 2],
    ["0 0 * 13 *", 3],
    ["0 0 * * 8", 4],
    ["*/0 * * * *", 0],
    ["0 0 * * MON#6", 4],
    ["0 0 ? * *", 2],
    ["0 0 24 1 1 * 2027", 2],
  ])("identifies the invalid field in %s", (cron, fieldIndex) => {
    try {
      normalizeCron(cron as string);
      expect.fail("Expected invalid cron to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleError);
      expect((error as ScheduleError).fieldIndex).toBe(fieldIndex);
    }
  });
  it("bounds input length without restricting valid lists, ranges or steps", () => {
    const all = (count: number, start = 0) =>
      Array.from({ length: count }, (_, i) => start + i).join(",");
    const lists = `${all(60)} ${all(24)} ${all(31, 1)} ${all(12, 1)} ${all(7)}`;
    expect(normalizeCron(lists)).toBe(lists);
    expect(normalizeCron("*/15 9-17 * JAN-MAR MON-FRI")).toBe("*/15 9-17 * JAN-MAR MON-FRI");
    expect(normalizeCron("0 0 * * 7")).toBe("0 0 * * 7");
    expect(() => normalizeCron("*".repeat(CRON_EXPRESSION_MAX_LENGTH + 1))).toThrow(/at most 512/);
    expect(() => normalizeCron(" ".repeat(CRON_EXPRESSION_MAX_LENGTH) + "@daily")).toThrow(
      /at most 512/,
    );
  });
  it("rejects invalid timezones", () =>
    expect(() => next("* * * * *", "Mars/Olympus", "2026-01-01Z")).toThrow());
  it("handles first Monday", () =>
    expect(next("30 14 * * MON#1", "UTC", "2026-01-06Z")).toEqual(["2026-02-02T14:30:00.000Z"]));
  it("progresses strictly at minute boundaries", () =>
    expect(next("* * * * *", "UTC", "2026-01-01T00:00Z", 2)).toEqual([
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:02:00.000Z",
    ]));
  it("evaluates the selected timezone", () =>
    expect(next("0 9 * * *", "Asia/Kathmandu", "2026-01-01Z")).toEqual([
      "2026-01-01T03:15:00.000Z",
    ]));
  it("skips nonexistent spring local times", () =>
    expect(next("30 2 * * *", "America/New_York", "2026-03-08T05:00Z")).toEqual([
      "2026-03-09T06:30:00.000Z",
    ]));
  it.each(["2026-11-01T05:30Z", "2026-11-01T05:40Z", "2026-11-01T06:10Z", "2026-11-01T06:40Z"])(
    "does not duplicate a repeated hour after %s",
    (after) =>
      expect(next("30 1 * * *", "America/New_York", after)).toEqual(["2026-11-02T06:30:00.000Z"]),
  );
  it("uses first repeated occurrence", () =>
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T04:00Z")).toEqual([
      "2026-11-01T05:30:00.000Z",
    ]));
  it("does not lose later minutes in the first repeated hour", () =>
    expect(next("* 1 * * *", "America/New_York", "2026-11-01T05:45Z", 2)).toEqual([
      "2026-11-01T05:46:00.000Z",
      "2026-11-01T05:47:00.000Z",
    ]));
  it("uses OR day semantics and describes each branch", () => {
    expect(next("0 9 1 * MON", "UTC", "2026-01-01T10:00Z")).toEqual(["2026-01-05T09:00:00.000Z"]);
    expect(describeSchedule("0 9 1 * MON", "UTC")).toMatch(
      /Either .* or .*one run when both match/,
    );
  });
  it("one-shots have explicit years and exhaust", () => {
    const cron = oneShotCron("2027-01-01T15:00:00Z", "UTC", new Date("2026-01-01Z"));
    expect(cron).toBe("0 0 15 1 1 * 2027");
    expect(next(cron, "UTC", "2026-01-01Z", 5)).toEqual(["2027-01-01T15:00:00.000Z"]);
    expect(next(cron, "UTC", "2027-01-01T15:00Z")).toEqual([]);
  });
  it("rejects ambiguous one-shots", () =>
    expect(() =>
      oneShotCron("2026-11-01T05:30:00Z", "America/New_York", new Date("2026-01-01Z")),
    ).toThrow(/ambiguous/));
  it("rejects past one-shots and nonminute targets", () => {
    expect(() => oneShotCron("2026-01-01Z", "UTC", new Date("2026-02-01Z"))).toThrow();
    expect(() => oneShotCron("2027-01-01T09:00:30Z", "UTC", new Date("2026-01-01Z"))).toThrow();
  });
});
