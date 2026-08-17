import os from "node:os";
import { createHash } from "node:crypto";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  PullRequestKey,
  type PrCheckRollup,
  type PrHubAdvisory,
  type PrHubAdvisoryCommentFinding,
  type PrHubAdvisoryCommentValidity,
  type PrHubAdvisoryRecommendation,
  type PrHubAdvisorySnapshot,
  type PrHubAdvisoryStatus,
  type PrHubAnalyzeAdvisoriesInput,
  type PrHubGetAdvisoriesInput,
  type ModelSelection,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { Cause, Effect, Exit, Layer, PubSub, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeGitHubSourceControlProvider } from "../../sourceControl/GitHubSourceControlProvider.ts";
import { makeSourceControlProviderRegistry } from "../../sourceControl/SourceControlProvider.ts";
import { PrHubService } from "../Services/PrHubService.ts";
import {
  PrHubAdvisoryService,
  type PrHubAdvisoryServiceShape,
} from "../Services/PrHubAdvisoryService.ts";

const DEFAULT_HOST = process.env.GH_HOST?.trim() || "github.com";
const REVIEW_THREAD_FINDING_LIMIT = 20;
const ISSUE_COMMENT_FINDING_LIMIT = 10;
const ADVISORY_ANALYSIS_CONCURRENCY = 3;
const ADVISORY_MODEL_ANALYSIS_OPERATION = "generatePrHubAdvisory";
const ADVISORY_PROMPT_FACTS_MAX_CHARS = 80_000;
const ADVISORY_PROMPT_COMMENT_MAX_CHARS = 1_500;
const ADVISORY_PROMPT_DIFF_MAX_CHARS = 2_000;

const ADVISORY_DEFAULT_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  DEFAULT_MODEL_BY_PROVIDER.codex,
  [{ id: "reasoningEffort", value: "high" }],
);

const ADVISORY_RECOMMENDATIONS = [
  "fix_ci",
  "wait_for_ci",
  "resolve_conflicts",
  "address_review_feedback",
  "clarify_feedback",
  "wait_for_reviewers",
  "re_request_review",
  "ready_to_merge",
  "review_requested",
  "no_action",
] as const satisfies ReadonlyArray<PrHubAdvisoryRecommendation>;

const ADVISORY_FINDING_VALIDITIES = [
  "valid",
  "invalid",
  "unclear",
  "already_addressed",
  "needs_human_judgment",
] as const satisfies ReadonlyArray<PrHubAdvisoryCommentValidity>;

const HARD_BLOCKER_RECOMMENDATIONS = new Set<PrHubAdvisoryRecommendation>([
  "resolve_conflicts",
  "fix_ci",
  "wait_for_ci",
]);

const AdvisoryModelOutput = Schema.Struct({
  recommendation: Schema.Literals(ADVISORY_RECOMMENDATIONS),
  summary: Schema.String,
  confidence: Schema.Number,
  blockers: Schema.Array(Schema.String),
  findings: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      validity: Schema.Literals(ADVISORY_FINDING_VALIDITIES),
      summary: Schema.String,
      rationale: Schema.String,
      category: Schema.String,
    }),
  ),
});

type AdvisoryModelOutput = typeof AdvisoryModelOutput.Type;

interface AdvisoryRow {
  readonly key: string;
  readonly fingerprint: string;
  readonly status: PrHubAdvisoryStatus;
  readonly recommendation: PrHubAdvisoryRecommendation;
  readonly summary: string;
  readonly confidence: number;
  readonly blockers_json: string;
  readonly findings_json: string;
  readonly degraded: number;
  readonly truncated: number;
  readonly generated_at: string | null;
  readonly error_kind: string | null;
  readonly error_message: string | null;
  readonly payload_json: string;
}

interface ReviewCommentFact {
  readonly id: string;
  readonly url: string;
  readonly author: string | null;
  readonly bodyText: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly outdated: boolean;
  readonly diffHunk: string | null;
}

interface ReviewThreadFact {
  readonly id: string;
  readonly isResolved: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly comments: ReadonlyArray<ReviewCommentFact>;
}

interface IssueCommentFact {
  readonly id: string;
  readonly url: string;
  readonly author: string | null;
  readonly bodyText: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

interface ReviewFact {
  readonly id: string;
  readonly state: string;
  readonly author: string | null;
  readonly bodyText: string;
  readonly submittedAt: string | null;
  readonly url: string | null;
}

interface CheckContextFact {
  readonly name: string;
  readonly state: string;
  readonly url: string | null;
}

export interface PrHubAdvisoryFacts {
  readonly pr: TrackedPullRequest;
  readonly viewerLogin: string | null;
  readonly bodyText: string | null;
  readonly reviewThreads: ReadonlyArray<ReviewThreadFact>;
  readonly issueComments: ReadonlyArray<IssueCommentFact>;
  readonly latestReviews: ReadonlyArray<ReviewFact>;
  readonly checkContexts: ReadonlyArray<CheckContextFact>;
  readonly truncated: boolean;
}

function accountCwd(fallback: string): string {
  const home = os.homedir();
  return home && home.trim().length > 0 ? home : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nodeArray(connection: unknown): Record<string, unknown>[] {
  return asArray(asRecord(connection)?.nodes)
    .map(asRecord)
    .filter((node): node is Record<string, unknown> => node !== null);
}

function totalCount(connection: unknown): number {
  return numberValue(asRecord(connection)?.totalCount) ?? nodeArray(connection).length;
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseFindings(value: string | null | undefined): PrHubAdvisoryCommentFinding[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is PrHubAdvisoryCommentFinding => {
          const record = asRecord(entry);
          return (
            record !== null &&
            typeof record.id === "string" &&
            typeof record.url === "string" &&
            typeof record.category === "string" &&
            typeof record.validity === "string" &&
            typeof record.summary === "string" &&
            typeof record.rationale === "string"
          );
        })
      : [];
  } catch {
    return [];
  }
}

function keyParts(pr: TrackedPullRequest): {
  readonly provider: TrackedPullRequest["provider"];
  readonly host: string;
  readonly repo: string;
  readonly number: number;
} {
  return {
    provider: pr.provider,
    host: pr.host,
    repo: pr.repository.nameWithOwner,
    number: pr.number,
  };
}

function isSnoozed(pr: TrackedPullRequest): boolean {
  if (!pr.snoozedUntil) return false;
  const timestamp = new Date(pr.snoozedUntil).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function isActiveDefaultTarget(pr: TrackedPullRequest): boolean {
  return pr.state === "open" && pr.ignoredAt === null && !isSnoozed(pr);
}

export function prHubAdvisoryFingerprint(pr: TrackedPullRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        key: pr.key,
        updatedAt: pr.updatedAt,
        attentionFingerprint: pr.attentionFingerprint,
        headRefOid: pr.headRefOid,
        checkRollup: pr.checkRollup,
        reviewDecision: pr.reviewDecision,
        mergeable: pr.mergeable,
        mergeStateStatus: pr.mergeStateStatus,
        commentsCount: pr.commentsCount,
        unresolvedThreadCount: pr.unresolvedThreadCount,
      }),
    )
    .digest("hex");
}

