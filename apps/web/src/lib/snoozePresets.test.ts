import { describe, expect, it } from "vitest";

import {
  DEFAULT_SNOOZE_PRESETS,
  MAX_SNOOZE_PRESETS,
  defaultSnoozeUntil,
  normalizeSnoozePresets,
  pickSnoozePreset,
  resolveSnoozePreset,
  resolveSnoozePresets,
  type SnoozePresetSetting,
} from "./snoozePresets";

// Local-time dates, so day and hour math holds in any test time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const time = (date: Date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const formatTime = time;

describe("resolveSnoozePreset", () => {
  // 2026-10-28 is a Wednesday.
  const wednesdayMorning = at(28, 10, 30);

  it("keeps F5's original three choices by default", () => {
    expect(
      resolveSnoozePresets(DEFAULT_SNOOZE_PRESETS, wednesdayMorning, formatTime).map(
        ({ label, whenLabel, snoozedUntil }) => [label, whenLabel, new Date(snoozedUntil)],
      ),
    ).toEqual([
      ["In 3 hours", "13:30", at(28, 13, 30)],
      ["Tomorrow", "09:00", at(29, 9)],
      ["Next week", expect.stringMatching(/ 09:00$/), at(4 + 31, 9)],
    ]);
  });

  it("names weekdays by their actual gap and drops a passed time today", () => {
    const friday: SnoozePresetSetting = { kind: "at", day: "friday", time: "18:00" };
    const thursday: SnoozePresetSetting = { kind: "at", day: "thursday", time: "08:00" };
    const wednesday: SnoozePresetSetting = { kind: "at", day: "wednesday", time: "09:00" };
    expect(resolveSnoozePreset(friday, wednesdayMorning, formatTime)?.label).toBe("Friday");
    expect(resolveSnoozePreset(thursday, wednesdayMorning, formatTime)?.label).toBe("Tomorrow");
    expect(resolveSnoozePreset(wednesday, wednesdayMorning, formatTime)?.label).toBe(
      "Next Wednesday",
    );
    expect(
      resolveSnoozePreset({ kind: "at", day: "today", time: "09:00" }, wednesdayMorning),
    ).toBeNull();
    expect(
      resolveSnoozePreset({ kind: "at", day: "today", time: "18:00" }, wednesdayMorning)?.label,
    ).toBe("This evening");
  });

  it("lists options soonest first, one per wake minute", () => {
    const presets: SnoozePresetSetting[] = [
      { kind: "at", day: "tomorrow", time: "09:00" },
      { kind: "after", minutes: 90 },
      { kind: "at", day: "today", time: "12:30" },
      { kind: "after", minutes: 60 * 24 },
      // Same minute as the 24-hour option above, which comes first in settings.
      { kind: "at", day: "tomorrow", time: "10:30" },
    ];
    expect(
      resolveSnoozePresets(presets, wednesdayMorning, formatTime).map((preset) => preset.id),
    ).toEqual(["after:90", "at:today:12:30", "at:tomorrow:09:00", "after:1440"]);
  });
});

describe("pickSnoozePreset", () => {
  const presets: SnoozePresetSetting[] = [
    { kind: "after", minutes: 60 },
    { kind: "at", day: "tomorrow", time: "09:00" },
  ];

  it("starts a duration at selection and keeps a set time's shown day", () => {
    const opened = at(28, 23, 59);
    const shown = resolveSnoozePresets(presets, opened);
    const picked = at(29, 0, 1);
    expect(
      new Date(pickSnoozePreset({ shown, id: "after:60", presets, now: picked })!.snoozedUntil),
    ).toEqual(at(29, 1, 1));
    // Still Thursday 9:00, not Friday.
    expect(
      new Date(
        pickSnoozePreset({ shown, id: "at:tomorrow:09:00", presets, now: picked })!.snoozedUntil,
      ),
    ).toEqual(at(29, 9));
  });

  it("refuses a shown time that has passed", () => {
    const shown = resolveSnoozePresets(presets, at(28, 8));
    expect(
      pickSnoozePreset({ shown, id: "at:tomorrow:09:00", presets, now: at(29, 10) }),
    ).toBeUndefined();
  });

  it("keeps the shown wake of an option removed while its menu was open", () => {
    const shown = resolveSnoozePresets(presets, at(28, 8));
    // The menu showed this choice, so it still means what it said.
    expect(
      new Date(
        pickSnoozePreset({ shown, id: "at:tomorrow:09:00", presets: [], now: at(28, 9) })!
          .snoozedUntil,
      ),
    ).toEqual(at(29, 9));
    expect(
      new Date(
        pickSnoozePreset({ shown, id: "after:60", presets: [], now: at(28, 8) })!.snoozedUntil,
      ),
    ).toEqual(at(28, 9));
    expect(pickSnoozePreset({ shown, id: "after:5", presets, now: at(28, 8) })).toBeUndefined();
  });
});

describe("snooze preset settings", () => {
  it("keeps valid stored options and falls back to the defaults otherwise", () => {
    expect(normalizeSnoozePresets(undefined)).toBe(DEFAULT_SNOOZE_PRESETS);
    expect(
      normalizeSnoozePresets([
        { kind: "after", minutes: 30 },
        { kind: "after", minutes: 0 },
        { kind: "at", day: "someday", time: "09:00" },
        { kind: "at", day: "friday", time: "25:00" },
      ]),
    ).toEqual([{ kind: "after", minutes: 30 }]);
    expect(
      normalizeSnoozePresets(
        Array.from({ length: 12 }, (_, index) => ({ kind: "after", minutes: index + 1 })),
      ),
    ).toHaveLength(MAX_SNOOZE_PRESETS);
  });

  it("starts dialogs at the soonest option, or 3 hours without one", () => {
    const now = at(28, 10);
    expect(new Date(defaultSnoozeUntil([{ kind: "after", minutes: 30 }], now))).toEqual(
      at(28, 10, 30),
    );
    expect(new Date(defaultSnoozeUntil([], now))).toEqual(at(28, 13));
  });
});
