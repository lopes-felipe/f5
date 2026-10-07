import type { RuntimeUsageLimit, UsageAccount } from "@t3tools/contracts";
import { BUFFER_MS } from "../nextTurnQueue/usageLimitResume.ts";
import { resetDate } from "./accountUsageJson.ts";

/** Missing windows or unsuccessful reads cannot prove the limit has been lifted. */
export function usageResumeTargetAfterCredit(
  limit: RuntimeUsageLimit,
  account: UsageAccount,
  after: string,
  now: number,
): string | null {
  if (!limit.windows.length) return null;
  const windows = new Map<string, { used: number | null; reset: string | null }>();
  for (const section of account.sections) {
    if (
      section.outcome !== "available" ||
      !section.snapshot ||
      Date.parse(section.snapshot.fetchedAt) <= Date.parse(after)
    )
      continue;
    if (section.kind === "claude-usage") {
      for (const window of section.snapshot.data.windows)
        windows.set(window.key, { used: window.utilization, reset: window.resetsAt });
    } else if (section.kind === "codex-limits") {
      for (const bucket of section.snapshot.data.rateLimits)
        for (const name of ["primary", "secondary"] as const) {
          const window = bucket[name];
          if (window)
            windows.set(`${bucket.id}:${name}`, {
              used: window.usedPercent,
              reset: resetDate(window.resetsAt, "s"),
            });
        }
    }
  }
  const tracked = limit.windows.map((window) => windows.get(window.id));
  if (tracked.some((window) => !window || window.used === null)) return null;
  if (tracked.every((window) => window!.used! < 100)) return new Date(now).toISOString();
  const exhausted = tracked.filter((window) => window!.used! >= 100);
  if (exhausted.some((window) => !window!.reset)) return null;
  const target = Math.max(...exhausted.map((window) => Date.parse(window!.reset!))) + BUFFER_MS;
  return target > now ? new Date(target).toISOString() : null;
}