function truncateText(input: string, maxLength: number): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3).trimEnd()}...`;
}

function hasAny(input: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function classifyComment(input: {
  readonly bodyText: string;
  readonly isResolved: boolean;
  readonly outdated: boolean;
}): PrHubAdvisoryCommentValidity {
  const body = input.bodyText.toLowerCase();
  if (input.isResolved || input.outdated) return "already_addressed";
  if (hasAny(body, [/false alarm/, /never mind/, /\bnvm\b/, /ignore this/, /not needed/])) {
    return "invalid";
  }
  if (hasAny(body, [/\bnit\b/, /\bquestion\b/, /\bwdyt\b/, /\bmaybe\b/, /\bconsider\b/])) {
    return "unclear";
  }
  if (
    hasAny(body, [
      /\bbug\b/,
      /\bbroken\b/,
      /\bincorrect\b/,
      /\bwrong\b/,
      /\bmust\b/,
      /\bneed(s|ed)?\b/,
      /\bshould\b/,
      /\bfail(ing|ed)?\b/,
      /\bsecurity\b/,
      /\brace\b/,
      /\bcrash\b/,
      /\bconflict\b/,
      /\btypecheck\b/,
      /\blint\b/,
      /\btest(s|ing)?\b/,
    ])
  ) {
    return "valid";
  }
  return "needs_human_judgment";
}

function rationaleForValidity(validity: PrHubAdvisoryCommentValidity): string {
  switch (validity) {
    case "valid":
      return "The comment contains concrete blocking or corrective language.";
    case "invalid":
      return "The comment appears to retract itself or explicitly says it can be ignored.";
    case "unclear":
      return "The comment looks optional or exploratory and needs human judgment.";
    case "already_addressed":
      return "The thread is resolved or the comment is outdated.";
    case "needs_human_judgment":
      return "The comment is unresolved but cannot be validated safely with deterministic signals.";
  }
}

function findingFromReviewComment(
  thread: ReviewThreadFact,
  comment: ReviewCommentFact,
): PrHubAdvisoryCommentFinding {
  const validity = classifyComment({
    bodyText: comment.bodyText,
    isResolved: thread.isResolved,
    outdated: comment.outdated,
  });
  const location = [thread.path, thread.line ?? thread.originalLine]
    .filter((part) => part !== null && part !== undefined)
    .join(":");
  return {
    id: comment.id,
    url: comment.url,
    author: comment.author,
    category: "review_thread",
    validity,
    summary: truncateText(location ? `${location}: ${comment.bodyText}` : comment.bodyText, 180),
    rationale: rationaleForValidity(validity),
  };
}

function findingFromIssueComment(comment: IssueCommentFact): PrHubAdvisoryCommentFinding {
  const validity = classifyComment({
    bodyText: comment.bodyText,
    isResolved: false,
    outdated: false,
  });
  return {
    id: comment.id,
    url: comment.url,
    author: comment.author,
    category: "issue_comment",
    validity,
    summary: truncateText(comment.bodyText, 180),
    rationale: rationaleForValidity(validity),
  };
}

function collectFindings(facts: PrHubAdvisoryFacts): PrHubAdvisoryCommentFinding[] {
  const findings: PrHubAdvisoryCommentFinding[] = [];
  for (const thread of facts.reviewThreads) {
    for (const comment of thread.comments) {
      if (findings.length >= REVIEW_THREAD_FINDING_LIMIT) break;
      findings.push(findingFromReviewComment(thread, comment));
    }
    if (findings.length >= REVIEW_THREAD_FINDING_LIMIT) break;
  }

  const blockingIssueComments = facts.issueComments
    .filter((comment) =>
      hasAny(comment.bodyText.toLowerCase(), [
        /\bci\b/,
        /\bcheck(s)?\b/,
        /\bfail(ing|ed)?\b/,
        /\bconflict\b/,
        /\brebase\b/,
        /\bblocked\b/,
        /\bsecurity\b/,
      ]),
    )
    .slice(0, ISSUE_COMMENT_FINDING_LIMIT);
  for (const comment of blockingIssueComments) {
    findings.push(findingFromIssueComment(comment));
  }
  return findings;
}

function isConflict(pr: TrackedPullRequest): boolean {
  const mergeState = pr.mergeStateStatus.trim().toUpperCase();
  return pr.mergeable === "conflicting" || mergeState === "DIRTY";
}

function isFailedCheckState(state: string): boolean {
  return [
    "FAILURE",
    "ERROR",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ].includes(state.trim().toUpperCase());
}

function isPendingCheckState(state: string): boolean {
  return ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(
    state.trim().toUpperCase(),
  );
}

function isFailureRollup(checkRollup: PrCheckRollup): boolean {
  return checkRollup === "failure" || checkRollup === "error";
}

function checkContextNames(
  contexts: ReadonlyArray<CheckContextFact>,
  predicate: (state: string) => boolean,
): string[] {
  return contexts.filter((context) => predicate(context.state)).map((context) => context.name);
}

function recentEnoughForRerequest(updatedAt: string): boolean {
  const timestamp = new Date(updatedAt).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000;
}

function makeAdvisory(input: {
  readonly pr: TrackedPullRequest;
  readonly status?: PrHubAdvisoryStatus;
  readonly recommendation: PrHubAdvisoryRecommendation;
  readonly summary: string;
  readonly confidence: number;
  readonly blockers?: ReadonlyArray<string>;
  readonly findings?: ReadonlyArray<PrHubAdvisoryCommentFinding>;
  readonly fingerprint?: string;
  readonly generatedAt?: string | null;
  readonly stale?: boolean;
  readonly degraded?: boolean;
  readonly truncated?: boolean;
  readonly errorKind?: string | undefined;
  readonly errorMessage?: string | undefined;
}): PrHubAdvisory {
  return {
    key: input.pr.key,
    status: input.status ?? "succeeded",
    recommendation: input.recommendation,
    summary: input.summary,
    confidence: Math.max(0, Math.min(100, Math.round(input.confidence))),
    blockers: [...(input.blockers ?? [])],
    findings: [...(input.findings ?? [])],
    fingerprint: input.fingerprint ?? prHubAdvisoryFingerprint(input.pr),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    stale: input.stale ?? false,
    degraded: input.degraded ?? false,
    truncated: input.truncated ?? false,
    ...(input.errorKind ? { errorKind: input.errorKind } : {}),
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

function transitionalAdvisory(pr: TrackedPullRequest, status: "queued" | "running"): PrHubAdvisory {
  return makeAdvisory({
    pr,
    status,
    recommendation: "no_action",
    summary: status === "queued" ? "Queued for read-only analysis." : "Analyzing PR comments.",
    confidence: 0,
    generatedAt: null,
  });
}

function failedAdvisory(input: {
  readonly pr: TrackedPullRequest;
  readonly errorKind: string;
  readonly errorMessage: string;
}): PrHubAdvisory {
  return makeAdvisory({
    pr: input.pr,
    status: "failed",
    recommendation: "no_action",
    summary: "Could not analyze this pull request.",
    confidence: 0,
    degraded: true,
    errorKind: input.errorKind,
    errorMessage: input.errorMessage,
  });
}

export function derivePrHubAdvisory(facts: PrHubAdvisoryFacts): PrHubAdvisory {
  const { pr } = facts;
  const isAuthor =
    pr.roles.includes("author") ||
    (facts.viewerLogin !== null && pr.author?.toLowerCase() === facts.viewerLogin.toLowerCase());
  const findings = collectFindings(facts);
  const actionableFindings = findings.filter(
    (finding) =>
      finding.validity === "valid" ||
      finding.validity === "unclear" ||
      finding.validity === "needs_human_judgment",
  );
  const failedChecks = checkContextNames(facts.checkContexts, isFailedCheckState);
  const pendingChecks = checkContextNames(facts.checkContexts, isPendingCheckState);
  const changeRequestReviews = facts.latestReviews.filter(
    (review) => review.state.trim().toUpperCase() === "CHANGES_REQUESTED",
  );
  const blockers: string[] = [];

  if (isConflict(pr)) {
    return makeAdvisory({
      pr,
      recommendation: "resolve_conflicts",
      summary: "Resolve merge conflicts before continuing.",
      confidence: 95,
      blockers: ["Merge conflicts"],
      findings,
      truncated: facts.truncated,
    });
  }

  if (isFailureRollup(pr.checkRollup) || failedChecks.length > 0) {
    blockers.push(...(failedChecks.length > 0 ? failedChecks : ["CI failed"]));
    return makeAdvisory({
      pr,
      recommendation: "fix_ci",
      summary: "Fix failing CI before requesting more review.",
      confidence: 90,
      blockers,
      findings,
      truncated: facts.truncated,
    });
  }

  if (pr.checkRollup === "pending" || pendingChecks.length > 0) {
    blockers.push(...(pendingChecks.length > 0 ? pendingChecks : ["CI pending"]));
    return makeAdvisory({
      pr,
      recommendation: "wait_for_ci",
      summary: "Wait for CI to finish before taking action.",
      confidence: 85,
      blockers,
      findings,
      truncated: facts.truncated,
    });
  }

  if (isAuthor && pr.isDraft) {
    return makeAdvisory({
      pr,
      recommendation: "no_action",
      summary: "Draft PR; finish the changes and mark it ready when appropriate.",
      confidence: 80,
      blockers: ["Draft"],
      findings,
      truncated: facts.truncated,
    });
  }

  if (isAuthor && (pr.reviewDecision === "changes_requested" || changeRequestReviews.length > 0)) {
    blockers.push(
      changeRequestReviews.length > 0
        ? `Changes requested by ${changeRequestReviews
            .map((review) => review.author)
            .filter(Boolean)
            .join(", ")}`
        : "Changes requested",
    );
    return makeAdvisory({
      pr,
      recommendation: "address_review_feedback",
      summary:
        actionableFindings.length > 0
          ? "Address unresolved review feedback before re-requesting review."
          : "Address requested changes before re-requesting review.",
      confidence: actionableFindings.length > 0 ? 88 : 78,
      blockers,
      findings,
      truncated: facts.truncated,
    });
  }

  if (isAuthor && actionableFindings.length > 0) {
    return makeAdvisory({
      pr,
      recommendation: "address_review_feedback",
      summary: "Review unresolved feedback and address or clarify it.",
      confidence: 76,
      blockers: [`${actionableFindings.length} unresolved comment(s)`],
      findings,
      truncated: facts.truncated,
    });
  }

  if (!isAuthor && pr.viewerReviewRequested) {
    return makeAdvisory({
      pr,
      recommendation: "review_requested",
      summary: "Review requested; inspect the PR and leave review feedback.",
      confidence: 88,
      blockers: [],
      findings,
      truncated: facts.truncated,
    });
  }

  if (isAuthor && pr.attentionState === "ready_to_merge") {
    return makeAdvisory({
      pr,
      recommendation: "ready_to_merge",
      summary: "PR appears ready to merge.",
      confidence: 90,
      blockers: [],
      findings,
      truncated: facts.truncated,
    });
  }

  if (isAuthor) {
    const reviewers = pr.reviewRequestReviewers.length;
    const oldEnough = recentEnoughForRerequest(pr.updatedAt);
    return makeAdvisory({
      pr,
      recommendation: reviewers > 0 && oldEnough ? "re_request_review" : "wait_for_reviewers",
      summary:
        reviewers > 0 && oldEnough
          ? "PR is waiting on reviewers and has been quiet; consider re-requesting review."
          : "PR is waiting on reviewers.",
      confidence: reviewers > 0 && oldEnough ? 72 : 82,
      blockers: reviewers > 0 ? pr.reviewRequestReviewers : ["Review pending"],
      findings,
      truncated: facts.truncated,
    });
  }

  if (actionableFindings.length > 0) {
    return makeAdvisory({
      pr,
      recommendation: "clarify_feedback",
      summary: "You are involved; review the unresolved discussion and clarify if needed.",
      confidence: 65,
      blockers: [`${actionableFindings.length} unresolved comment(s)`],
      findings,
      truncated: facts.truncated,
    });
  }

  return makeAdvisory({
    pr,
    recommendation: "no_action",
    summary: "No immediate action is suggested from the available signals.",
    confidence: 70,
    blockers: [],
    findings,
    truncated: facts.truncated,
  });
}

function limitPromptText(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength - 14).trimEnd()}\n[truncated]`;
}

