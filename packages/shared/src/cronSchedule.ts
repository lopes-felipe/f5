import { Cron } from "croner";
import cronstrue from "cronstrue";

export class ScheduleError extends Error {
  readonly code: "invalid_schedule" | "evaluation_limit";
  readonly fieldIndex: number | undefined;
  constructor(
    message: string,
    code: ScheduleError["code"] = "invalid_schedule",
    fieldIndex?: number,
  ) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
    this.fieldIndex = fieldIndex;
  }
}
/** Allows full numeric lists in every field while bounding parsing and editor input. */
export const CRON_EXPRESSION_MAX_LENGTH = 512;
export const CRON_SCHEDULE_FIELDS = [
  { label: "Minute", range: "0–59" },
  { label: "Hour", range: "0–23" },
  { label: "Day of month", range: "1–31" },
  { label: "Month", range: "1–12 or JAN–DEC" },
  { label: "Day of week", range: "0–7 or SUN–SAT (0 and 7 are Sunday)" },
] as const;
export const SCHEDULE_PRESETS = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekdays: "0 9 * * MON-FRI",
  weekly: "0 9 * * MON",
} as const;
const aliases: Record<string, string> = {
  "@hourly": SCHEDULE_PRESETS.hourly,
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * SUN",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};
export function validateTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new ScheduleError("Select a valid IANA timezone.");
  }
}
export function normalizeCron(value: string): string {
  if (value.length > CRON_EXPRESSION_MAX_LENGTH)
    throw new ScheduleError(
      `Cron expressions can have at most ${CRON_EXPRESSION_MAX_LENGTH} characters.`,
    );
  const cron =
    aliases[value.trim().toLowerCase()] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
  const fields = cron.split(" ");
  if (fields.length !== 5 && fields.length !== 7)
    throw new ScheduleError(
      "Use five fields for recurring schedules or seven fields for a one-shot schedule.",
    );
  const unsupported = fields.findIndex((field) => !/^[0-9A-Z*,/#-]+$/.test(field));
  if (unsupported !== -1)
    throw new ScheduleError(
      "Unsupported cron character. Use numbers, month/day names, *, /, -, comma or #.",
      "invalid_schedule",
      unsupported,
    );
  const recurring = fields.length === 5 ? fields : fields.slice(1, 6);
  const [minute, hour, day, month, weekday] = recurring;
  const numeric = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?(?:,(?:\*|\d+(?:-\d+)?)(?:\/\d+)?)*$/;
  const named = (s: string, names: string[]) =>
    names.reduce((v, name, i) => v.replaceAll(name, String(i + (names[0] === "JAN" ? 1 : 0))), s);
  const validFields = [
    numeric.test(minute!),
    numeric.test(hour!),
    numeric.test(day!),
    numeric.test(
      named(month!, [
        "JAN",
        "FEB",
        "MAR",
        "APR",
        "MAY",
        "JUN",
        "JUL",
        "AUG",
        "SEP",
        "OCT",
        "NOV",
        "DEC",
      ]),
    ),
    numeric.test(named(weekday!, ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"])) ||
      /^(?:[0-7]|SUN|MON|TUE|WED|THU|FRI|SAT)#[1-5]$/.test(weekday!),
  ];
  const invalidField = validFields.findIndex((valid) => !valid);
  const offset = fields.length === 7 ? 1 : 0;
  if (invalidField !== -1)
    throw new ScheduleError(
      `${CRON_SCHEDULE_FIELDS[invalidField]!.label}: use numbers, supported names, lists, ranges, steps${invalidField === 4 ? " or a single nth weekday (#1–#5)" : ""}.`,
      "invalid_schedule",
      invalidField + offset,
    );
  if (
    fields.length === 7 &&
    (fields[0] !== "0" ||
      !/^\d{4}$/.test(fields[6]!) ||
      !recurring.slice(0, 4).every((f) => /^\d+$/.test(f)) ||
      weekday !== "*")
  )
    throw new ScheduleError(
      "One-shot schedules require zero seconds, a concrete date/time, wildcard weekday and explicit year.",
    );
  try {
    new Cron(cron, { paused: true, domAndDow: false, timezone: "UTC" });
  } catch {
    // Only inspect individual fields on failure; valid scheduling keeps the
    // existing single-parser path and uses the same range rules as Croner.
    for (const [index, field] of recurring.entries()) {
      const probe = ["0", "0", "*", "*", "*"];
      probe[index] = field;
      try {
        new Cron(probe.join(" "), { paused: true, domAndDow: false, timezone: "UTC" });
      } catch {
        throw new ScheduleError(
          `${CRON_SCHEDULE_FIELDS[index]!.label}: expected ${CRON_SCHEDULE_FIELDS[index]!.range}. Check ranges and use a positive step.`,
          "invalid_schedule",
          index + offset,
        );
      }
    }
    throw new ScheduleError("Invalid cron expression.");
  }
  return cron;
}
function localDate(date: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const result = new Date(0);
  result.setUTCFullYear(get("year"), get("month") - 1, get("day"));
  result.setUTCHours(get("hour"), get("minute"), get("second"), 0);
  return result;
}
/** The first UTC occurrence of a repeated wall time owns that fire, even when the reference is inside the second hour. */
function canonicalOccurrence(date: Date, timezone: string): boolean {
  const wall = localDate(date, timezone).getTime();
  const offset = wall - date.getTime();
  for (const delta of [-172800000, -86400000, 86400000, 172800000]) {
    const sample = new Date(date.getTime() + delta);
    const otherOffset = localDate(sample, timezone).getTime() - sample.getTime();
    if (otherOffset <= offset) continue;
    const earlier = new Date(wall - otherOffset);
    if (earlier < date && localDate(earlier, timezone).getTime() === wall) return false;
  }
  return true;
}
export function nextScheduleFires(
  cronInput: string,
  zone: string,
  after: Date,
  count = 5,
): string[] {
  const cron = normalizeCron(cronInput),
    timezone = validateTimezone(zone);
  if (!Number.isFinite(after.getTime()) || !Number.isInteger(count) || count < 1 || count > 50)
    throw new ScheduleError("Invalid preview reference or count.");
  const job = new Cron(cron, { paused: true, timezone, domAndDow: false });
  const wallJob = new Cron(cron, { paused: true, timezone: "UTC", domAndDow: false });
  const result: string[] = [];
  let cursor = after;
  for (let attempts = 0; attempts < 4096; attempts++) {
    const next = job.nextRun(cursor);
    if (next === null) return result;
    if (next.getTime() <= cursor.getTime()) {
      // Croner can map a future wall minute back onto the first occurrence
      // while the reference is in the second repeated hour. Move the reference
      // forward through that overlap, bounded by the common candidate limit.
      if (
        cursor.getTime() - next.getTime() <= 86400000 &&
        localDate(next, timezone).getTime() > localDate(cursor, timezone).getTime()
      ) {
        cursor = new Date(cursor.getTime() + 60000);
        continue;
      }
      throw new ScheduleError("Cron evaluation did not progress.", "evaluation_limit");
    }
    cursor = next;
    if (!wallJob.match(localDate(next, timezone)) || !canonicalOccurrence(next, timezone)) continue;
    result.push(next.toISOString());
    if (result.length === count) return result;
  }
  throw new ScheduleError("Cron evaluation exceeded its candidate limit.", "evaluation_limit");
}
export function describeSchedule(cronInput: string, zone: string): string {
  const cron = normalizeCron(cronInput),
    timezone = validateTimezone(zone),
    fields = cron.split(" ");
  if (fields.length === 7)
    return `Once on ${fields[6]}-${fields[4]!.padStart(2, "0")}-${fields[3]!.padStart(2, "0")} at ${fields[2]!.padStart(2, "0")}:${fields[1]!.padStart(2, "0")} (${timezone})`;
  if (fields[2] !== "*" && fields[4] !== "*") {
    const dom = [...fields],
      dow = [...fields];
    dom[4] = "*";
    dow[2] = "*";
    return `Either ${cronstrue.toString(dom.join(" "))} or ${cronstrue.toString(dow.join(" "))}; one run when both match (${timezone})`;
  }
  return `${cronstrue.toString(cron)} (${timezone})`;
}
export function previewCronSchedule(cronInput: string, zone: string, after = new Date()) {
  const cron = normalizeCron(cronInput),
    timezone = validateTimezone(zone);
  const nextFireTimes = nextScheduleFires(cron, timezone, after);
  return {
    cron,
    timezone,
    summary: describeSchedule(cron, timezone),
    nextFireTimes,
    oneShotAt: cron.split(" ").length === 7 ? (nextFireTimes[0] ?? null) : null,
  };
}
export function oneShotCron(instant: string, timezone: string, after = new Date()): string {
  const date = new Date(instant);
  if (
    !Number.isFinite(date.getTime()) ||
    date <= after ||
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0
  )
    throw new ScheduleError("One-shot time must be in the future at minute precision.");
  const wall = localDate(date, validateTimezone(timezone));
  const cron = `0 ${wall.getUTCMinutes()} ${wall.getUTCHours()} ${wall.getUTCDate()} ${wall.getUTCMonth() + 1} * ${wall.getUTCFullYear()}`;
  if (
    nextScheduleFires(cron, timezone, after, 1)[0] !== date.toISOString() ||
    !canonicalOccurrence(date, timezone)
  )
    throw new ScheduleError("The one-shot time is ambiguous or nonexistent.");
  // Reject both occurrences of an ambiguous wall time for one-shot conversions.
  for (const delta of [-3600000, 3600000, -1800000, 1800000, -7200000, 7200000])
    if (localDate(new Date(date.getTime() + delta), timezone).getTime() === wall.getTime())
      throw new ScheduleError("The one-shot time is ambiguous.");
  return cron;
}
