import type {
  ClaudeLimitResetGrant,
  ClaudeLimitResets as ClaudeLimitResetsData,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { type QuotaWindow } from "@t3tools/shared/usageLimit";

import { formatAbsoluteTimeLabel } from "../../lib/relativeTime";
import { tightestQuotaWindow } from "./charts/TightestLimitCallout";
import { ResetCreditButton } from "./ResetCreditButton";

const CLAUDE_LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "Opus weekly limit",
  seven_day_sonnet: "Sonnet weekly limit",
  seven_day_overage_included: "model weekly limits",
  seven_day_oauth_apps: "OAuth apps weekly limit",
  seven_day_cowork: "Cowork weekly limit",
};

const BLOCKED_REASON_LIMITS: Record<string, string> = {
  blocked_five_hour: "five_hour",
  blocked_seven_day: "seven_day",
  blocked_opus: "seven_day_opus",
  blocked_sonnet: "seven_day_sonnet",
};

function claudeLimitLabel(key: string): string {
  return CLAUDE_LIMIT_LABELS[key] ?? "other weekly limit";
}

function joinLabels(labels: ReadonlyArray<string>): string {
  const unique = [...new Set(labels)];
  if (unique.length <= 1) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

/** Why a grant can't be claimed now, or null when it can. */
export function claudeGrantDisabledReason(
  grant: ClaudeLimitResetGrant,
  cooldownUntil: string | null,
): string | null {
  if (grant.usableNow) return null;
  const reason = grant.unavailableReason;
  if (grant.paused || reason === "paused") return "Paused";
  if (reason === "cooldown")
    return cooldownUntil
      ? `Available again ${formatAbsoluteTimeLabel(cooldownUntil)}`
      : "Available again later";
  const blocking = (reason && BLOCKED_REASON_LIMITS[reason]) ?? grant.blocking[0];
  if (blocking || reason?.startsWith("blocked_"))
    return `Blocked by the ${blocking ? claudeLimitLabel(blocking) : "another limit"}`;
  if (reason === "needs_limit" || (reason === null && grant.useRequiresLimit))
    return "Usable once you hit a limit";
  return "Can't be used right now";
}

export function claudeGrantDescription(grant: ClaudeLimitResetGrant, accountName: string): string {
  const clears =
    grant.clears.length > 0
      ? `It clears the ${joinLabels(grant.clears.map(claudeLimitLabel))}.`
      : "It clears your exhausted limits.";
  return [
    `This uses one ${grant.label} for ${accountName}.`,
    clears,
    grant.givesBackWeekly ? "It also gives back weekly usage." : null,
    grant.endsAt ? `Expires ${formatAbsoluteTimeLabel(grant.endsAt)}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The grant that joins the callout: the server's next grant, when it is usable
 * and the tightest live window is exhausted. Otherwise null.
 */
export function claudeCalloutGrant(
  resets: ClaudeLimitResetsData | null | undefined,
  windows: ReadonlyArray<QuotaWindow>,
  nowMs: number,
): ClaudeLimitResetGrant | null {
  if (!resets?.nextGrantId) return null;
  const grant = resets.grants.find((entry) => entry.id === resets.nextGrantId);
  if (!grant || !grant.usableNow || grant.resetsLeft <= 0) return null;
  const tightest = tightestQuotaWindow(windows, nowMs);
  return tightest !== null && tightest.usedPercent! >= 100 ? grant : null;
}

export function ClaudeGrantButton(props: {
  readonly instanceId: ProviderInstanceId;
  readonly accountName: string;
  readonly grant: ClaudeLimitResetGrant;
  readonly cooldownUntil: string | null;
}) {
  const { grant } = props;
  return (
    <ResetCreditButton
      instanceId={props.instanceId}
      accountName={props.accountName}
      count={grant.resetsLeft}
      grantId={grant.id}
      label={grant.label}
      title={`Use a ${grant.label}?`}
      description={claudeGrantDescription(grant, props.accountName)}
      disabledReason={claudeGrantDisabledReason(grant, props.cooldownUntil)}
    />
  );
}

/** One row per Claude limit-reset grant that has resets left. */
export function ClaudeLimitResets(props: {
  readonly instanceId: ProviderInstanceId;
  readonly accountName: string;
  readonly resets: ClaudeLimitResetsData;
  /** Shown in the callout instead of as a row. */
  readonly excludeGrantId?: string | null;
}) {
  const grants = props.resets.grants.filter(
    (grant) => grant.resetsLeft > 0 && grant.id !== props.excludeGrantId,
  );
  if (grants.length === 0) return null;
  return (
    <div className="space-y-2" role="group" aria-label="Limit resets">
      <p className="text-xs font-medium">Limit resets</p>
      {grants.map((grant) => {
        const reason = claudeGrantDisabledReason(grant, props.resets.cooldownUntil);
        const details = [
          grant.endsAt ? `Expires ${formatAbsoluteTimeLabel(grant.endsAt)}` : null,
          reason,
        ].filter(Boolean);
        return (
          <div key={grant.id} className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs">
                {grant.label}
                {grant.resetsTotal > 1 ? ` · ${grant.resetsLeft}` : ""}
              </p>
              {details.length > 0 ? (
                <p className="text-2xs text-muted-foreground">{details.join(" · ")}</p>
              ) : null}
            </div>
            <ClaudeGrantButton
              instanceId={props.instanceId}
              accountName={props.accountName}
              grant={grant}
              cooldownUntil={props.resets.cooldownUntil}
            />
          </div>
        );
      })}
    </div>
  );
}