function promptFacts(facts: PrHubAdvisoryFacts): unknown {
  const pr = facts.pr;
  return {
    viewerLogin: facts.viewerLogin,
    pr: {
      key: pr.key,
      repository: pr.repository.nameWithOwner,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      roles: pr.roles,
      isDraft: pr.isDraft,
      state: pr.state,
      attentionState: pr.attentionState,
      attentionBucket: pr.attentionBucket,
      nextAction: pr.nextAction,
      checkRollup: pr.checkRollup,
      reviewDecision: pr.reviewDecision,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      viewerHasReviewed: pr.viewerHasReviewed,
      viewerReviewRequested: pr.viewerReviewRequested,
      reviewRequestReviewers: pr.reviewRequestReviewers,
      commentsCount: pr.commentsCount,
      unresolvedThreadCount: pr.unresolvedThreadCount,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      labels: pr.labels,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    },
    bodyText: facts.bodyText ? limitPromptText(facts.bodyText, 6_000) : null,
    checkContexts: facts.checkContexts,
    latestReviews: facts.latestReviews.map((review) => ({
      ...review,
      bodyText: limitPromptText(review.bodyText, ADVISORY_PROMPT_COMMENT_MAX_CHARS),
    })),
    issueComments: facts.issueComments.map((comment) => ({
      ...comment,
      bodyText: limitPromptText(comment.bodyText, ADVISORY_PROMPT_COMMENT_MAX_CHARS),
    })),
    reviewThreads: facts.reviewThreads.map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      path: thread.path,
      line: thread.line,
      originalLine: thread.originalLine,
      comments: thread.comments.map((comment) => ({
        ...comment,
        bodyText: limitPromptText(comment.bodyText, ADVISORY_PROMPT_COMMENT_MAX_CHARS),
        diffHunk: comment.diffHunk
          ? limitPromptText(comment.diffHunk, ADVISORY_PROMPT_DIFF_MAX_CHARS)
          : null,
      })),
    })),
    truncated: facts.truncated,
  };
}

