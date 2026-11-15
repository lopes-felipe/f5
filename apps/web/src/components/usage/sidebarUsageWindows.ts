import type { UsageAccount } from "@t3tools/contracts";
import { quotaWindowsFromSection } from "@t3tools/shared/usageLimit";

/** Uses reported window identities and durations, so new model versions need no catalog update. */
export function sidebarUsageWindows(account: UsageAccount) {
  const reported = account.sections.flatMap((section) =>
    quotaWindowsFromSection(section).map((window) => ({
      ...window,
      observedAt: section.snapshot?.fetchedAt ?? null,
    })),
  );
  const byKey = new Map<string, (typeof reported)[number]>();
  for (const window of reported) {
    const previous = byKey.get(window.windowKey);
    if (!previous || (window.observedAt ?? "") >= (previous.observedAt ?? ""))
      byKey.set(window.windowKey, window);
  }
  const windows = [...byKey.values()];
  if (account.provider === "codex") {
    const weekly = windows.filter((window) => window.durationMinutes === 10_080);
    const main = weekly.filter((window) => window.windowKey.startsWith("codex:"));
    return main.length ? main : weekly;
  }
  if (account.provider === "claudeAgent") {
    return windows
      .filter(
        (window) =>
          window.windowKey === "five_hour" ||
          window.windowKey === "seven_day" ||
          /^model:(?:claude[ -]+)?fable(?:[ -]|$)/iu.test(window.windowKey) ||
          window.windowKey === "seven_day_fable",
      )
      .map((window) => ({
        ...window,
        label:
          window.windowKey === "five_hour"
            ? "5-hour limit"
            : window.windowKey === "seven_day"
              ? "All models · Weekly"
              : window.label,
      }));
  }
  return windows;
}
