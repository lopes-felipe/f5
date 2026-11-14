import type { PrHubChange, PrHubSection, TrackedPullRequest } from "@t3tools/contracts";

/**
 * The facts of a pull request when its viewer last looked at it. Every fact is optional:
 * a baseline written by the migration, or by an older server, may lack some, and a fact
 * that is missing never reports a change.
 */
export interface PrSeenBaseline {
  readonly at: string;
  readonly state?: TrackedPullRequest["state"];
  readonly headRefOid?: string | null;
  readonly commentsCount?: number;
  readonly checkRollup?: TrackedPullRequest["checkRollup"];
  readonly reviewDecision?: TrackedPullRequest["reviewDecision"];
  readonly mergeable?: TrackedPullRequest["mergeable"];
  readonly attentionState?: TrackedPullRequest["attentionState"];
}

/**
 * A row found by search and not yet read in full carries placeholders (checks "pending",
 * no head, no review decision). Comparing against those would report the first full read
 * as activity, so only its state is recorded.
 */
const verified = (pr: TrackedPullRequest) => pr.lastVerifiedAt != null;

export const prSeenBaseline = (pr: TrackedPullRequest, at: string): PrSeenBaseline =>
  verified(pr)
    ? {
        at,
        state: pr.state,
        headRefOid: pr.headRefOid,
        commentsCount: pr.commentsCount,
        checkRollup: pr.checkRollup,
        reviewDecision: pr.reviewDecision,
        mergeable: pr.mergeable,
        attentionState: pr.attentionState,
      }
    : { at, state: pr.state };

export function parsePrSeenBaseline(json: string | null | undefined): PrSeenBaseline | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    // Only strings and a count are kept; a value this server does not know never matches.
    const text = <Value extends string>(key: string) => {
      const field = record[key];
      return typeof field === "string" && field ? { [key]: field as Value } : {};
    };
    const count = record.commentsCount;
    return {
      at: typeof record.at === "string" ? record.at : "",
      ...text<TrackedPullRequest["state"]>("state"),
      ...text("headRefOid"),
      ...(typeof count === "number" && Number.isSafeInteger(count) && count >= 0
        ? { commentsCount: count }
        : {}),
      ...text<TrackedPullRequest["checkRollup"]>("checkRollup"),
      ...text<TrackedPullRequest["reviewDecision"]>("reviewDecision"),
      ...text<TrackedPullRequest["mergeable"]>("mergeable"),
      ...text<TrackedPullRequest["attentionState"]>("attentionState"),
    };
  } catch {
    return null;
  }
}

/** Sections whose pull requests wait for the viewer; only these read as new when never opened. */
const NEEDS_VIEWER: ReadonlySet<PrHubSection> = new Set(["review", "action", "ready"]);
const failing = (rollup: TrackedPullRequest["checkRollup"] | undefined) =>
  rollup === "failure" || rollup === "error";

/**
 * What changed since the viewer last looked, most important first. A pull request never
 * opened is new while it waits for the viewer; elsewhere it stays quiet, so a first sync
 * does not mark a whole team queue unread.
 */
export function prChangesSinceSeen(
  pr: TrackedPullRequest,
  baseline: PrSeenBaseline | null,
  viewerLogin: string | null,
): PrHubChange[] {
  if (!baseline)
    return pr.state === "open" && pr.section && NEEDS_VIEWER.has(pr.section)
      ? [{ kind: "new" }]
      : [];
  if (pr.state !== "open")
    return baseline.state !== undefined && baseline.state !== pr.state ? [{ kind: pr.state }] : [];
  if (!verified(pr)) return [];
  const changes: PrHubChange[] = [];
  // A fact the baseline lacks is unknown, not different.
  const became = (key: "attentionState" | "reviewDecision" | "mergeable", value: string) => {
    const before: string | undefined = baseline[key];
    return pr[key] === value && before !== undefined && before !== value;
  };
  if (became("attentionState", "ready_to_merge")) changes.push({ kind: "ready" });
  if (became("reviewDecision", "changes_requested")) changes.push({ kind: "changes_requested" });
  if (became("reviewDecision", "approved")) changes.push({ kind: "approved" });
  if (
    failing(pr.checkRollup) &&
    baseline.checkRollup !== undefined &&
    !failing(baseline.checkRollup)
  )
    changes.push({ kind: "ci_failed" });
  if (became("mergeable", "conflicting")) changes.push({ kind: "conflict" });
  // The author pushed their own commits; reporting them back is noise.
  const own =
    pr.author !== null &&
    viewerLogin !== null &&
    pr.author.toLowerCase() === viewerLogin.toLowerCase();
  if (!own && baseline.headRefOid && pr.headRefOid && baseline.headRefOid !== pr.headRefOid)
    changes.push({ kind: "commits" });
  if (baseline.commentsCount !== undefined && pr.commentsCount > baseline.commentsCount)
    changes.push({ kind: "comments", count: pr.commentsCount - baseline.commentsCount });
  if (pr.checkRollup === "success" && failing(baseline.checkRollup))
    changes.push({ kind: "ci_passed" });
  return changes;
}