function buildAdvisoryPrompt(facts: PrHubAdvisoryFacts, baseline: PrHubAdvisory): string {
  const factsJson = limitPromptText(
    JSON.stringify(promptFacts(facts), null, 2),
    ADVISORY_PROMPT_FACTS_MAX_CHARS,
  );
  const baselineJson = JSON.stringify(
    {
      recommendation: baseline.recommendation,
      summary: baseline.summary,
      confidence: baseline.confidence,
      blockers: baseline.blockers,
      findings: baseline.findings,
    },
    null,
    2,
  );

  return [
    "You are a read-only pull request advisory analyst.",
    "Return a JSON object matching the provided schema.",
    "Use only the supplied GitHub facts. Do not assume repository state, local code state, or reviewer intent that is not present in the facts.",
    "Pick the next suggested action for the authenticated viewer.",
    "Hard precedence: merge conflicts, failed CI, and pending CI must not be downgraded to review, merge, or no-action recommendations.",
    "For comment findings, only use ids that appear in the supplied facts. If a comment is ambiguous, use needs_human_judgment instead of claiming it is valid or invalid.",
    "Keep the summary concise and actionable. Keep blockers short.",
    "",
    "Recommendation values:",
    ADVISORY_RECOMMENDATIONS.join(", "),
    "",
    "Baseline deterministic advisory:",
    baselineJson,
    "",
    "GitHub facts:",
    factsJson,
  ].join("\n");
}

