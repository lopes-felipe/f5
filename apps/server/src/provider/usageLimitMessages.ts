import { resetDate } from "../usage/accountUsageJson.ts";
import type { RuntimeUsageLimit, UsageAccount } from "@t3tools/contracts";
/** Provider reset timestamps are epoch seconds; never render an invalid date. */
export function usageLimitMessage(
  provider: string,
  window: string | undefined,
  resetsAt: unknown,
): string {
  const normalized = resetDate(resetsAt, "s");
  const reset = normalized && Date.parse(normalized) > 0 ? ` Resets at ${normalized}.` : "";
  return `${provider} ${window ? `${window} ` : ""}usage limit reached.${reset} Retry after the limit resets.`;
}

export function claudeLimitState(info: Record<string, unknown>): {
  blocked: boolean;
  window: string;
  message: string;
  key: string;
  resettable: boolean;
  structuredWindow: RuntimeUsageLimit["windows"][number];
} {
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType : "unknown";
  const labels: Record<string, string> = {
    five_hour: "5-hour",
    seven_day: "7-day",
    seven_day_opus: "7-day Opus",
    seven_day_sonnet: "7-day Sonnet",
    seven_day_overage_included: "7-day model",
    overage: "overage",
  };
  const overage =
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true ||
    info.overageInUse === true;
  return {
    resettable: type !== "overage",
    structuredWindow: {
      id: type,
      label: labels[type] ?? null,
      resetsAt: resetDate(info.resetsAt, "s"),
    },
    blocked: info.status === "rejected" && !overage,
    window: type,
    key: `${type}:${info.resetsAt ?? "unknown"}`,
    message: usageLimitMessage("Claude", labels[type], info.resetsAt),
  };
}

export function usageLimitFromWindows(
  windows: RuntimeUsageLimit["windows"],
  evidence: RuntimeUsageLimit["evidence"] = "typed",
  resetSource: RuntimeUsageLimit["resetSource"] = "provider",
): RuntimeUsageLimit {
  const resets = windows.map((window) => window.resetsAt);
  return {
    windows,
    resetsAt:
      windows.length > 0 && resets.every((reset) => reset !== null)
        ? resets.reduce<string | null>(
            (latest, reset) => (!latest || reset! > latest ? reset : latest),
            null,
          )
        : null,
    evidence,
    resetSource,
  };
}

/** Only successful account reads made after the failure may resolve its reset. */
export function resolveAccountUsageLimit(
  limit: RuntimeUsageLimit,
  account: UsageAccount,
  at: string,
): RuntimeUsageLimit {
  const windows: RuntimeUsageLimit["windows"][number][] = [];
  for (const section of account.sections) {
    if (
      section.outcome !== "available" ||
      !section.snapshot ||
      Date.parse(section.snapshot.fetchedAt) <= Date.parse(at)
    )
      continue;
    if (section.kind === "claude-usage") {
      for (const window of section.snapshot.data.windows) {
        if (window.utilization !== null && window.utilization >= 100)
          windows.push({ id: window.key, label: window.label, resetsAt: window.resetsAt });
      }
    } else if (section.kind === "codex-limits") {
      for (const bucket of section.snapshot.data.rateLimits) {
        for (const name of ["primary", "secondary"] as const) {
          const window = bucket[name];
          if (window && window.usedPercent >= 100)
            windows.push({
              id: `${bucket.id}:${name}`,
              label: bucket.name,
              resetsAt: resetDate(window.resetsAt, "s"),
            });
        }
      }
    }
  }
  if (!windows.length) return limit;
  // Preserve unknown exhausted windows reported by the provider; a missing
  // account bucket cannot prove that a window has reset.
  const byId = new Map(limit.windows.map((window) => [window.id, window]));
  for (const window of windows) byId.set(window.id, window);
  const merged = [...byId.values()];
  return usageLimitFromWindows(merged, limit.evidence, "account");
}
