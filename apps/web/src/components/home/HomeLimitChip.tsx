import type { UsageAccounts } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { useNowMinute } from "../../lib/nowTicker";
import { usageAccountsQueryOptions } from "../../lib/usageReactQuery";
import { formatTimeUntil } from "../../lib/usageLimits";
import { readNativeApi } from "../../nativeApi";
import { accountQuotaWindows } from "../usage/AccountUsageCards";
import { glanceQuotaWindow } from "../usage/charts/TightestLimitCallout";
import { HomeStripChip, HomeStripValue } from "./HomeStripChip";

/** Below this the limit is not worth a chip. */
export const HOME_LIMIT_CHIP_MIN_PERCENT = 50;

export interface HomeLimitGlance {
  readonly accountName: string;
  readonly windowLabel: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

/**
 * The account limit closest to running out, as the Usage page's glance tiles pick it:
 * each enabled account's leading window, then the fullest of those.
 */
export function tightestAccountLimit(
  accounts: UsageAccounts | undefined,
  nowMs: number,
): HomeLimitGlance | null {
  let tightest: HomeLimitGlance | null = null;
  for (const account of accounts ?? []) {
    if (!account.enabled) continue;
    const lead = glanceQuotaWindow(accountQuotaWindows(account), nowMs);
    if (!lead || lead.usedPercent === null) continue;
    if (tightest && tightest.usedPercent >= lead.usedPercent) continue;
    tightest = {
      accountName: account.displayName,
      windowLabel: lead.label,
      usedPercent: lead.usedPercent,
      resetsAt: lead.resetsAt,
    };
  }
  return tightest;
}

/**
 * Home's usage limit chip. It is its own chunk because the quota window helpers live with
 * the Usage page's charts, which Home's startup must not load.
 */
export default function HomeLimitChip(props: { readonly onOpen: () => void }) {
  const accounts = useQuery({
    ...usageAccountsQueryOptions(),
    enabled: Boolean(readNativeApi()?.usage),
    // The server samples limits itself; Home only reads what it has.
    refetchInterval: false,
  });
  const now = useNowMinute();
  const limit = tightestAccountLimit(accounts.data, now);
  if (!limit || limit.usedPercent < HOME_LIMIT_CHIP_MIN_PERCENT) return null;
  const used = Math.min(100, Math.round(limit.usedPercent));
  const reset = limit.resetsAt ? formatTimeUntil(limit.resetsAt, now) : null;
  return (
    <HomeStripChip
      testId="home-strip-limit"
      tone={used >= 100 ? "error" : used >= 90 ? "warning" : "default"}
      title={`${limit.accountName} · ${limit.windowLabel}`}
      onClick={props.onOpen}
    >
      {limit.accountName} limit <HomeStripValue>{used}%</HomeStripValue>
      {reset ? ` · resets ${reset}` : null}
    </HomeStripChip>
  );
}
