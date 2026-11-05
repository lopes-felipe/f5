import type {
  AccountUsageErrorCode,
  AccountUsageSection,
  CodexAccountDailyUsageBucket,
  CodexAccountTokenSummary,
  UsageAccount,
  UsageAccounts,
  UsageQuotaHistory,
  UsageQuotaSample,
  UsageRange,
} from "@t3tools/contracts";
import {
  CLAUDE_MONTHLY_SPEND_WINDOW_KEY,
  codexRateLimitWindowLabel,
  type QuotaWindow,
  quotaWindowsFromSection,
} from "@t3tools/shared/usageLimit";

import { formatAbsoluteTimeLabel } from "../../lib/relativeTime";
import { DailyTokenBars } from "./charts/DailyTokenBars";
import { QuotaMeter, QuotaMeterLegend } from "./charts/QuotaMeter";
import { TightestLimitCallout, tightestQuotaWindow } from "./charts/TightestLimitCallout";
import { codexAccountRangeTokens, codexDailyTokenSeries } from "./codexDailyTokens";
import { providerLabel } from "./format";
import { ResetCreditButton } from "./ResetCreditButton";
import { ClaudeUsageAnalysisPanel } from "./ClaudeUsageAnalysisPanel";

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

function StatTile(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2">
      <p className="text-2xs text-muted-foreground">{props.label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{props.value}</p>
    </div>
  );
}

function CodexTokenSummary(props: {
  readonly fetchedAt: string;
  readonly tokenSummary: CodexAccountTokenSummary | null;
  readonly dailyUsageBuckets: ReadonlyArray<CodexAccountDailyUsageBucket>;
  readonly range: UsageRange;
}) {
  const summary = props.tokenSummary;
  const series = codexDailyTokenSeries(props);
  if (!summary && !series) return null;
  return (
    <div className="space-y-3 pt-2">
      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label={`Account tokens · ${
              props.range === "24h" ? "Today (UTC)" : `${props.range} (UTC calendar days)`
            }`}
            value={compactDecimalCount(codexAccountRangeTokens(props))}
          />
          <StatTile label="Lifetime tokens" value={compactDecimalCount(summary.lifetimeTokens)} />
          <StatTile
            label="Peak daily tokens"
            value={compactDecimalCount(summary.peakDailyTokens)}
          />
          <StatTile
            label="Current usage streak"
            value={
              summary.currentStreakDays === null
                ? "Unavailable"
                : `${summary.currentStreakDays} day${summary.currentStreakDays === "1" ? "" : "s"}`
            }
          />
        </div>
      ) : null}
      {series ? <DailyTokenBars days={series.days} peakDate={series.peakDate} /> : null}
    </div>
  );
}

