import type { ClaudeAccountUsage } from "@t3tools/contracts";
import { claudeSubscriptionLabel } from "../provider/Layers/ClaudeProvider.ts";
import {
  asRecord,
  asTrimmedString,
  asNonNegativeNumber,
  asIsoDateTime,
} from "./accountUsageJson.ts";
import { AccountUsageReadError } from "./accountUsageErrors.ts";

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
      if (!row || (model && (scoped.has(model) || scoped.has(`claude ${model}`)))) continue;
      windows.push({
        key,
        label,
        utilization: asNonNegativeNumber(row.utilization),
        resetsAt: asIsoDateTime(row.resets_at),
      });
    }
    windows.push(...[...scoped.values()].sort((a, b) => a.key.localeCompare(b.key)));
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
