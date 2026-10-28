import type { AccountUsageSection, ModelSelection, UsageAccount } from "@t3tools/contracts";
import { quotaWindowsFromSection } from "@t3tools/shared/usageLimit";
import { BUFFER_MS, MAX_HORIZON_MS } from "../nextTurnQueue/usageLimitResume.ts";

function fresh(section: AccountUsageSection, now: number): boolean {
  const fetched = Date.parse(section.snapshot?.fetchedAt ?? "");
  return (
    section.outcome === "available" &&
    Number.isFinite(fetched) &&
    now - fetched <= 300_000 &&
    fetched <= now + 5_000
  );
}

/** Absence of a gate is not proof of capacity: stale/missing quota data is unknown. */
export function hasFreshUsageCapacity(
  accounts: ReadonlyArray<UsageAccount>,
  selection: ModelSelection,
  now: number,
): boolean {
  let known = false;
  for (const account of accounts) {
    if (account.providerInstanceId !== selection.instanceId) continue;
    for (const section of account.sections) {
      if (!fresh(section, now)) return false;
      for (const window of quotaWindowsFromSection(section)) {
        if (!applies(section, window.windowKey, selection.model)) continue;
        if (window.usedPercent == null || window.usedPercent >= 100) return false;
        known = true;
      }
    }
  }
  return known;
}

/** Shared usage gate for scheduled tasks and the upstream port queue. */
export function scheduledUsageRetryAt(
  accounts: ReadonlyArray<UsageAccount>,
  selection: ModelSelection,
  now: number,
): string | null {
  let target = 0;
  for (const account of accounts) {
    if (account.providerInstanceId !== selection.instanceId) continue;
    for (const section of account.sections) {
      if (!fresh(section, now)) continue;
      for (const window of quotaWindowsFromSection(section)) {
        if (
          (window.usedPercent ?? 0) < 100 ||
          !window.resetsAt ||
          !applies(section, window.windowKey, selection.model)
        )
          continue;
        const reset = Date.parse(window.resetsAt);
        if (reset <= now || reset > now + MAX_HORIZON_MS) continue;
        target = Math.max(target, reset + BUFFER_MS);
      }
    }
  }
  return target ? new Date(target).toISOString() : null;
}
function applies(section: AccountUsageSection, key: string, model: string): boolean {
  const normalized = key.toLowerCase(),
    selected = model.toLowerCase();
  if (section.kind === "claude-usage") {
    if (normalized === "five_hour" || normalized === "seven_day") return true;
    for (const family of ["opus", "sonnet", "haiku"])
      if (normalized.includes(family)) return selected.includes(family);
    return false;
  }
  if (section.kind === "codex-limits")
    return (
      /^(codex|default|global|account):/.test(normalized) || normalized.split(":")[0] === selected
    );
  return normalized === "global" || normalized === "account" || normalized === selected;
}
