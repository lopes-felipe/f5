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
import type { ReactNode } from "react";

import { formatAbsoluteTimeLabel } from "../../lib/relativeTime";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { DailyTokenBars } from "./charts/DailyTokenBars";
import { QuotaMeter, QuotaMeterLegend } from "./charts/QuotaMeter";
import { TightestLimitCallout, tightestQuotaWindow } from "./charts/TightestLimitCallout";
import { codexAccountRangeTokens, codexDailyTokenSeries } from "./codexDailyTokens";
import { providerLabel } from "./format";
import { ResetCreditButton } from "./ResetCreditButton";
import { ClaudeGrantButton, ClaudeLimitResets, claudeCalloutGrant } from "./ClaudeLimitResets";
import { ClaudeUsageAnalysisPanel } from "./ClaudeUsageAnalysisPanel";
import { StatTile, UsageSection, UsageSubsection } from "./kit";

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
    <div className="space-y-3">
      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            variant="inset"
            label={`Account tokens · ${
              props.range === "24h" ? "Today (UTC)" : `${props.range} (UTC calendar days)`
            }`}
            value={compactDecimalCount(codexAccountRangeTokens(props))}
          />
          <StatTile
            variant="inset"
            label="Lifetime tokens"
            value={compactDecimalCount(summary.lifetimeTokens)}
          />
          <StatTile
            variant="inset"
            label="Peak daily tokens"
            value={compactDecimalCount(summary.peakDailyTokens)}
          />
          <StatTile
            variant="inset"
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

/**
 * Every Codex window across limit groups, labelled with its group for the callout.
 * The monthly credit limit (`individual`) competes too: unlike Claude's monthly spend
 * meter, the usage gate treats an exhausted `codex:individual` as blocking.
 */
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

/** Reset credits restore the main Codex allowance only; windows already reset are skipped. */
function codexResetWindowName(section: CodexLimitsSection, nowMs: number): string {
  return (
    (section.snapshot?.data.rateLimits ?? [])
      .filter((limit) => limit.id === "codex")
      .flatMap((limit) => [limit.primary, limit.secondary])
      .flatMap((window) =>
        window &&
        window.usedPercent >= 100 &&
        !(window.resetsAt !== null && window.resetsAt * 1000 <= nowMs)
          ? [codexRateLimitWindowLabel(window, "main Codex allowance")]
          : [],
      )
      .join(" and ") || "the main Codex allowance"
  );
}

/**
 * The reset button joins the callout when the tightest live window is an exhausted
 * main Codex window and a credit is available; otherwise it keeps its own row.
 */
