export type SnoozePreset = "three-hours" | "tomorrow-morning" | "next-week";

export const SNOOZE_PRESETS: ReadonlyArray<{
  readonly id: SnoozePreset;
  readonly label: string;
}> = [
  { id: "three-hours", label: "3 hours" },
  { id: "tomorrow-morning", label: "Tomorrow morning" },
  { id: "next-week", label: "Next week" },
];

export function resolveSnoozePreset(preset: SnoozePreset, now = new Date()): string {
  const until = new Date(now);
  switch (preset) {
    case "three-hours":
      until.setTime(until.getTime() + 3 * 60 * 60 * 1_000);
      break;
    case "tomorrow-morning":
      until.setDate(until.getDate() + 1);
      until.setHours(9, 0, 0, 0);
      break;
    case "next-week":
      until.setDate(until.getDate() + 7);
      until.setHours(9, 0, 0, 0);
      break;
  }
  return until.toISOString();
}
