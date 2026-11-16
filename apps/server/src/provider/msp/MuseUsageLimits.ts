import type { RuntimeUsageLimit } from "@t3tools/contracts";
import { Option, Schema } from "effect";
import { usageLimitFromWindows } from "../usageLimitMessages.ts";

const DateMillis = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(8.64e15),
);
const UsageWindow = Schema.Struct({
  usedPercent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  resetsAtMs: DateMillis,
});
const SubscriptionUsage = Schema.Struct({
  observedAtMs: DateMillis,
  tier: Schema.String,
  window: Schema.Struct({
    ...UsageWindow.fields,
    windowDurationMins: Schema.Finite.check(Schema.isGreaterThan(0)),
  }),
  weekly: UsageWindow,
});
export type MuseSubscriptionUsage = typeof SubscriptionUsage.Type;

export function decodeMuseSubscriptionUsage(value: unknown): MuseSubscriptionUsage | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(SubscriptionUsage)(value));
}

/** A plain 429 is transient throttling, rather than an exhausted subscription. */
export function museUsageLimit(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  message: string | undefined,
  quota: unknown,
): RuntimeUsageLimit | undefined {
  const typed = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Struct({ resetsAtMs: Schema.Finite }))(quota),
  );
  if (!typed && !(message && /\b429\b/.test(message) && /quota|usage limit/i.test(message))) {
    return undefined;
  }
  const named = message?.match(
    /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i,
  )?.[1];
  const windows: RuntimeUsageLimit["windows"][number][] = [];
  const add = (id: string, ms: number | undefined) => {
    if (ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= 8.64e15) {
      windows.push({ id, label: null, resetsAt: new Date(ms).toISOString() });
    }
  };
  for (const id of ["window", "weekly"] as const) {
    const window = usage?.[id];
    if (window && window.usedPercent >= 100) add(id, window.resetsAtMs);
  }
  add("quota", typed?.resetsAtMs);
  add("message", named ? Date.parse(named) : undefined);
  return usageLimitFromWindows(
    windows,
    typed ? "typed" : "message",
    windows.some((window) => window.id !== "message") ? "provider" : "message",
  );
}