function resetCreditInCallout(section: CodexLimitsSection, nowMs: number): boolean {
  const credits = section.snapshot?.data.resetCredits;
  if (!credits || credits.availableCount <= 0) return false;
  const tightest = tightestQuotaWindow(codexCalloutWindows(section), nowMs);
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
  const nowMs = Date.now();
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
    <div className="space-y-3">
      <TightestLimitCallout
        windows={codexCalloutWindows(props.section)}
        {...(instanceId && resetCreditInCallout(props.section, nowMs)
          ? {
              action: () => (
                <ResetCreditButton
                  instanceId={instanceId}
                  accountName={props.account.displayName}
                  count={resetCredits!.availableCount}
                  windowName={codexResetWindowName(props.section, nowMs)}
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
              <Badge size="sm" variant="secondary">
                {limit.planType}
              </Badge>
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

/** The monthly spend meter never competes in the callout. */
function claudeCalloutWindows(windows: ReadonlyArray<QuotaWindow>): Array<QuotaWindow> {
  return windows.filter((window) => window.windowKey !== CLAUDE_MONTHLY_SPEND_WINDOW_KEY);
}

type ClaudeUsageSection = Extract<AccountUsageSection, { kind: "claude-usage" }>;

/** Claude plan windows, with limit-reset buttons in the callout or their own block. */
function ClaudeUsageLimits(props: {
  readonly account: UsageAccount;
  readonly section: ClaudeUsageSection;
  readonly history: QuotaHistoryIndex | undefined;
}) {
  const snapshot = props.section.snapshot;
  if (!snapshot) return null;
  const windows = quotaWindowsFromSection(props.section);
  const instanceId = props.account.providerInstanceId;
  const resets = snapshot.data.limitResets ?? null;
  const calloutGrant =
    instanceId && resets
      ? claudeCalloutGrant(resets, claudeCalloutWindows(windows), Date.now())
      : null;
  return (
    <>
      {windows.length > 0 ? (
        <QuotaWindowRows
          account={props.account}
          windows={windows}
          observedAt={snapshot.fetchedAt}
          history={props.history}
          {...(instanceId && calloutGrant && resets
            ? {
                calloutAction: () => (
                  <ClaudeGrantButton
                    instanceId={instanceId}
                    accountName={props.account.displayName}
                    grant={calloutGrant}
                    cooldownUntil={resets.cooldownUntil}
                  />
                ),
              }
            : {})}
        />
      ) : null}
      {instanceId && resets ? (
        <ClaudeLimitResets
          instanceId={instanceId}
          accountName={props.account.displayName}
          resets={resets}
          excludeGrantId={windows.length > 0 ? (calloutGrant?.id ?? null) : null}
        />
      ) : null}
    </>
  );
}

/** Claude and generic provider windows: callout, legend, then one row per window. */
function QuotaWindowRows(props: {
  readonly account: UsageAccount;
  readonly windows: ReadonlyArray<QuotaWindow>;
  readonly observedAt: string;
  readonly history: QuotaHistoryIndex | undefined;
  /** Rendered inside the callout, e.g. a limit-reset button. */
  readonly calloutAction?: () => ReactNode;
}) {
  return (
    <div className="space-y-3">
      <TightestLimitCallout
        windows={claudeCalloutWindows(props.windows)}
        {...(props.calloutAction ? { action: props.calloutAction } : {})}
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

const SECTION_LABELS: Record<AccountUsageSection["kind"], string> = {
  "codex-tokens": "Token history",
  "codex-limits": "Rate limits",
  "claude-usage": "Claude plan",
  "provider-limits": "Limits",
};

/** "Updated …" plus a restart badge, shown beside a section label. */
function SectionMeta(props: { readonly section: AccountUsageSection }) {
  const { section } = props;
  // A snapshot with no attempt since startup was restored from disk.
  const restored = section.snapshot !== null && section.lastAttemptAt === null;
  return (
    <>
      <span>
        {section.snapshot
          ? `Updated ${formatAbsoluteTimeLabel(section.snapshot.fetchedAt)}`
          : "No successful snapshot yet"}
      </span>
      {restored ? (
        <Badge size="sm" variant="warning">
          Last known before restart
        </Badge>
      ) : null}
    </>
  );
}

/** Why the latest attempt failed, as an inline notice. */
function SectionError(props: {
  readonly account: UsageAccount;
  readonly section: AccountUsageSection;
}) {
  const { account, section } = props;
  if (section.outcome === "available" || (!section.lastAttemptAt && !section.errorCode))
    return null;
  return (
    <Alert variant={section.outcome === "unsupported" ? "default" : "warning"} role="status">
      <AlertDescription className="text-xs">
        {section.outcome === "unsupported"
          ? `This installed ${providerLabel(account.provider)} version does not expose account usage and rate limits.`
          : ACCOUNT_ERROR_MESSAGES[section.errorCode ?? "temporary-failure"]}
        {section.snapshot
          ? ` Showing data from ${formatAbsoluteTimeLabel(section.snapshot.fetchedAt)}.`
          : ""}
      </AlertDescription>
    </Alert>
  );
}

const PROVIDER_NOTES: Partial<Record<UsageAccount["provider"], string>> = {
  codex:
    "Provider-native ChatGPT/Codex account totals and quota windows. These are not dollar costs.",
  claudeAgent: "Configured instance's server-default authentication context.",
};

/** Plan label for an account header: Claude subscription or Codex plan type. */
export function accountPlanLabel(account: UsageAccount): string | null {
  for (const section of account.sections) {
    if (section.kind === "claude-usage" && section.snapshot?.data.subscriptionLabel)
      return section.snapshot.data.subscriptionLabel;
    if (section.kind === "codex-limits") {
      const plan = section.snapshot?.data.rateLimits.find((limit) => limit.planType)?.planType;
      if (plan) return plan;
    }
  }
  return null;
}

export interface AccountGlanceWindow extends QuotaWindow {
  readonly observedAt: string;
}

/**
 * Every live-comparable quota window an account reports, labelled for a compact
 * summary. Claude's monthly spend meter is excluded, as in the callout.
 */
export function accountQuotaWindows(account: UsageAccount): Array<AccountGlanceWindow> {
  return account.sections.flatMap((section): Array<AccountGlanceWindow> => {
    const observedAt = section.snapshot?.fetchedAt;
    if (!observedAt) return [];
    if (section.kind === "codex-limits")
      return codexCalloutWindows(section).map((window) => ({ ...window, observedAt }));
    if (section.kind === "provider-limits" || section.kind === "claude-usage")
      return quotaWindowsFromSection(section)
        .filter((window) => window.windowKey !== CLAUDE_MONTHLY_SPEND_WINDOW_KEY)
        .map((window) => ({ ...window, observedAt }));
    return [];
  });
}

/** The account's newest snapshot time, or null. */
export function accountUpdatedAt(account: UsageAccount): string | null {
  let latest: string | null = null;
  for (const section of account.sections)
    if (section.snapshot && (!latest || section.snapshot.fetchedAt > latest))
      latest = section.snapshot.fetchedAt;
  return latest;
}

/** Status text for an account with nothing to meter, or null when it has data. */
export function accountStatusText(account: UsageAccount): string | null {
  if (!account.enabled)
    return `${providerLabel(account.provider)} is disabled in provider settings.`;
  for (const section of account.sections) {
    if (section.outcome === "unsupported")
      return `This installed ${providerLabel(account.provider)} version does not expose account usage and rate limits.`;
    if (section.errorCode) return ACCOUNT_ERROR_MESSAGES[section.errorCode];
  }
  const claude = account.sections.find((section) => section.kind === "claude-usage");
  if (claude?.kind === "claude-usage" && claude.snapshot && !claude.snapshot.data.limitsAvailable)
    return "Plan limits aren't reported for this Claude session.";
  return account.sections.some((section) => section.snapshot)
    ? "No quota windows reported."
    : "No successful snapshot yet.";
}

export function accountNeedsAuthentication(account: UsageAccount): boolean {
  return account.sections.some((section) => section.errorCode === "authentication-required");
}

export function accountSectionId(account: UsageAccount): string {
  // Hex-escape instead of collapsing, so `a:b` and `a-b` stay distinct ids.
  return `usage-account-${account.key.replace(
    /[^a-zA-Z0-9-]/g,
    (char) => `_${char.codePointAt(0)!.toString(16)}_`,
  )}`;
}

function AccountSectionBody(props: {
  readonly account: UsageAccount;
  readonly section: AccountUsageSection;
  readonly range: UsageRange;
  readonly history: QuotaHistoryIndex | undefined;
}) {
  const { account, section, history } = props;
  return (
    <>
      <SectionError account={account} section={section} />
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
        !resetCreditInCallout(section, Date.now()) && (
          <ResetCreditButton
            instanceId={account.providerInstanceId}
            accountName={account.displayName}
            count={section.snapshot.data.resetCredits.availableCount}
            windowName={codexResetWindowName(section, Date.now())}
          />
        )}
      {section.kind === "claude-usage" && section.snapshot && (
        <div className="space-y-3">
          {!section.snapshot.data.limitsAvailable ? (
            <p className="text-xs text-muted-foreground">
              Plan limits aren't reported for this Claude session.
            </p>
          ) : (
            <>
              {section.snapshot.data.windows.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Account usage is temporarily unavailable.
                </p>
              ) : null}
              <ClaudeUsageLimits account={account} section={section} history={history} />
            </>
          )}
          {section.snapshot.data.extraUsage && (
            <div className="space-y-2">
              <p className="text-xs">
                Extra usage {section.snapshot.data.extraUsage.enabled ? "enabled" : "disabled"}
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
          range={props.range}
          fetchedAt={section.snapshot.fetchedAt}
          tokenSummary={section.snapshot.data.tokenSummary}
          dailyUsageBuckets={section.snapshot.data.dailyUsageBuckets}
        />
      )}
      {section.kind === "codex-limits" && (
        <CodexLimits account={account} section={section} history={history} />
      )}
    </>
  );
}

/** One account as a section; its snapshot groups are subsections. */
export function AccountUsageCard(props: {
  readonly account: UsageAccount;
  readonly range: UsageRange;
  readonly history?: QuotaHistoryIndex | undefined;
}) {
  const { account } = props;
  const plan = accountPlanLabel(account);
  return (
    <UsageSection
      id={accountSectionId(account)}
      aria-label={account.displayName}
      title={
        <span className="inline-flex items-center gap-2">
          <span>{account.displayName}</span>
          {plan ? (
            <Badge size="sm" variant="secondary">
              {plan}
            </Badge>
          ) : null}
        </span>
      }
      info={PROVIDER_NOTES[account.provider]}
      infoLabel={`About ${account.displayName}`}
      actions={
        <span role="status">
          {account.refreshState === "idle" ? null : (
            <Badge size="sm" variant="info">
              {account.refreshState === "queued" ? "Queued" : "Refreshing…"}
            </Badge>
          )}
        </span>
      }
    >
      <div className="space-y-3">
        {!account.enabled ? (
          <p className="text-xs text-muted-foreground">
            {providerLabel(account.provider)} is disabled in provider settings.
          </p>
        ) : (
          account.sections.map((section, index) => (
            <UsageSubsection
              key={section.kind}
              first={index === 0}
              label={SECTION_LABELS[section.kind]}
              meta={<SectionMeta section={section} />}
            >
              <AccountSectionBody
                account={account}
                section={section}
                range={props.range}
                history={props.history}
              />
            </UsageSubsection>
          ))
        )}
        {account.enabled && account.provider === "claudeAgent" && account.providerInstanceId && (
          <ClaudeUsageAnalysisPanel
            instanceId={account.providerInstanceId}
            analysis={account.usageAnalysis}
          />
        )}
      </div>
    </UsageSection>
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
    <section aria-label="Account usage and limits" className="flex flex-col gap-4">
      {accounts.map((account) => (
        <AccountUsageCard key={account.key} account={account} range={range} history={history} />
      ))}
    </section>
  );
}
