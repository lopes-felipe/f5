import { Schema } from "effect";

export const MAX_SNOOZE_PRESETS = 8;
export const MAX_SNOOZE_PRESET_MINUTES = 30 * 24 * 60;

export const SNOOZE_PRESET_DAYS = [
  "today",
  "tomorrow",
  "next-week",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export const SnoozePresetDaySchema = Schema.Literals(SNOOZE_PRESET_DAYS);
export type SnoozePresetDay = typeof SnoozePresetDaySchema.Type;

/**
 * `after` wakes a fixed time from now. `at` wakes at a local time: `next-week` is the same
 * weekday next week, and a named weekday is its next occurrence after today.
 */
export const SnoozePresetSettingSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("after"),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SNOOZE_PRESET_MINUTES })),
  }),
  Schema.Struct({
    kind: Schema.Literal("at"),
    day: SnoozePresetDaySchema,
    time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  }),
]);
export type SnoozePresetSetting = typeof SnoozePresetSettingSchema.Type;

/** F5's original three choices: 3 hours, tomorrow morning and a week from today. */
export const DEFAULT_SNOOZE_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: "after", minutes: 180 },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "next-week", time: "09:00" },
];

const isSnoozePresetSetting = Schema.is(SnoozePresetSettingSchema);

/** Keeps the valid stored presets, up to the limit; anything else falls back to the defaults. */
export function normalizeSnoozePresets(value: unknown): ReadonlyArray<SnoozePresetSetting> {
  if (!Array.isArray(value)) return DEFAULT_SNOOZE_PRESETS;
  return value.filter(isSnoozePresetSetting).slice(0, MAX_SNOOZE_PRESETS);
}

export interface SnoozePreset {
  readonly id: string;
  /** "In 3 hours", "Tomorrow", "Next week", "Friday". */
  readonly label: string;
  /** The wake time, with its weekday when the label does not name the day. */
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

export function defaultSnoozeTimeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "3 hours", "90 minutes", "2 days": the largest unit that divides evenly. */
export function formatSnoozeDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return pluralize(minutes / (24 * 60), "day");
  if (minutes % 60 === 0) return pluralize(minutes / 60, "hour");
  return pluralize(minutes, "minute");
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function daysAheadFor(day: SnoozePresetDay, now: Date): number {
  if (day === "today") return 0;
  if (day === "tomorrow") return 1;
  if (day === "next-week") return 7;
  return (WEEKDAY_INDEX[day] - now.getDay() + 7) % 7 || 7;
}

/** Labels follow the actual day gap, so a Monday option on a Sunday reads "Tomorrow". */
function presetLabel(setting: SnoozePresetSetting, daysAhead: number): string {
  if (setting.kind === "after") return `In ${formatSnoozeDuration(setting.minutes)}`;
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  }
  if (daysAhead === 1) return "Tomorrow";
  if (setting.day === "next-week") return "Next week";
  return daysAhead === 7 ? `Next ${capitalize(setting.day)}` : capitalize(setting.day);
}

export function snoozePresetId(setting: SnoozePresetSetting): string {
  return setting.kind === "after"
    ? `after:${setting.minutes}`
    : `at:${setting.day}:${setting.time}`;
}

/** Null for a "today" option whose time has passed; it returns tomorrow. */
export function resolveSnoozePreset(
  setting: SnoozePresetSetting,
  now: Date = new Date(),
  formatTime: (date: Date) => string = defaultSnoozeTimeLabel,
): SnoozePreset | null {
  let wake: Date;
  let daysAhead = 0;
  if (setting.kind === "after") {
    wake = new Date(now.getTime() + setting.minutes * 60_000);
  } else {
    daysAhead = daysAheadFor(setting.day, now);
    // Calendar-day advance, so a daylight-saving change keeps the wall-clock time.
    wake = new Date(now);
    wake.setDate(wake.getDate() + daysAhead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = presetLabel(setting, daysAhead);
  // Durations and "Next week" don't name the wake day, so a wake on another day shows it.
  const labelNamesDay = setting.kind === "at" && label !== "Next week";
  const time = formatTime(wake);
  return {
    id: snoozePresetId(setting),
    label,
    whenLabel:
      labelNamesDay || wake.toDateString() === now.toDateString()
        ? time
        : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    snoozedUntil: wake.toISOString(),
  };
}

/** The snooze menu: soonest first, one row per wake minute. */
export function resolveSnoozePresets(
  presets: ReadonlyArray<SnoozePresetSetting>,
  now: Date = new Date(),
  formatTime?: (date: Date) => string,
): ReadonlyArray<SnoozePreset> {
  // By minute, so a duration (which keeps the clock's seconds) and a set time in the same
  // minute tie, and the stable sort keeps whichever comes first in settings.
  const wakeMinute = (preset: SnoozePreset) => Math.floor(Date.parse(preset.snoozedUntil) / 60_000);
  const seen = new Set<number>();
  return presets
    .flatMap((setting) => resolveSnoozePreset(setting, now, formatTime) ?? [])
    .toSorted((a, b) => wakeMinute(a) - wakeMinute(b))
    .filter((preset) => {
      if (seen.has(wakeMinute(preset))) return false;
      seen.add(wakeMinute(preset));
      return true;
    });
}

/** A dialog's starting snooze time: the soonest option, or 3 hours when none applies. */
export function defaultSnoozeUntil(
  presets: ReadonlyArray<SnoozePresetSetting>,
  now: Date = new Date(),
): string {
  return (
    resolveSnoozePresets(presets, now)[0]?.snoozedUntil ??
    new Date(now.getTime() + 3 * 60 * 60 * 1_000).toISOString()
  );
}

/**
 * A menu choice as picked. A duration re-resolves from its setting so it starts at selection.
 * A set time keeps the wake the menu showed, so a menu opened before midnight still means the
 * day it showed. Undefined once that time has passed.
 */
export function pickSnoozePreset(input: {
  readonly shown: ReadonlyArray<SnoozePreset>;
  readonly id: string;
  readonly presets: ReadonlyArray<SnoozePresetSetting>;
  readonly now?: Date;
}): SnoozePreset | undefined {
  const now = input.now ?? new Date();
  const original = input.shown.find((preset) => preset.id === input.id);
  const ahead =
    original && Date.parse(original.snoozedUntil) > now.getTime() ? original : undefined;
  const setting = input.presets.find(
    (candidate) => candidate.kind === "after" && snoozePresetId(candidate) === input.id,
  );
  return (setting && resolveSnoozePreset(setting, now)) || ahead;
}
