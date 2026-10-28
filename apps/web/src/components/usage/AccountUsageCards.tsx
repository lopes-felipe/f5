import type {
  AccountUsageErrorCode,
  AccountUsageSection,
  CodexAccountUsage,
  UsageAccount,
  UsageAccounts,
  UsageQuotaHistory,
  UsageQuotaSample,
  UsageRange,
} from "@t3tools/contracts";
import { codexRateLimitWindowLabel, quotaWindowsFromSection } from "@t3tools/shared/usageLimit";

import { formatAbsoluteTimeLabel } from "../../lib/relativeTime";
import { QuotaMeter } from "./charts/QuotaMeter";
import { providerLabel } from "./format";
import { ResetCreditButton } from "./ResetCreditButton";

const RESET_MATCH_MS = 10 * 60_000;

const ACCOUNT_ERROR_MESSAGES: Record<AccountUsageErrorCode, string> = {
  unsupported: "This installed provider version does not expose account usage and rate limits.",
  "authentication-required": "Account usage requires authentication in provider settings.",
  timeout: "The account usage request timed out.",
  "process-unavailable": "The configured provider executable is unavailable.",
  "invalid-response": "The provider returned an invalid account usage response.",
  "temporary-failure": "Account usage is temporarily unavailable.",
};

export type QuotaHistoryIndex = ReadonlyMap<
  string,
  { readonly resetsAt: string; readonly samples: ReadonlyArray<UsageQuotaSample> }
>;

export function indexQuotaHistory(history: UsageQuotaHistory | undefined): QuotaHistoryIndex {
  return new Map(
    (history?.series ?? []).map((series) => [
      `${series.accountKey}\u0000${series.windowKey}`,
      { resetsAt: series.resetsAt, samples: series.samples },
    ]),
  );
}

/** History applies only when its window resets within 10 minutes of the meter's. */
function historyFor(
  index: QuotaHistoryIndex | undefined,
  accountKey: string,
  windowKey: string,
  resetsAt: string | null,
): ReadonlyArray<UsageQuotaSample> | undefined {
  const series = index?.get(`${accountKey}\u0000${windowKey}`);
  if (!series || !resetsAt) return undefined;
  return Math.abs(Date.parse(series.resetsAt) - Date.parse(resetsAt)) <= RESET_MATCH_MS
    ? series.samples
    : undefined;
}

function compactDecimalCount(value: string | null): string {
  if (value === null) return "Unavailable";
  try {
    return new Intl.NumberFormat(undefined, {
      notation: value.length > 4 ? "compact" : "standard",
      maximumFractionDigits: value.length > 4 ? 1 : 0,
    }).format(BigInt(value));
  } catch {
    return value;
  }
}

