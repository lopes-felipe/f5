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
const isOwn = (pr: TrackedPullRequest, viewerLogin: string | null) =>
  pr.author !== null &&
  viewerLogin !== null &&
  pr.author.toLowerCase() === viewerLogin.toLowerCase();

/** Shared, so a row read twice with nothing changed keeps the same array. */
const NEVER_OPENED: readonly PrHubChange[] = [{ kind: "new" }];
const NOTHING: readonly PrHubChange[] = [];
const OWN_NEED = {
  ready: [{ kind: "ready" }],
  changes_requested: [{ kind: "changes_requested" }],
  ci_failed: [{ kind: "ci_failed" }],
  conflict: [{ kind: "conflict" }],
} as const satisfies Record<string, readonly PrHubChange[]>;
const ownComments = new Map<number, readonly PrHubChange[]>();

/**
 * What a pull request never opened shows, for the section it is in now. Sections follow
 * the clock and the settings, so this is settled on every read and not when the snapshot
 * is built: a row reads as new as soon as it waits for the viewer, and stops when it goes
 * stale or moves to the team queue. Elsewhere it stays quiet, so a first sync does not
 * mark a whole team queue unread.
 *
 * The viewer's own pull request is not news to them. It says what it needs instead.
 */
export function settlePrNeverOpened(
  changes: readonly PrHubChange[] | undefined,
  pr: TrackedPullRequest,
  section: PrHubSection,
  viewerLogin: string | null,
): readonly PrHubChange[] | undefined {
  if (changes?.length !== 1 || changes[0]?.kind !== "new") return changes;
  if (!NEEDS_VIEWER.has(section)) return NOTHING;
  if (!isOwn(pr, viewerLogin)) return changes;
  if (pr.attentionState === "ready_to_merge") return OWN_NEED.ready;
  if (pr.reviewDecision === "changes_requested") return OWN_NEED.changes_requested;
  if (failing(pr.checkRollup)) return OWN_NEED.ci_failed;
  if (pr.mergeable === "conflicting") return OWN_NEED.conflict;
  if (pr.commentsCount > 0) {
    const known = ownComments.get(pr.commentsCount);
    if (known) return known;
    const counted = [{ kind: "comments", count: pr.commentsCount }] as const;
    if (ownComments.size < 256) ownComments.set(pr.commentsCount, counted);
    return counted;
  }
  return changes;
}

/**
 * What changed since the viewer last looked, most important first. A pull request never
 * opened carries one marker, which `settlePrNeverOpened` resolves on each read.
 */
export function prChangesSinceSeen(
  pr: TrackedPullRequest,
  baseline: PrSeenBaseline | null,
  viewerLogin: string | null,
): readonly PrHubChange[] {
  if (!baseline) return pr.state === "open" ? NEVER_OPENED : NOTHING;
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
  const own = isOwn(pr, viewerLogin);
  if (!own && baseline.headRefOid && pr.headRefOid && baseline.headRefOid !== pr.headRefOid)
    changes.push({ kind: "commits" });
  if (baseline.commentsCount !== undefined && pr.commentsCount > baseline.commentsCount)
    changes.push({ kind: "comments", count: pr.commentsCount - baseline.commentsCount });
  if (pr.checkRollup === "success" && failing(baseline.checkRollup))
    changes.push({ kind: "ci_passed" });
  return changes;
}
