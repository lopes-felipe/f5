import { Schema } from "effect";

/** Where a notification comes from; each source has its own delivery preferences. */
export const NOTIFICATION_SOURCES = [
  "thread",
  "pr",
  "scheduled",
  "upstream",
  "update",
  "errors",
] as const;

export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];

export const NOTIFICATION_SOURCE_LABELS: Record<NotificationSource, string> = {
  thread: "Threads",
  pr: "Pull requests",
  scheduled: "Scheduled runs",
  upstream: "Upstream",
  update: "App updates",
  errors: "Errors",
};

export const NOTIFICATION_SOURCE_DESCRIPTIONS: Record<NotificationSource, string> = {
  thread: "A thread needs approval or input, has a plan ready, finished or failed.",
  pr: "A tracked pull request needs your review or attention.",
  scheduled: "A scheduled task finished a run.",
  upstream: "An upstream run found new topics to review.",
  update: "A new version of F5 is ready to install.",
  errors: "Something you started failed.",
};

/** In-app: a toast while F5 is focused. System: an OS notification while it is not. */
export type NotificationChannelPreference = {
  readonly inApp: boolean;
  readonly system: boolean;
  readonly sound: boolean;
};

export type NotificationPreferences = Record<NotificationSource, NotificationChannelPreference>;

const ChannelPreferenceSchema = Schema.Struct({
  inApp: Schema.Boolean,
  system: Schema.Boolean,
  sound: Schema.Boolean,
});

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  thread: { inApp: false, system: true, sound: false },
  pr: { inApp: true, system: true, sound: false },
  scheduled: { inApp: true, system: true, sound: false },
  upstream: { inApp: true, system: true, sound: false },
  update: { inApp: true, system: false, sound: false },
  errors: { inApp: true, system: false, sound: false },
};

export const NotificationPreferencesSchema = Schema.Struct({
  thread: ChannelPreferenceSchema,
  pr: ChannelPreferenceSchema,
  scheduled: ChannelPreferenceSchema,
  upstream: ChannelPreferenceSchema,
  update: ChannelPreferenceSchema,
  errors: ChannelPreferenceSchema,
});

type LegacyNotificationSettings = {
  readonly notificationMode?: unknown;
  readonly inAppThreadNotifications?: unknown;
  readonly enableThreadStatusNotifications?: unknown;
  readonly enablePrAttentionNotifications?: unknown;
};

/** Preferences for settings saved before they existed, carried over from the old switches. */
export function deriveNotificationPreferences(
  legacy: LegacyNotificationSettings,
): NotificationPreferences {
  const mode =
    typeof legacy.notificationMode === "string"
      ? legacy.notificationMode
      : legacy.enableThreadStatusNotifications === false
        ? "off"
        : "system";
  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    thread: {
      inApp: legacy.inAppThreadNotifications === true,
      system: mode === "system" || mode === "system-and-sound",
      sound: mode === "sound" || mode === "system-and-sound",
    },
    pr: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.pr,
      system: legacy.enablePrAttentionNotifications !== false,
    },
  };
}

/** Merges a stored value over the defaults so one bad or missing source keeps the rest. */
export function normalizeNotificationPreferences(value: unknown): NotificationPreferences | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const result = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  for (const source of NOTIFICATION_SOURCES) {
    const entry = record[source];
    if (!entry || typeof entry !== "object") continue;
    const channel = entry as Record<string, unknown>;
    result[source] = {
      inApp: typeof channel.inApp === "boolean" ? channel.inApp : result[source].inApp,
      system: typeof channel.system === "boolean" ? channel.system : result[source].system,
      sound: typeof channel.sound === "boolean" ? channel.sound : result[source].sound,
    };
  }
  return result;
}

export const DO_NOT_DISTURB_FOREVER = "forever";

export function isDoNotDisturbActive(until: string | null | undefined, nowMs: number): boolean {
  if (!until) return false;
  if (until === DO_NOT_DISTURB_FOREVER) return true;
  const untilMs = Date.parse(until);
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

export type DoNotDisturbSnooze = "1h" | "tomorrow" | "forever";

export const DO_NOT_DISTURB_SNOOZE_LABELS: Record<DoNotDisturbSnooze, string> = {
  "1h": "For 1 hour",
  tomorrow: "Until tomorrow 9:00",
  forever: "Until I turn it off",
};

/** The `doNotDisturbUntil` value for a snooze choice, in the user's local time. */
export function doNotDisturbUntilFor(snooze: DoNotDisturbSnooze, now: Date): string {
  if (snooze === "forever") return DO_NOT_DISTURB_FOREVER;
  if (snooze === "1h") return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

/** "Until 14:30", "Until tomorrow 9:00" or "Until you turn it off", for an active snooze. */
export function describeDoNotDisturb(until: string | null, now: Date): string | null {
  if (!isDoNotDisturbActive(until, now.getTime())) return null;
  if (until === DO_NOT_DISTURB_FOREVER) return "Until you turn it off";
  const end = new Date(until!);
  const time = end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = end.toDateString() === now.toDateString();
  return sameDay ? `Until ${time}` : `Until tomorrow ${time}`;
}

export const TOAST_POSITIONS = ["top-right", "bottom-right"] as const;
export type AppToastPosition = (typeof TOAST_POSITIONS)[number];