function modelSelectionEquals(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
): boolean {
  return (
    left?.instanceId === right?.instanceId &&
    left?.model === right?.model &&
    JSON.stringify(left?.options ?? []) === JSON.stringify(right?.options ?? [])
  );
}

function resolveAdvisoryModelSelection(settingsSelection: ModelSelection): ModelSelection {
  return modelSelectionEquals(
    settingsSelection,
    DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
  )
    ? ADVISORY_DEFAULT_MODEL_SELECTION
    : settingsSelection;
}

function commentFindingLookup(
  facts: PrHubAdvisoryFacts,
): ReadonlyMap<string, PrHubAdvisoryCommentFinding> {
  const byId = new Map<string, PrHubAdvisoryCommentFinding>();
  for (const thread of facts.reviewThreads) {
    for (const comment of thread.comments) {
      if (!comment.id) continue;
      byId.set(comment.id, findingFromReviewComment(thread, comment));
    }
  }
  for (const comment of facts.issueComments) {
    if (!comment.id) continue;
    byId.set(comment.id, findingFromIssueComment(comment));
  }
  return byId;
}

function uniqueStrings(values: ReadonlyArray<string>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    out.push(compact);
    if (out.length >= limit) break;
  }
  return out;
}

function advisoryFromModelOutput(input: {
  readonly facts: PrHubAdvisoryFacts;
  readonly baseline: PrHubAdvisory;
  readonly output: AdvisoryModelOutput;
}): PrHubAdvisory {
  const { baseline, facts, output } = input;
  const hardBaseline = HARD_BLOCKER_RECOMMENDATIONS.has(baseline.recommendation);
  const recommendation =
    hardBaseline && output.recommendation !== baseline.recommendation
      ? baseline.recommendation
      : output.recommendation;
  const summary =
    hardBaseline && output.recommendation !== baseline.recommendation
      ? baseline.summary
      : truncateText(output.summary, 220) || baseline.summary;
  const confidence =
    hardBaseline && output.recommendation !== baseline.recommendation
      ? baseline.confidence
      : output.confidence;
  const blockers =
    hardBaseline || output.blockers.length === 0
      ? uniqueStrings([...baseline.blockers, ...output.blockers], 12)
      : uniqueStrings(output.blockers, 12);
  const factFindingById = commentFindingLookup(facts);
  const modelFindings = output.findings
    .map((finding) => {
      const base = factFindingById.get(finding.id);
      if (!base) return null;
      const summary = truncateText(finding.summary, 220);
      const rationale = truncateText(finding.rationale, 260);
      return {
        ...base,
        category: finding.category?.trim() || base.category,
        validity: finding.validity,
        summary: summary || base.summary,
        rationale: rationale || rationaleForValidity(finding.validity),
      } satisfies PrHubAdvisoryCommentFinding;
    })
    .filter((finding): finding is PrHubAdvisoryCommentFinding => finding !== null);

  return makeAdvisory({
    pr: facts.pr,
    recommendation,
    summary,
    confidence,
    blockers,
    findings: modelFindings.length > 0 ? modelFindings : baseline.findings,
    truncated: facts.truncated,
  });
}

