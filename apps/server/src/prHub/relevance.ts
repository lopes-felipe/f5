import type {
  PrAttentionReason,
  PrHubSnapshot,
  PrReviewRequestSource,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { PR_HUB_NEEDS_YOU_SECTIONS, prAttentionText, prHubSection } from "@t3tools/shared/prHub";

export interface PrHubRelevanceOptions {
  readonly viewerLogin: string | null;
  /** `org/team` slugs whose review requests count as requests to the viewer. */
  readonly directReviewTeams: ReadonlyArray<string>;
  readonly staleAfterDays: number;
  readonly now?: number;
}

const normalizedTeams = (teams: ReadonlyArray<string>) =>
  new Set(teams.map((team) => team.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));

/**
 * Whether a pending review request is the viewer's own or only their team's. Roles carry
 * the provider's proof of a personal request; promoted teams are a viewer preference.
 */
export function prReviewRequestSource(
  pr: Pick<TrackedPullRequest, "viewerReviewRequested" | "roles" | "reviewRequestReviewers">,
  viewerLogin: string | null,
  directReviewTeams: ReadonlySet<string>,
): PrReviewRequestSource | null {
  if (!pr.viewerReviewRequested) return null;
  if (pr.roles.includes("review_requested")) return "direct";
  const reviewers = pr.reviewRequestReviewers.map((reviewer) => reviewer.toLowerCase());
  if (viewerLogin && reviewers.includes(viewerLogin.toLowerCase())) return "direct";
  if (reviewers.some((reviewer) => directReviewTeams.has(reviewer))) return "direct";
  // Without proof of a team request, assume the viewer was asked.
  return pr.roles.includes("team_review_requested") ? "team" : "direct";
}

const isRequestCode = (code: PrAttentionReason["code"]) =>
  code === "review_requested" || code === "re_review_requested";

/**
 * Stamps the review request source and queue section on one pull request, and moves a
 * request between "yours" and "your team's" when the stored attention disagrees. Stored
 * rows predate the distinction and the promoted-team setting can change at any time, so
 * this runs on every read and is idempotent.
 */
export function applyPrRelevance(
  pr: TrackedPullRequest,
  options: PrHubRelevanceOptions,
  directReviewTeams = normalizedTeams(options.directReviewTeams),
): TrackedPullRequest {
  const source = prReviewRequestSource(pr, options.viewerLogin, directReviewTeams);
  let next = pr;
  if (pr.state === "open" && !pr.roles.includes("author") && !pr.repositoryArchived) {
    if (source === "team" && isRequestCode(pr.attentionState)) {
      const request = pr.reasons?.find((reason) => isRequestCode(reason.code));
      const others = pr.reasons?.filter((reason) => !isRequestCode(reason.code)) ?? [];
      const pushed = others.some((reason) => reason.code === "changes_pushed");
      next = pushed
        ? {
            ...pr,
            reasons: others,
            attentionState: "changes_pushed",
            attentionBucket: "needs_you",
            ...prAttentionText("changes_pushed"),
          }
        : {
            ...pr,
            ...(pr.reasons
              ? {
                  reasons: [
                    ...(request
                      ? [
                          {
                            ...request,
                            code: "team_review_requested" as const,
                            actor: "reviewer" as const,
                            action: "review" as const,
                          },
                        ]
                      : []),
                    ...others,
                  ],
                }
              : {}),
            attentionState: "team_review_requested",
            attentionBucket: "informational",
            ...prAttentionText("team_review_requested"),
          };
    } else if (source === "direct" && pr.attentionState === "team_review_requested") {
      const code = pr.viewerHasReviewed ? "re_review_requested" : "review_requested";
      next = {
        ...pr,
        ...(pr.reasons
          ? {
              reasons: pr.reasons.map((reason) =>
                reason.code === "team_review_requested"
                  ? { ...reason, code, actor: "viewer" as const, action: "review" as const }
                  : reason,
              ),
            }
          : {}),
        attentionState: code,
        attentionBucket: "needs_you",
        ...prAttentionText(code),
      };
    }
  }
  const section = prHubSection(
    { ...next, reviewRequestSource: source },
    { now: options.now ?? Date.now(), staleAfterDays: options.staleAfterDays },
  );
  // Only the "needs you" sections notify; a stale or team row never does.
  const notificationPending = next.notificationPending && PR_HUB_NEEDS_YOU_SECTIONS.has(section);
  // Most reads change nothing; keeping the object lets callers skip work by identity.
  if (
    next === pr &&
    (pr.reviewRequestSource ?? null) === source &&
    pr.section === section &&
    pr.notificationPending === notificationPending
  )
    return pr;
  return { ...next, reviewRequestSource: source, section, notificationPending };
}

const mapUnchanged = <T>(items: ReadonlyArray<T>, map: (item: T) => T): ReadonlyArray<T> => {
  let changed = false;
  const mapped = items.map((item) => {
    const next = map(item);
    changed ||= next !== item;
    return next;
  });
  return changed ? mapped : items;
};

export function applyPrHubRelevance(
  snapshot: PrHubSnapshot,
  options: Omit<PrHubRelevanceOptions, "viewerLogin">,
): PrHubSnapshot {
  const teams = normalizedTeams(options.directReviewTeams);
  const resolved = {
    ...options,
    viewerLogin: snapshot.viewerLogin,
    now: options.now ?? Date.now(),
  };
  const project = (pr: TrackedPullRequest) => applyPrRelevance(pr, resolved, teams);
  const pullRequests = mapUnchanged(snapshot.pullRequests, project);
  const recentlyResolved = mapUnchanged(snapshot.recentlyResolved, project);
  return pullRequests === snapshot.pullRequests && recentlyResolved === snapshot.recentlyResolved
    ? snapshot
    : { ...snapshot, pullRequests, recentlyResolved };
}