/** "Codex" + "Weekly limit" → "Codex weekly limit". */
function qualifiedWindowLabel(groupName: string, label: string): string {
  return `${groupName} ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

type CodexLimitsSection = Extract<AccountUsageSection, { kind: "codex-limits" }>;

/** Every Codex window across limit groups, labelled with its group for the callout. */
function codexCalloutWindows(section: CodexLimitsSection) {
  const names = new Map(
    (section.snapshot?.data.rateLimits ?? []).map((limit) => [limit.id, limit.name ?? limit.id]),
  );
  return quotaWindowsFromSection(section).map((window) => {
    const limitId = window.windowKey.slice(0, window.windowKey.lastIndexOf(":"));
    return {
      ...window,
      limitId,
      label: qualifiedWindowLabel(names.get(limitId) ?? limitId, window.label),
    };
  });
}

/** Reset credits restore the main Codex allowance only. */
function codexResetWindowName(section: CodexLimitsSection): string {
  return (
    (section.snapshot?.data.rateLimits ?? [])
      .filter((limit) => limit.id === "codex")
      .flatMap((limit) => [limit.primary, limit.secondary])
      .flatMap((window) =>
        window && window.usedPercent >= 100
          ? [codexRateLimitWindowLabel(window, "main Codex allowance")]
          : [],
      )
      .join(" and ") || "the main Codex allowance"
  );
}

/**
 * The reset button joins the callout when the tightest window is an exhausted main
 * Codex window and a credit is available; otherwise it keeps its own row.
 */
function resetCreditInCallout(section: CodexLimitsSection): boolean {
  const credits = section.snapshot?.data.resetCredits;
  if (!credits || credits.availableCount <= 0) return false;
  const tightest = tightestQuotaWindow(codexCalloutWindows(section));
  return tightest !== null && tightest.limitId === "codex" && tightest.usedPercent! >= 100;
}

function hasPaceWindow(windows: ReadonlyArray<QuotaWindow>): boolean {
  return windows.some((window) => window.durationMinutes !== null);
}

function CodexLimits(props: {
  readonly account: UsageAccount;
  readonly section: CodexLimitsSection;
  readonly history: QuotaHistoryIndex | undefined;
}) {
  const snapshot = props.section.snapshot;
  if (!snapshot || snapshot.data.rateLimits.length === 0) return null;
  const allWindows = quotaWindowsFromSection(props.section);
  const windows = new Map(allWindows.map((window) => [window.windowKey, window]));
  const instanceId = props.account.providerInstanceId;
  const resetCredits = snapshot.data.resetCredits;
  const withCredits = snapshot.data.rateLimits.filter((limit) => limit.credits?.hasCredits);
  const creditParts = [
    ...withCredits.map(
      (limit) =>
        `${withCredits.length > 1 ? `${limit.name ?? limit.id} credits` : "Credits"}: ${
          limit.credits!.unlimited ? "Unlimited" : (limit.credits!.balance ?? "—")
        }`,
    ),
    ...(resetCredits && resetCredits.availableCount > 0
      ? [
          `${resetCredits.availableCount} limit reset${resetCredits.availableCount === 1 ? "" : "s"} available`,
        ]
      : []),
  ];
  return (
    <div className="space-y-3 border-t border-border/60 pt-4">
      <TightestLimitCallout
        windows={codexCalloutWindows(props.section)}
        {...(instanceId && resetCreditInCallout(props.section)
          ? {
              action: () => (
                <ResetCreditButton
                  instanceId={instanceId}
                  accountName={props.account.displayName}
                  count={resetCredits!.availableCount}
                  windowName={codexResetWindowName(props.section)}
                />
              ),
            }
          : {})}
      />
      {hasPaceWindow(allWindows) ? <QuotaMeterLegend /> : null}
      {snapshot.data.rateLimits.map((limit) => (
        <div key={limit.id} className="space-y-3">
          <div className="flex items-center gap-2">
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
                durationMinutes={window.durationMinutes}
                {...withHistory(
                  props.history,
                  props.account.key,
                  window.windowKey,
                  window.resetsAt,
                )}
              />
            );
          })}
        </div>
      ))}
      {creditParts.length > 0 ? (
        <p className="text-2xs text-muted-foreground">{creditParts.join(" · ")}</p>
      ) : null}
    </div>
  );
}

/** Claude and generic provider windows: callout, legend, then one row per window. */
function QuotaWindowRows(props: {
  readonly account: UsageAccount;
  readonly windows: ReadonlyArray<QuotaWindow>;
  readonly observedAt: string;
  readonly history: QuotaHistoryIndex | undefined;
}) {
  return (
    <div className="space-y-3">
      <TightestLimitCallout
        windows={props.windows.filter(
          (window) => window.windowKey !== CLAUDE_MONTHLY_SPEND_WINDOW_KEY,
        )}
      />
      {hasPaceWindow(props.windows) ? <QuotaMeterLegend /> : null}
      {props.windows.map((window) => (
        <QuotaMeter
          key={window.windowKey}
          label={window.label}
          utilization={window.usedPercent}
          resetsAt={window.resetsAt}
          observedAt={props.observedAt}
          durationMinutes={window.durationMinutes}
          accessibleName={`${props.account.displayName} · ${window.label}`}
          {...withHistory(props.history, props.account.key, window.windowKey, window.resetsAt)}
        />
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
                  <QuotaWindowRows
                    account={account}
                    windows={quotaWindowsFromSection(section)}
                    observedAt={section.snapshot.fetchedAt}
                    history={history}
                  />
                )}
                {section.kind === "codex-limits" &&
                  section.snapshot?.data.resetCredits &&
                  account.providerInstanceId &&
                  !resetCreditInCallout(section) && (
                    <ResetCreditButton
                      instanceId={account.providerInstanceId}
                      accountName={account.displayName}
                      count={section.snapshot.data.resetCredits.availableCount}
                      windowName={codexResetWindowName(section)}
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
                      <QuotaWindowRows
                        account={account}
                        windows={quotaWindowsFromSection(section)}
                        observedAt={section.snapshot.fetchedAt}
                        history={history}
                      />
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
                            (window) => window.key === CLAUDE_MONTHLY_SPEND_WINDOW_KEY,
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
                    fetchedAt={section.snapshot.fetchedAt}
                    tokenSummary={section.snapshot.data.tokenSummary}
                    dailyUsageBuckets={section.snapshot.data.dailyUsageBuckets}
                  />
                )}
                {section.kind === "codex-limits" && (
                  <CodexLimits account={account} section={section} history={history} />
                )}
              </div>
            ))
          )}
          {account.enabled && account.provider === "claudeAgent" && account.providerInstanceId && (
            <ClaudeUsageAnalysisPanel
              instanceId={account.providerInstanceId}
              analysis={account.usageAnalysis}
            />
          )}
        </div>
      ))}
    </section>
  );
}