function codexAccountRangeTokens(input: {
  readonly usage: CodexAccountUsage;
  readonly range: UsageRange;
}): string | null {
  const rangeDays = input.range === "24h" ? 1 : Number.parseInt(input.range, 10);
  const firstDay = new Date(input.usage.fetchedAt);
  firstDay.setUTCHours(0, 0, 0, 0);
  firstDay.setUTCDate(firstDay.getUTCDate() - (rangeDays - 1));
  const firstDate = firstDay.toISOString().slice(0, 10);
  let total = 0n;
  let found = false;
  for (const bucket of input.usage.dailyUsageBuckets) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate)) continue;
    const date = new Date(`${bucket.startDate}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== bucket.startDate)
      continue;
    if (bucket.startDate < firstDate || bucket.startDate > input.usage.fetchedAt.slice(0, 10))
      continue;
    total += BigInt(bucket.tokens);
    found = true;
  }
  return found ? total.toString() : null;
}

function CodexTokenSummary(props: {
  readonly usage: CodexAccountUsage;
  readonly range: UsageRange;
}) {
  const summary = props.usage.tokenSummary;
  if (!summary) return null;
  const rangeTokens = codexAccountRangeTokens(props);
  return (
    <div className="grid gap-3 pt-2 sm:grid-cols-2 xl:grid-cols-4">
      <div>
        <p className="text-2xs text-muted-foreground">
          Account tokens ·{" "}
          {props.range === "24h" ? "Today (UTC)" : `${props.range} (UTC calendar days)`}
        </p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums">
          {compactDecimalCount(rangeTokens)}
        </p>
      </div>
      <div>
        <p className="text-2xs text-muted-foreground">Lifetime tokens</p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums">
          {compactDecimalCount(summary.lifetimeTokens)}
        </p>
      </div>
      <div>
        <p className="text-2xs text-muted-foreground">Peak daily tokens</p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums">
          {compactDecimalCount(summary.peakDailyTokens)}
        </p>
      </div>
      <div>
        <p className="text-2xs text-muted-foreground">Current usage streak</p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums">
          {summary.currentStreakDays === null
            ? "Unavailable"
            : `${summary.currentStreakDays} day${summary.currentStreakDays === "1" ? "" : "s"}`}
        </p>
      </div>
    </div>
  );
}

function CodexLimits(props: {
  readonly account: UsageAccount;
  readonly section: Extract<AccountUsageSection, { kind: "codex-limits" }>;
  readonly history: QuotaHistoryIndex | undefined;
}) {
  const snapshot = props.section.snapshot;
  if (!snapshot || snapshot.data.rateLimits.length === 0) return null;
  const windows = new Map(
    quotaWindowsFromSection(props.section).map((window) => [window.windowKey, window]),
  );
  return (
    <div className="grid gap-4 border-t border-border/60 pt-4 md:grid-cols-2">
      {snapshot.data.rateLimits.map((limit) => (
        <div key={limit.id} className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium">{limit.name ?? limit.id}</p>
            {limit.planType ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                {limit.planType}
              </span>
            ) : null}
          </div>
          {(["primary", "secondary", "individual"] as const).map((slot) => {
            const window = windows.get(`${limit.id}:${slot}`);
            if (!window) return null;
            return (
              <QuotaMeter
                key={slot}
                label={window.label}
                accessibleName={`${limit.name ?? limit.id} · ${window.label}`}
                utilization={window.usedPercent}
                resetsAt={window.resetsAt}
                observedAt={snapshot.fetchedAt}
                {...withHistory(
                  props.history,
                  props.account.key,
                  window.windowKey,
                  window.resetsAt,
                )}
              />
            );
          })}
          {limit.credits?.hasCredits ? (
            <p className="text-2xs text-muted-foreground">
              Credits: {limit.credits.unlimited ? "Unlimited" : (limit.credits.balance ?? "—")}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function withHistory(
  index: QuotaHistoryIndex | undefined,
  accountKey: string,
  windowKey: string,
  resetsAt: string | null,
): { history?: ReadonlyArray<UsageQuotaSample> } {
  const history = historyFor(index, accountKey, windowKey, resetsAt);
  return history ? { history } : {};
}

function SectionStatus(props: {
  readonly account: UsageAccount;
  readonly section: AccountUsageSection;
}) {
  const { account, section } = props;
  // A snapshot with no attempt since startup was restored from disk.
  const restored = section.snapshot !== null && section.lastAttemptAt === null;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {section.kind === "codex-tokens"
          ? "Token history · "
          : section.kind === "codex-limits"
            ? "Rate limits · "
            : ""}
        {section.snapshot
          ? `Updated ${formatAbsoluteTimeLabel(section.snapshot.fetchedAt)}`
          : "No successful snapshot yet"}
        {restored ? (
          <span className="text-warning-foreground"> · Last known before restart</span>
        ) : null}
      </p>
      {section.outcome !== "available" && (section.lastAttemptAt || section.errorCode) ? (
        <p role="status" className="text-xs text-muted-foreground">
          {section.outcome === "unsupported"
            ? `This installed ${providerLabel(account.provider)} version does not expose account usage and rate limits.`
            : ACCOUNT_ERROR_MESSAGES[section.errorCode ?? "temporary-failure"]}
          {section.snapshot
            ? ` Showing data from ${formatAbsoluteTimeLabel(section.snapshot.fetchedAt)}.`
            : ""}
        </p>
      ) : null}
    </>
  );
}

export function AccountUsageCards({
  accounts,
  range,
  history,
}: {
  accounts: UsageAccounts;
  range: UsageRange;
  history?: QuotaHistoryIndex | undefined;
}) {
  return (
    <section aria-label="Account usage and limits" className="space-y-3">
      <h2 className="text-sm font-medium">Account usage and limits</h2>
      {accounts.map((account) => (
        <div key={account.key} className="space-y-2 rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{account.displayName}</h3>
            <span role="status" className="text-xs text-muted-foreground">
              {account.refreshState === "idle"
                ? ""
                : account.refreshState === "queued"
                  ? "Queued"
                  : "Refreshing…"}
            </span>
          </div>
          {account.provider === "codex" && (
            <p className="text-xs text-muted-foreground">
              Provider-native ChatGPT/Codex account totals and quota windows. These are not dollar
              costs.
            </p>
          )}
          {account.provider === "claudeAgent" && (
            <p className="text-xs text-muted-foreground">
              Configured instance's server-default authentication context.
            </p>
          )}
          {!account.enabled ? (
            <p className="text-xs text-muted-foreground">
              {providerLabel(account.provider)} is disabled in provider settings.
            </p>
          ) : (
            account.sections.map((section) => (
              <div key={section.kind} className="space-y-2">
                <SectionStatus account={account} section={section} />
                {section.kind === "provider-limits" && section.snapshot && (
                  <div className="grid gap-4 md:grid-cols-2">
                    {quotaWindowsFromSection(section).map((window) => (
                      <QuotaMeter
                        key={window.windowKey}
                        label={window.label}
                        utilization={window.usedPercent}
                        resetsAt={window.resetsAt}
                        observedAt={section.snapshot!.fetchedAt}
                        accessibleName={`${account.displayName} · ${window.label}`}
                        {...withHistory(history, account.key, window.windowKey, window.resetsAt)}
                      />
                    ))}
                  </div>
                )}
                {section.kind === "codex-limits" &&
                  section.snapshot?.data.resetCredits &&
                  account.providerInstanceId && (
                    <ResetCreditButton
                      instanceId={account.providerInstanceId}
                      accountName={account.displayName}
                      count={section.snapshot.data.resetCredits.availableCount}
                      windowName={
                        section.snapshot.data.rateLimits
                          .filter((limit) => limit.id === "codex")
                          .flatMap((limit) => [limit.primary, limit.secondary])
                          .flatMap((window) =>
                            window && window.usedPercent >= 100
                              ? [codexRateLimitWindowLabel(window, "main Codex allowance")]
                              : [],
                          )
                          .join(" and ") || "the main Codex allowance"
                      }
                    />
                  )}
                {section.kind === "claude-usage" && section.snapshot && (
                  <div className="space-y-3">
                    {section.snapshot.data.subscriptionLabel && (
                      <p className="text-xs font-medium">
                        {section.snapshot.data.subscriptionLabel}
                      </p>
                    )}
                    {!section.snapshot.data.limitsAvailable ? (
                      <p className="text-xs text-muted-foreground">
                        Plan limits aren't reported for this Claude session.
                      </p>
                    ) : section.snapshot.data.windows.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Account usage is temporarily unavailable.
                      </p>
                    ) : (
                      <div className="grid gap-4 md:grid-cols-2">
                        {quotaWindowsFromSection(section).map((window) => (
                          <QuotaMeter
                            key={window.windowKey}
                            label={window.label}
                            utilization={window.usedPercent}
                            resetsAt={window.resetsAt}
                            observedAt={section.snapshot!.fetchedAt}
                            accessibleName={`${account.displayName} · ${window.label}`}
                            {...withHistory(
                              history,
                              account.key,
                              window.windowKey,
                              window.resetsAt,
                            )}
                          />
                        ))}
                      </div>
                    )}
                    {section.snapshot.data.extraUsage && (
                      <div className="space-y-2">
                        <p className="text-xs">
                          Extra usage{" "}
                          {section.snapshot.data.extraUsage.enabled ? "enabled" : "disabled"}
                        </p>
                        {/* The monthly spend window already meters enabled extra usage. */}
                        {section.snapshot.data.extraUsage.enabled &&
                          !section.snapshot.data.windows.some(
                            (window) => window.key === "monthly_spend",
                          ) && (
                            <QuotaMeter
                              label="Extra usage"
                              accessibleName={`${account.displayName} · Extra usage`}
                              utilization={section.snapshot.data.extraUsage.utilization}
                              resetsAt={null}
                            />
                          )}
                      </div>
                    )}
                  </div>
                )}
                {section.kind === "codex-tokens" && section.snapshot && (
                  <CodexTokenSummary
                    range={range}
                    usage={{
                      ...section.snapshot.data,
                      status: "available",
                      fetchedAt: section.snapshot.fetchedAt,
                      rateLimits: [],
                      message: null,
                    }}
                  />
                )}
                {section.kind === "codex-limits" && (
                  <CodexLimits account={account} section={section} history={history} />
                )}
              </div>
            ))
          )}
        </div>
      ))}
    </section>
  );
}