function advisoryFromRow(
  row: AdvisoryRow,
  fingerprintByKey: ReadonlyMap<string, string>,
): PrHubAdvisory | null {
  try {
    const parsed = JSON.parse(row.payload_json);
    const payload = asRecord(parsed);
    if (!payload) return null;
    const currentFingerprint = fingerprintByKey.get(row.key);
    const stale =
      currentFingerprint !== undefined &&
      row.status !== "queued" &&
      row.status !== "running" &&
      currentFingerprint !== row.fingerprint;
    return {
      key: PullRequestKey.makeUnsafe(row.key),
      status: stale ? "stale" : row.status,
      recommendation: row.recommendation,
      summary: row.summary,
      confidence: Math.max(0, Math.round(row.confidence)),
      blockers: parseJsonArray(row.blockers_json),
      findings: parseFindings(row.findings_json),
      fingerprint: row.fingerprint,
      generatedAt: row.generated_at,
      stale,
      degraded: row.degraded === 1,
      truncated: row.truncated === 1,
      ...(row.error_kind ? { errorKind: row.error_kind } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
    };
  } catch {
    return null;
  }
}

const PR_ADVISORY_BY_NODE_QUERY = `
query PrHubAdvisoryByNode($id:ID!){
  node(id:$id){
    ... on PullRequest {
      ...PrHubAdvisoryFields
    }
  }
}
fragment PrHubAdvisoryFields on PullRequest {
  id
  number
  title
  url
  state
  isDraft
  bodyText
  mergeable
  reviewDecision
  mergeStateStatus
  createdAt
  updatedAt
  baseRefName
  headRefName
  headRefOid
  additions
  deletions
  changedFiles
  author { login }
  repository { nameWithOwner }
  comments(first:50, orderBy:{field:UPDATED_AT,direction:DESC}) {
    totalCount
    nodes { id bodyText url author { login } createdAt updatedAt }
  }
  reviewThreads(first:100) {
    totalCount
    nodes {
      id
      isResolved
      path
      line
      originalLine
      comments(first:20) {
        totalCount
        nodes { id bodyText url author { login } createdAt updatedAt outdated diffHunk }
      }
    }
  }
  latestReviews(first:50) {
    nodes { id state bodyText author { login } submittedAt url }
  }
  files(first:100) {
    totalCount
    nodes { path additions deletions }
  }
  commits(last:1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          state
          contexts(first:50) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
}
`;

const PR_ADVISORY_BY_NUMBER_QUERY = `
query PrHubAdvisoryByNumber($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      ...PrHubAdvisoryFields
    }
  }
}
fragment PrHubAdvisoryFields on PullRequest {
  id
  number
  title
  url
  state
  isDraft
  bodyText
  mergeable
  reviewDecision
  mergeStateStatus
  createdAt
  updatedAt
  baseRefName
  headRefName
  headRefOid
  additions
  deletions
  changedFiles
  author { login }
  repository { nameWithOwner }
  comments(first:50, orderBy:{field:UPDATED_AT,direction:DESC}) {
    totalCount
    nodes { id bodyText url author { login } createdAt updatedAt }
  }
  reviewThreads(first:100) {
    totalCount
    nodes {
      id
      isResolved
      path
      line
      originalLine
      comments(first:20) {
        totalCount
        nodes { id bodyText url author { login } createdAt updatedAt outdated diffHunk }
      }
    }
  }
  latestReviews(first:50) {
    nodes { id state bodyText author { login } submittedAt url }
  }
  files(first:100) {
    totalCount
    nodes { path additions deletions }
  }
  commits(last:1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          state
          contexts(first:50) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
}
`;

function repositoryParts(
  nameWithOwner: string,
): { readonly owner: string; readonly name: string } | null {
  const [owner = "", ...nameParts] = nameWithOwner.split("/");
  const name = nameParts.join("/");
  return owner && name ? { owner, name } : null;
}

function parseReviewThreads(connection: unknown): ReviewThreadFact[] {
  return nodeArray(connection).map((thread) => ({
    id: stringValue(thread.id) ?? "",
    isResolved: booleanValue(thread.isResolved),
    path: stringValue(thread.path),
    line: numberValue(thread.line),
    originalLine: numberValue(thread.originalLine),
    comments: nodeArray(thread.comments).map((comment) => ({
      id: stringValue(comment.id) ?? "",
      url: stringValue(comment.url) ?? "",
      author: stringValue(asRecord(comment.author)?.login),
      bodyText: stringValue(comment.bodyText) ?? "",
      createdAt: stringValue(comment.createdAt),
      updatedAt: stringValue(comment.updatedAt),
      outdated: booleanValue(comment.outdated),
      diffHunk: stringValue(comment.diffHunk),
    })),
  }));
}

function parseIssueComments(connection: unknown): IssueCommentFact[] {
  return nodeArray(connection).map((comment) => ({
    id: stringValue(comment.id) ?? "",
    url: stringValue(comment.url) ?? "",
    author: stringValue(asRecord(comment.author)?.login),
    bodyText: stringValue(comment.bodyText) ?? "",
    createdAt: stringValue(comment.createdAt),
    updatedAt: stringValue(comment.updatedAt),
  }));
}

function parseReviews(connection: unknown): ReviewFact[] {
  return nodeArray(connection).map((review) => ({
    id: stringValue(review.id) ?? "",
    state: stringValue(review.state) ?? "",
    author: stringValue(asRecord(review.author)?.login),
    bodyText: stringValue(review.bodyText) ?? "",
    submittedAt: stringValue(review.submittedAt),
    url: stringValue(review.url),
  }));
}

function parseCheckContexts(prNode: Record<string, unknown>): CheckContextFact[] {
  const commitNode = nodeArray(prNode.commits)[0];
  const commit = asRecord(commitNode?.commit);
  const rollup = asRecord(commit?.statusCheckRollup);
  return nodeArray(rollup?.contexts).map((context) => {
    const name = stringValue(context.name) ?? stringValue(context.context) ?? "check";
    const state =
      stringValue(context.conclusion) ??
      stringValue(context.status) ??
      stringValue(context.state) ??
      "UNKNOWN";
    return {
      name,
      state,
      url: stringValue(context.detailsUrl) ?? stringValue(context.targetUrl),
    };
  });
}

function factsFromPrNode(input: {
  readonly pr: TrackedPullRequest;
  readonly viewerLogin: string | null;
  readonly node: Record<string, unknown>;
}): PrHubAdvisoryFacts {
  const reviewThreads = parseReviewThreads(input.node.reviewThreads);
  const issueComments = parseIssueComments(input.node.comments);
  const latestReviews = parseReviews(input.node.latestReviews);
  const truncated =
    totalCount(input.node.reviewThreads) > reviewThreads.length ||
    totalCount(input.node.comments) > issueComments.length ||
    totalCount(input.node.files) > nodeArray(input.node.files).length;
  return {
    pr: input.pr,
    viewerLogin: input.viewerLogin,
    bodyText: stringValue(input.node.bodyText),
    reviewThreads,
    issueComments,
    latestReviews,
    checkContexts: parseCheckContexts(input.node),
    truncated,
  };
}

function errorMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const squashed = Cause.squash(cause);
  const detail = asRecord(squashed)?.detail;
  return typeof detail === "string" && detail.length > 0 ? detail : fallback;
}

function errorKind(cause: Cause.Cause<unknown>): string {
  const kind = asRecord(Cause.squash(cause))?.kind;
  return typeof kind === "string" && kind.length > 0 ? kind : "generic";
}

