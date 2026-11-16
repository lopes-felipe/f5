import type { ClaudeAccountUsage } from "@t3tools/contracts";
import { CLAUDE_MONTHLY_SPEND_WINDOW_KEY } from "@t3tools/shared/usageLimit";
import { claudeSubscriptionLabel } from "../provider/claudeSubscription.ts";
import {
  asRecord,
  asTrimmedString,
  asNonNegativeInteger,
  asNonNegativeNumber,
  asIsoDateTime,
} from "./accountUsageJson.ts";
import { AccountUsageReadError } from "./accountUsageErrors.ts";

function percentFromAmounts(used: unknown, limit: unknown): number | null {
  const usedAmount = asNonNegativeNumber(used);
  const limitAmount = asNonNegativeNumber(limit);
  if (usedAmount === null || limitAmount === null || limitAmount <= 0) return null;
  const percent = (usedAmount / limitAmount) * 100;
  return Number.isFinite(percent) ? percent : null;
}

/**
 * Enterprise accounts can have a monthly spending budget instead of rolling
 * quotas. Prefer the exact spend amounts; `spend.percent` is rounded. Minor-unit
 * ratios require a matching currency and scale. Overspend stays above 100 so
 * the meter can show it, like the other Claude windows.
 */
function monthlySpendPercent(limits: Record<string, unknown>): number | null {
  const spend = asRecord(limits.spend);
  const used = asRecord(spend?.used);
  const limit = asRecord(spend?.limit);
  const currency = asTrimmedString(used?.currency);
  if (
    spend?.enabled === true &&
    currency !== null &&
    currency === asTrimmedString(limit?.currency) &&
    asNonNegativeInteger(used?.exponent) !== null &&
    used?.exponent === limit?.exponent
  ) {
    const percent = percentFromAmounts(used?.amount_minor, limit?.amount_minor);
    if (percent !== null) return percent;
  }
  const extra = asRecord(limits.extra_usage);
  if (extra?.is_enabled !== true) return null;
  return (
    percentFromAmounts(extra.used_credits, extra.monthly_limit) ??
    asNonNegativeNumber(extra.utilization)
  );
}

export function normalizeClaudeAccountUsage(value: unknown): ClaudeAccountUsage {
  const record = asRecord(value);
  if (!record || typeof record.rate_limits_available !== "boolean")
    throw new AccountUsageReadError("invalid-response");
  const limits = asRecord(record.rate_limits);
  if (record.rate_limits_available && !limits) throw new AccountUsageReadError("invalid-response");
  const windows: Array<ClaudeAccountUsage["windows"][number]> = [];
  const scoped = new Map<string, ClaudeAccountUsage["windows"][number]>();
  if (record.rate_limits_available && limits) {
    if (Array.isArray(limits.model_scoped))
      for (const entry of [...limits.model_scoped].sort((a, b) => {
        const left = asTrimmedString(asRecord(a)?.display_name) ?? "";
        const right = asTrimmedString(asRecord(b)?.display_name) ?? "";
        return left < right ? -1 : left > right ? 1 : 0;
      })) {
        const row = asRecord(entry);
        const name = asTrimmedString(row?.display_name);
        if (!name) continue;
        const identity = name.toLowerCase();
        if (!scoped.has(identity))
          scoped.set(identity, {
            key: `model:${identity}`,
            label: `${name} weekly limit`,
            utilization: asNonNegativeNumber(row?.utilization),
            resetsAt: asIsoDateTime(row?.resets_at),
          });
      }
    const named = [
      ["five_hour", "5-hour limit"],
      ["seven_day", "Weekly limit"],
      ["seven_day_oauth_apps", "OAuth apps weekly limit"],
      ["seven_day_opus", "Opus weekly limit"],
      ["seven_day_sonnet", "Sonnet weekly limit"],
    ] as const;
    for (const [key, label] of named) {
      const row = asRecord(limits[key]);
      const model =
        key === "seven_day_opus" ? "opus" : key === "seven_day_sonnet" ? "sonnet" : null;
      if (
        !row ||
        (model &&
          Array.from(scoped.keys()).some((name) =>
            new RegExp(`^(?:claude[ -]+)?${model}(?:[ -]+[0-9]+(?:[.-][0-9]+)*)?$`).test(name),
          ))
      )
        continue;
      windows.push({
        key,
        label,
        utilization: asNonNegativeNumber(row.utilization),
        resetsAt: asIsoDateTime(row.resets_at),
      });
    }
    windows.push(...[...scoped.values()].sort((a, b) => a.key.localeCompare(b.key)));
    const spend = monthlySpendPercent(limits);
    if (spend !== null)
      windows.push({
        key: CLAUDE_MONTHLY_SPEND_WINDOW_KEY,
        label: "Monthly spend",
        utilization: spend,
        resetsAt: null,
      });
  }
  const extra = record.rate_limits_available ? asRecord(limits?.extra_usage) : null;
  return {
    subscriptionLabel:
      claudeSubscriptionLabel(asTrimmedString(record.subscription_type) ?? undefined) ?? null,
    limitsAvailable: record.rate_limits_available,
    windows,
    // The SDK does not establish monetary denomination. Display no guessed amounts.
    extraUsage:
      extra && typeof extra.is_enabled === "boolean"
        ? { enabled: extra.is_enabled, utilization: asNonNegativeNumber(extra.utilization) }
        : null,
  };
}
