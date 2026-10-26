import type { AccountUsageSection, ModelSelection, UsageAccount } from "@t3tools/contracts";
import { quotaWindowsFromSection } from "@t3tools/shared/usageLimit";
import { BUFFER_MS, MAX_HORIZON_MS } from "../nextTurnQueue/usageLimitResume.ts";

/** Fresh known account-wide quotas apply to every model; named model quotas apply only to that family. */
export function scheduledUsageRetryAt(
  accounts: ReadonlyArray<UsageAccount>,
  selection: ModelSelection,
  now: number,
): string | null {
  let target = 0;
  for (const account of accounts) {
    if (account.providerInstanceId !== selection.instanceId) continue;
    for (const section of account.sections) {
      if (
        section.outcome !== "available" ||
        !section.snapshot ||
        now - Date.parse(section.snapshot.fetchedAt) > 300000 ||
        Date.parse(section.snapshot.fetchedAt) > now + 5000
      )
        continue;
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