const makePrHubAdvisoryService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverConfig = yield* ServerConfig;
  const prHub = yield* PrHubService;
  const githubCli = yield* GitHubCli;
  const sourceControlProviders = makeSourceControlProviderRegistry([
    makeGitHubSourceControlProvider(githubCli),
  ]);
  const github = yield* sourceControlProviders.get("github");
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;
  const host = DEFAULT_HOST;
  const providerKind = "github" as const;
  const cwd = accountCwd(serverConfig.cwd);
  const pubSub = yield* PubSub.unbounded<PrHubAdvisorySnapshot>();

  const upsertAdvisory = (viewerLogin: string, advisory: PrHubAdvisory, pr: TrackedPullRequest) => {
    const parts = keyParts(pr);
    const now = new Date().toISOString();
    return sql`
      INSERT INTO pr_hub_advisories (
        provider_kind,
        host,
        viewer_login,
        repo,
        number,
        key,
        fingerprint,
        status,
        recommendation,
        summary,
        confidence,
        blockers_json,
        findings_json,
        degraded,
        truncated,
        generated_at,
        error_kind,
        error_message,
        payload_json,
        updated_at
      )
      VALUES (
        ${parts.provider},
        ${parts.host},
        ${viewerLogin},
        ${parts.repo},
        ${parts.number},
        ${advisory.key},
        ${advisory.fingerprint},
        ${advisory.status},
        ${advisory.recommendation},
        ${advisory.summary},
        ${advisory.confidence},
        ${JSON.stringify(advisory.blockers)},
        ${JSON.stringify(advisory.findings)},
        ${advisory.degraded ? 1 : 0},
        ${advisory.truncated ? 1 : 0},
        ${advisory.generatedAt},
        ${advisory.errorKind ?? null},
        ${advisory.errorMessage ?? null},
        ${JSON.stringify(advisory)},
        ${now}
      )
      ON CONFLICT (provider_kind, host, viewer_login, repo, number)
      DO UPDATE SET
        key = excluded.key,
        fingerprint = excluded.fingerprint,
        status = excluded.status,
        recommendation = excluded.recommendation,
        summary = excluded.summary,
        confidence = excluded.confidence,
        blockers_json = excluded.blockers_json,
        findings_json = excluded.findings_json,
        degraded = excluded.degraded,
        truncated = excluded.truncated,
        generated_at = excluded.generated_at,
        error_kind = excluded.error_kind,
        error_message = excluded.error_message,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `;
  };

  const loadRows = (viewerLogin: string) =>
    sql<AdvisoryRow>`
      SELECT
        key,
        fingerprint,
        status,
        recommendation,
        summary,
        confidence,
        blockers_json,
        findings_json,
        degraded,
        truncated,
        generated_at,
        error_kind,
        error_message,
        payload_json
      FROM pr_hub_advisories
      WHERE provider_kind = ${providerKind}
        AND host = ${host}
        AND viewer_login = ${viewerLogin}
      ORDER BY updated_at DESC
    `;

  const getAdvisories = (
    input: PrHubGetAdvisoriesInput = {},
  ): Effect.Effect<PrHubAdvisorySnapshot> =>
    Effect.gen(function* () {
      const snapshot = yield* prHub.getSnapshot;
      const viewerLogin = snapshot.viewerLogin;
      if (!viewerLogin) {
        return { viewerLogin: null, host: snapshot.host, advisories: [] };
      }
      const allPrs = [...snapshot.pullRequests, ...snapshot.recentlyResolved];
      const requestedKeys = new Set((input.keys ?? []).map(String));
      const fingerprintByKey = new Map(
        allPrs.map((pr) => [String(pr.key), prHubAdvisoryFingerprint(pr)] as const),
      );
      const rows = yield* loadRows(viewerLogin);
      const advisories = rows
        .filter((row) => requestedKeys.size === 0 || requestedKeys.has(row.key))
        .map((row) => advisoryFromRow(row, fingerprintByKey))
        .filter((advisory): advisory is PrHubAdvisory => advisory !== null);
      return {
        viewerLogin,
        host: snapshot.host,
        advisories,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("failed to load PR Hub advisories", {
            detail: errorMessage(cause, "Could not load PR Hub advisories."),
          });
          const snapshot = yield* prHub.getSnapshot;
          return {
            viewerLogin: snapshot.viewerLogin,
            host: snapshot.host,
            advisories: [],
          } satisfies PrHubAdvisorySnapshot;
        }),
      ),
    );

  const publishAdvisories = () =>
    getAdvisories({}).pipe(Effect.flatMap((snapshot) => PubSub.publish(pubSub, snapshot)));

  const fetchFacts = (
    pr: TrackedPullRequest,
    viewerLogin: string | null,
  ): Effect.Effect<
    {
      readonly facts: PrHubAdvisoryFacts;
      readonly degraded: boolean;
      readonly errorMessage?: string;
    },
    never
  > =>
    Effect.gen(function* () {
      const request =
        pr.nodeId !== null
          ? {
              query: PR_ADVISORY_BY_NODE_QUERY,
              variables: { id: pr.nodeId },
              readNode: (response: unknown) => asRecord(asRecord(response)?.data)?.node,
            }
          : (() => {
              const repository = repositoryParts(pr.repository.nameWithOwner);
              if (!repository) return null;
              return {
                query: PR_ADVISORY_BY_NUMBER_QUERY,
                variables: { owner: repository.owner, name: repository.name, number: pr.number },
                readNode: (response: unknown) =>
                  asRecord(asRecord(asRecord(response)?.data)?.repository)?.pullRequest,
              };
            })();

      if (!request) {
        return {
          facts: {
            pr,
            viewerLogin,
            bodyText: null,
            reviewThreads: [],
            issueComments: [],
            latestReviews: [],
            checkContexts: [],
            truncated: false,
          },
          degraded: true,
          errorMessage: "Could not parse repository owner/name for advisory detail lookup.",
        };
      }

      const result = yield* Effect.exit(
        github.query({
          cwd,
          document: request.query,
          variables: request.variables,
        }),
      );
      if (Exit.isFailure(result)) {
        const message = errorMessage(result.cause, "GitHub GraphQL advisory request failed.");
        return {
          facts: {
            pr,
            viewerLogin,
            bodyText: null,
            reviewThreads: [],
            issueComments: [],
            latestReviews: [],
            checkContexts: [],
            truncated: false,
          },
          degraded: true,
          errorMessage: message,
        };
      }

      const response = asRecord(result.value);
      const graphQlErrors = asArray(response?.errors);
      const node = asRecord(request.readNode(result.value));
      if (!node) {
        return {
          facts: {
            pr,
            viewerLogin,
            bodyText: null,
            reviewThreads: [],
            issueComments: [],
            latestReviews: [],
            checkContexts: [],
            truncated: false,
          },
          degraded: true,
          errorMessage: "GitHub GraphQL did not return PR advisory details.",
        };
      }

      return {
        facts: factsFromPrNode({
          pr,
          viewerLogin,
          node,
        }),
        degraded: graphQlErrors.length > 0,
        ...(graphQlErrors.length > 0
          ? { errorMessage: "GitHub GraphQL returned partial advisory detail errors." }
          : {}),
      };
    });

  const analyzeOne = (
    viewerLogin: string,
    pr: TrackedPullRequest,
    modelSelection: ModelSelection,
  ) =>
    Effect.gen(function* () {
      yield* upsertAdvisory(viewerLogin, transitionalAdvisory(pr, "running"), pr);
      yield* publishAdvisories();
      const detail = yield* fetchFacts(pr, viewerLogin);
      const baseline = derivePrHubAdvisory(detail.facts);
      const modelResult = yield* Effect.exit(
        textGeneration.generateStructuredJson({
          operation: ADVISORY_MODEL_ANALYSIS_OPERATION,
          cwd,
          prompt: buildAdvisoryPrompt(detail.facts, baseline),
          outputSchema: AdvisoryModelOutput,
          modelSelection,
        }),
      );
      const advisory = Exit.isSuccess(modelResult)
        ? advisoryFromModelOutput({
            facts: detail.facts,
            baseline,
            output: modelResult.value,
          })
        : {
            ...baseline,
            degraded: true,
            errorKind: "model",
            errorMessage: errorMessage(
              modelResult.cause,
              "Model advisory failed; using deterministic fallback.",
            ),
          };
      const finalAdvisory =
        detail.degraded || detail.errorMessage
          ? {
              ...advisory,
              degraded: true,
              ...(detail.errorMessage ? { errorMessage: detail.errorMessage } : {}),
            }
          : advisory;
      yield* upsertAdvisory(viewerLogin, finalAdvisory, pr);
      yield* publishAdvisories();
      return finalAdvisory;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const advisory = failedAdvisory({
            pr,
            errorKind: errorKind(cause),
            errorMessage: errorMessage(cause, "Could not analyze this pull request."),
          });
          yield* upsertAdvisory(viewerLogin, advisory, pr);
          yield* publishAdvisories();
          return advisory;
        }),
      ),
    );

  const analyzeAdvisories = (
    input: PrHubAnalyzeAdvisoriesInput = {},
  ): Effect.Effect<PrHubAdvisorySnapshot> =>
    Effect.gen(function* () {
      const snapshot = yield* prHub.getSnapshot;
      const viewerLogin = snapshot.viewerLogin;
      if (!viewerLogin) {
        return { viewerLogin: null, host: snapshot.host, advisories: [] };
      }

      const requestedKeys = new Set((input.keys ?? []).map(String));
      const allPrs = [...snapshot.pullRequests, ...snapshot.recentlyResolved];
      const targets = allPrs.filter((pr) =>
        requestedKeys.size > 0 ? requestedKeys.has(String(pr.key)) : isActiveDefaultTarget(pr),
      );
      const rows = yield* loadRows(viewerLogin);
      const cachedByKey = new Map(rows.map((row) => [row.key, row] as const));
      const mode = input.mode ?? "stale_only";
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("failed to load advisory model settings", {
              detail: errorMessage(cause, "Could not load server settings."),
            });
            return DEFAULT_SERVER_SETTINGS;
          }),
        ),
      );
      const modelSelection = resolveAdvisoryModelSelection(settings.textGenerationModelSelection);
      const toAnalyze = targets.filter((pr) => {
        if (mode === "force") return true;
        const cached = cachedByKey.get(String(pr.key));
        return (
          cached?.status !== "succeeded" || cached.fingerprint !== prHubAdvisoryFingerprint(pr)
        );
      });

      const batch = toAnalyze;

      for (const pr of batch) {
        yield* upsertAdvisory(viewerLogin, transitionalAdvisory(pr, "queued"), pr);
      }
      if (batch.length > 0) yield* publishAdvisories();

      yield* Effect.forEach(batch, (pr) => analyzeOne(viewerLogin, pr, modelSelection), {
        concurrency: ADVISORY_ANALYSIS_CONCURRENCY,
        discard: true,
      });

      return yield* getAdvisories({
        keys: targets.map((pr) => pr.key),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("failed to analyze PR Hub advisories", {
            detail: errorMessage(cause, "Could not analyze PR Hub advisories."),
          });
          return yield* getAdvisories({ keys: input.keys });
        }),
      ),
    );

  return {
    getAdvisories,
    analyzeAdvisories,
    streamAdvisories: Stream.fromPubSub(pubSub),
  } satisfies PrHubAdvisoryServiceShape;
});

export const PrHubAdvisoryServiceLive = Layer.effect(
  PrHubAdvisoryService,
  makePrHubAdvisoryService,
);
