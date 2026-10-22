import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "./baseSchemas";
import { ModelSelection, RuntimeMode } from "./orchestration";

// ── Checked-in project configuration (`f5.json` "upstream" block) ───────

/** GitHub only in v1; SSH and HTTPS remote URLs are compared after normalization. */
export const UPSTREAM_REPOSITORY_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?$/u;
export const UPSTREAM_REMOTE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
/**
 * A conservative subset of Git ref names; the value reaches shell commands in
 * port prompts, so the prompt quotes it as well.
 */
export const UPSTREAM_BRANCH_PATTERN =
  /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]+$/u;
/**
 * A normalized relative path: forward slashes, no empty, `.` or `..` segments.
 * Git reports plain paths, so any other spelling would slip past the
 * prefix-based CI rules.
 */
export const UPSTREAM_LEDGER_DIR_PATTERN =
  /^(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

export const UpstreamProjectConfig = Schema.Struct({
  repository: Schema.String.check(Schema.isPattern(UPSTREAM_REPOSITORY_PATTERN)),
  remote: Schema.String.check(
    Schema.isPattern(UPSTREAM_REMOTE_NAME_PATTERN),
    Schema.isMaxLength(100),
  ).pipe(Schema.withDecodingDefault(() => "upstream")),
  branch: Schema.String.check(
    Schema.isPattern(UPSTREAM_BRANCH_PATTERN),
    Schema.isMaxLength(200),
  ).pipe(Schema.withDecodingDefault(() => "main")),
  ledgerDir: Schema.String.check(
    Schema.isPattern(UPSTREAM_LEDGER_DIR_PATTERN),
    Schema.isMaxLength(200),
  ).pipe(Schema.withDecodingDefault(() => "upstream")),
});
export type UpstreamProjectConfig = typeof UpstreamProjectConfig.Type;

// ── Ledger v7 repository files ──────────────────────────────────────────

export const UPSTREAM_LEDGER_SCHEMA_VERSION = 7;
export const UPSTREAM_RULES_SCHEMA_VERSION = 1;
export const UPSTREAM_POLICY_MAX_BYTES = 16 * 1024;
export const UPSTREAM_TOPIC_TITLE_MAX = 100;
export const UPSTREAM_TOPIC_SUMMARY_MAX = 300;
export const UPSTREAM_TOPIC_SCOPE_MAX = 500;
export const UPSTREAM_SUGGESTION_REASON_MAX = 300;
export const UPSTREAM_SUGGESTION_QUESTION_MAX = 200;
export const UPSTREAM_SUGGESTION_AREAS_MAX = 5;

export const UpstreamSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
export const UpstreamTopicId = Schema.String.check(
  Schema.isPattern(/^(pr-[1-9][0-9]*(-[0-9a-f]{7})?|c-[0-9a-f]{12})$/u),
);
export type UpstreamTopicId = typeof UpstreamTopicId.Type;
export const UpstreamDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u));
/** UTC (`Z`) timestamps only; topic files are bucketed by the first seven characters. */
export const UpstreamUtcTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u),
);
export const UpstreamMonth = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}$/u));

export const UpstreamMembershipCommit = Schema.Struct({
  sha: UpstreamSha,
  subject: Schema.String,
  pr: Schema.optionalKey(PositiveInt),
  topic: UpstreamTopicId,
});
export type UpstreamMembershipCommit = typeof UpstreamMembershipCommit.Type;

export const UpstreamIntervalFile = Schema.Struct({
  schemaVersion: Schema.Literal(UPSTREAM_LEDGER_SCHEMA_VERSION),
  interval: PositiveInt,
  baseSha: UpstreamSha,
  targetSha: UpstreamSha,
  selection: Schema.Literal("first-parent"),
  createdAt: UpstreamUtcTimestamp,
  count: NonNegativeInt,
  digest: Schema.String,
  commits: Schema.Array(UpstreamMembershipCommit),
});
export type UpstreamIntervalFile = typeof UpstreamIntervalFile.Type;

export const UpstreamLegacyBatchFile = Schema.Struct({
  schemaVersion: Schema.Literal(UPSTREAM_LEDGER_SCHEMA_VERSION),
  batch: PositiveInt,
  createdAt: UpstreamUtcTimestamp,
  count: NonNegativeInt,
  digest: Schema.String,
  commits: Schema.Array(UpstreamMembershipCommit),
});
export type UpstreamLegacyBatchFile = typeof UpstreamLegacyBatchFile.Type;

export const UpstreamTopicStatus = Schema.Literals([
  "inbox",
  "port",
  "skip",
  "declined",
  "watch",
  "equivalent",
]);
export type UpstreamTopicStatus = typeof UpstreamTopicStatus.Type;

/** Derived from the stored status plus trailers, links, and today's date. */
export const UpstreamTopicState = Schema.Literals([
  "inbox",
  "ready",
  "in-progress",
  "watch",
  "done",
  "skipped",
]);
export type UpstreamTopicState = typeof UpstreamTopicState.Type;

export const UpstreamDecidedBy = Schema.Literals(["rule", "llm", "user"]);
export type UpstreamDecidedBy = typeof UpstreamDecidedBy.Type;

export const UpstreamUserImpact = Schema.Literals(["high", "medium", "low", "none"]);
export type UpstreamUserImpact = typeof UpstreamUserImpact.Type;

export const UpstreamSuggestionStatus = Schema.Literals(["port", "skip", "watch", "equivalent"]);
export type UpstreamSuggestionStatus = typeof UpstreamSuggestionStatus.Type;

export const UpstreamTopicSuggestion = Schema.Struct({
  status: UpstreamSuggestionStatus,
  reasonKey: Schema.optionalKey(Schema.String),
  reason: Schema.String,
  userImpact: UpstreamUserImpact,
  confidence: Schema.Number,
  areas: Schema.Array(Schema.String),
  model: Schema.String,
  question: Schema.optionalKey(Schema.String),
  conflict: Schema.optionalKey(Schema.Literal(true)),
  f5Refs: Schema.optionalKey(Schema.Array(Schema.String)),
  triageError: Schema.optionalKey(Schema.String),
});
export type UpstreamTopicSuggestion = typeof UpstreamTopicSuggestion.Type;

export const UpstreamEquivalence = Schema.Struct({
  f5Refs: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
});
export type UpstreamEquivalence = typeof UpstreamEquivalence.Type;

export const UpstreamTopic = Schema.Struct({
  id: UpstreamTopicId,
  createdAt: UpstreamUtcTimestamp,
  title: Schema.String,
  summary: Schema.String,
  upstreamPrs: Schema.Array(PositiveInt),
  status: UpstreamTopicStatus,
  epoch: PositiveInt,
  reasonKey: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  decidedBy: Schema.optionalKey(UpstreamDecidedBy),
  decidedAt: Schema.optionalKey(UpstreamUtcTimestamp),
  suggestion: Schema.optionalKey(UpstreamTopicSuggestion),
  relatedTopics: Schema.optionalKey(Schema.Array(UpstreamTopicId)),
  revisitAfter: Schema.optionalKey(UpstreamDate),
  equivalence: Schema.optionalKey(UpstreamEquivalence),
});
export type UpstreamTopic = typeof UpstreamTopic.Type;

export const UpstreamTopicFile = Schema.Struct({
  schemaVersion: Schema.Literal(UPSTREAM_LEDGER_SCHEMA_VERSION),
  month: UpstreamMonth,
  topics: Schema.Array(UpstreamTopic),
});
export type UpstreamTopicFile = typeof UpstreamTopicFile.Type;

export const UpstreamAutoSkipRule = Schema.Struct({
  reasonKey: Schema.String,
  pathPrefixes: Schema.optionalKey(Schema.Array(Schema.String)),
  pathSuffixes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type UpstreamAutoSkipRule = typeof UpstreamAutoSkipRule.Type;

export const UpstreamRules = Schema.Struct({
  schemaVersion: Schema.Literal(UPSTREAM_RULES_SCHEMA_VERSION),
  reasonKeys: Schema.Array(Schema.String),
  reasonLabels: Schema.Record(Schema.String, Schema.String),
  upstreamOnlySubsystems: Schema.Array(Schema.String),
  ignoredPathPrefixes: Schema.Array(Schema.String),
  autoSkip: Schema.Array(UpstreamAutoSkipRule),
  autoSkipConfidence: Schema.Number,
});
export type UpstreamRules = typeof UpstreamRules.Type;

// ── LLM triage output (plain structs so JSON Schema can be emitted) ─────

export const UpstreamTriageGroup = Schema.Struct({
  key: Schema.String,
  commits: Schema.Array(Schema.String),
  attachTo: Schema.NullOr(Schema.String),
  relatedTo: Schema.NullOr(Schema.String),
  title: Schema.String,
  summary: Schema.String,
  suggestion: Schema.Literals(["port", "skip", "watch"]),
  reasonKey: Schema.NullOr(Schema.String),
  reason: Schema.String,
  userImpact: UpstreamUserImpact,
  confidence: Schema.Number,
  areas: Schema.Array(Schema.String),
  question: Schema.NullOr(Schema.String),
});
export type UpstreamTriageGroup = typeof UpstreamTriageGroup.Type;

export const UpstreamTriageBatchResult = Schema.Struct({
  groups: Schema.Array(UpstreamTriageGroup),
});
export type UpstreamTriageBatchResult = typeof UpstreamTriageBatchResult.Type;

// ── Local-only settings ─────────────────────────────────────────────────

export const UpstreamScheduleMode = Schema.Literals(["off", "daily", "weekly"]);
export type UpstreamScheduleMode = typeof UpstreamScheduleMode.Type;

export const UpstreamSchedule = Schema.Struct({
  mode: UpstreamScheduleMode.pipe(Schema.withDecodingDefault(() => "off" as const)),
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })).pipe(
    Schema.withDecodingDefault(() => 7),
  ),
  /** 0 is Sunday; used only by the weekly mode. */
  weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).pipe(
    Schema.withDecodingDefault(() => 1),
  ),
});
export type UpstreamSchedule = typeof UpstreamSchedule.Type;

export const UpstreamPortsSettings = Schema.Struct({
  schedule: UpstreamSchedule.pipe(Schema.withDecodingDefault(() => ({}))),
  triageModelSelection: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(() => null)),
  portModelSelection: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(() => null)),
});
export type UpstreamPortsSettings = typeof UpstreamPortsSettings.Type;

// ── RPC ─────────────────────────────────────────────────────────────────

export const UPSTREAM_PORTS_WS_METHODS = {
  listProjects: "upstreamPorts.listProjects",
  getOverview: "upstreamPorts.getOverview",
  listTopics: "upstreamPorts.listTopics",
  getTopic: "upstreamPorts.getTopic",
  decide: "upstreamPorts.decide",
  acceptSuggestions: "upstreamPorts.acceptSuggestions",
  run: "upstreamPorts.run",
  startPort: "upstreamPorts.startPort",
  unlinkPort: "upstreamPorts.unlinkPort",
  getPortPrompt: "upstreamPorts.getPortPrompt",
  resolvePublication: "upstreamPorts.resolvePublication",
  addRemote: "upstreamPorts.addRemote",
  takeOverWriter: "upstreamPorts.takeOverWriter",
} as const;

export const UPSTREAM_PORTS_WS_CHANNELS = {
  changed: "upstreamPorts.changed",
} as const;

export const UPSTREAM_MAX_DECIDE_TOPICS = 200;
export const UPSTREAM_MAX_PORT_TOPICS = 20;
export const UPSTREAM_MAX_PORT_GROUPS = 5;
export const UPSTREAM_LIST_DEFAULT_LIMIT = 200;
export const UPSTREAM_LIST_MAX_LIMIT = 500;

const TopicIds = (max: number) =>
  Schema.Array(UpstreamTopicId).check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const UpstreamProjectSummary = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  repository: Schema.String,
  inboxCount: NonNegativeInt,
  managedByThisProfile: Schema.Boolean,
});
export type UpstreamProjectSummary = typeof UpstreamProjectSummary.Type;

export const UpstreamPortsListProjectsResult = Schema.Struct({
  projects: Schema.Array(UpstreamProjectSummary),
});
export type UpstreamPortsListProjectsResult = typeof UpstreamPortsListProjectsResult.Type;

export const UpstreamPortsListProjectsInput = Schema.Struct({});
export type UpstreamPortsListProjectsInput = typeof UpstreamPortsListProjectsInput.Type;

export const UpstreamPortsProjectInput = Schema.Struct({ projectId: ProjectId });
export type UpstreamPortsProjectInput = typeof UpstreamPortsProjectInput.Type;

export const UpstreamRunKind = Schema.Literals(["upstream", "legacy"]);
export type UpstreamRunKind = typeof UpstreamRunKind.Type;
export const UpstreamRunTriage = Schema.Literals(["llm", "rules-only"]);
export type UpstreamRunTriage = typeof UpstreamRunTriage.Type;
export const UpstreamRunTrigger = Schema.Literals(["schedule", "manual", "continuation"]);
export type UpstreamRunTrigger = typeof UpstreamRunTrigger.Type;
export const UpstreamRunStatus = Schema.Literals([
  "running",
  "succeeded",
  "partial",
  "failed",
  "interrupted",
]);
export type UpstreamRunStatus = typeof UpstreamRunStatus.Type;

export const UpstreamRunSummary = Schema.Struct({
  runId: Schema.String,
  kind: UpstreamRunKind,
  trigger: UpstreamRunTrigger,
  triage: UpstreamRunTriage,
  status: UpstreamRunStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  failureKind: Schema.NullOr(Schema.String),
  targetSha: Schema.NullOr(Schema.String),
  commitCount: NonNegativeInt,
  inboxCount: NonNegativeInt,
  autoDecidedCount: NonNegativeInt,
  remainingCount: NonNegativeInt,
  llmCalls: NonNegativeInt,
  errorMessage: Schema.NullOr(Schema.String),
});
export type UpstreamRunSummary = typeof UpstreamRunSummary.Type;

export const UpstreamOccurrenceStatus = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "superseded",
]);
export type UpstreamOccurrenceStatus = typeof UpstreamOccurrenceStatus.Type;

export const UpstreamOccurrenceSummary = Schema.Struct({
  dueAt: IsoDateTime,
  status: UpstreamOccurrenceStatus,
  attempts: NonNegativeInt,
  continuations: NonNegativeInt,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type UpstreamOccurrenceSummary = typeof UpstreamOccurrenceSummary.Type;

export const UpstreamPublicationPhase = Schema.Literals([
  "idle",
  "committing",
  "pushing",
  "opening-pr",
]);
export type UpstreamPublicationPhase = typeof UpstreamPublicationPhase.Type;
export const UpstreamPublicationPauseReason = Schema.Literals([
  "closed-pr",
  "conflict",
  "signing",
  "auth",
  "push-rejected",
  "writer-lost",
]);
export type UpstreamPublicationPauseReason = typeof UpstreamPublicationPauseReason.Type;

export const UpstreamPublicationSummary = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(PositiveInt),
  prUrl: Schema.NullOr(Schema.String),
  prState: Schema.NullOr(Schema.String),
  phase: UpstreamPublicationPhase,
  pausedReason: Schema.NullOr(UpstreamPublicationPauseReason),
  lastError: Schema.NullOr(Schema.String),
  unpublishedOps: NonNegativeInt,
});
export type UpstreamPublicationSummary = typeof UpstreamPublicationSummary.Type;

export const UpstreamWriterClaim = Schema.Struct({
  claimed: Schema.Boolean,
  managedByThisProfile: Schema.Boolean,
  profileId: Schema.NullOr(Schema.String),
  hostname: Schema.NullOr(Schema.String),
  claimedAt: Schema.NullOr(IsoDateTime),
});
export type UpstreamWriterClaim = typeof UpstreamWriterClaim.Type;

export const UpstreamRemoteStatus = Schema.Literals(["ok", "missing", "mismatch"]);
export type UpstreamRemoteStatus = typeof UpstreamRemoteStatus.Type;

export const UpstreamStateCounts = Schema.Struct({
  inbox: NonNegativeInt,
  ready: NonNegativeInt,
  "in-progress": NonNegativeInt,
  watch: NonNegativeInt,
  done: NonNegativeInt,
  skipped: NonNegativeInt,
});
export type UpstreamStateCounts = typeof UpstreamStateCounts.Type;

export const UpstreamOverview = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.String,
  config: Schema.NullOr(UpstreamProjectConfig),
  diagnostics: Schema.Array(Schema.String),
  remoteStatus: UpstreamRemoteStatus,
  remoteUrl: Schema.NullOr(Schema.String),
  writer: UpstreamWriterClaim,
  activeRun: Schema.NullOr(UpstreamRunSummary),
  lastRun: Schema.NullOr(UpstreamRunSummary),
  schedule: UpstreamSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  occurrence: Schema.NullOr(UpstreamOccurrenceSummary),
  publication: UpstreamPublicationSummary,
  counts: UpstreamStateCounts,
  trackedThrough: Schema.NullOr(Schema.String),
  legacyRemaining: NonNegativeInt,
  untriagedUpstreamCount: NonNegativeInt,
  ghAvailable: Schema.Boolean,
  triageModelAvailable: Schema.Boolean,
  policyTruncated: Schema.Boolean,
  autoSkipConfidence: Schema.Number,
  reasonKeys: Schema.Array(Schema.String),
  reasonLabels: Schema.Record(Schema.String, Schema.String),
  upstreamOnlySubsystems: Schema.Array(Schema.String),
});
export type UpstreamOverview = typeof UpstreamOverview.Type;

export const UpstreamTopicList = UpstreamTopicState;
export type UpstreamTopicList = UpstreamTopicState;

export const UpstreamListTopicsInput = Schema.Struct({
  projectId: ProjectId,
  list: UpstreamTopicList,
  filter: Schema.optionalKey(
    Schema.Struct({
      decidedBy: Schema.optionalKey(UpstreamDecidedBy),
      hasQuestion: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: UPSTREAM_LIST_MAX_LIMIT })),
  ),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type UpstreamListTopicsInput = typeof UpstreamListTopicsInput.Type;

export const UpstreamPortOutcomeKind = Schema.Literals([
  "pr",
  "equivalent",
  "not-applicable",
  "blocked",
]);
export type UpstreamPortOutcomeKind = typeof UpstreamPortOutcomeKind.Type;

export const UpstreamPortOutcome = Schema.Struct({
  kind: UpstreamPortOutcomeKind,
  detail: Schema.String,
});
export type UpstreamPortOutcome = typeof UpstreamPortOutcome.Type;

export const UpstreamPortLinkSummary = Schema.Struct({
  threadId: ThreadId,
  epoch: PositiveInt,
  threadTitle: Schema.NullOr(Schema.String),
  threadStatus: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(PositiveInt),
  prUrl: Schema.NullOr(Schema.String),
  prState: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(UpstreamPortOutcome),
});
export type UpstreamPortLinkSummary = typeof UpstreamPortLinkSummary.Type;

export const UpstreamTopicRow = Schema.Struct({
  topic: UpstreamTopic,
  state: UpstreamTopicState,
  commitCount: NonNegativeInt,
  links: Schema.Array(UpstreamPortLinkSummary),
  /** Merge commit PR number or f5 SHA that carried the completing trailer. */
  doneBy: Schema.NullOr(Schema.String),
});
export type UpstreamTopicRow = typeof UpstreamTopicRow.Type;

export const UpstreamListTopicsResult = Schema.Struct({
  revision: Schema.String,
  status: Schema.Literals(["ok", "cursor_stale"]),
  topics: Schema.Array(UpstreamTopicRow),
  nextCursor: Schema.NullOr(Schema.String),
});
export type UpstreamListTopicsResult = typeof UpstreamListTopicsResult.Type;

export const UpstreamGetTopicInput = Schema.Struct({
  projectId: ProjectId,
  topicId: UpstreamTopicId,
});
export type UpstreamGetTopicInput = typeof UpstreamGetTopicInput.Type;

export const UpstreamTopicMember = Schema.Struct({
  sha: UpstreamSha,
  subject: Schema.String,
  pr: Schema.NullOr(PositiveInt),
  source: Schema.String,
});
export type UpstreamTopicMember = typeof UpstreamTopicMember.Type;

export const UpstreamRelatedTopic = Schema.Struct({
  id: UpstreamTopicId,
  title: Schema.String,
  state: Schema.NullOr(UpstreamTopicState),
});
export type UpstreamRelatedTopic = typeof UpstreamRelatedTopic.Type;

export const UpstreamTopicDetail = Schema.Struct({
  revision: Schema.String,
  repository: Schema.String,
  row: UpstreamTopicRow,
  members: Schema.Array(UpstreamTopicMember),
  related: Schema.Array(UpstreamRelatedTopic),
});
export type UpstreamTopicDetail = typeof UpstreamTopicDetail.Type;

export const UpstreamDecision = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("port"),
    scope: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(UPSTREAM_TOPIC_SCOPE_MAX))),
  }),
  Schema.Struct({
    kind: Schema.Literal("skip"),
    reasonKey: Schema.String.check(Schema.isNonEmpty()),
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("declined"),
    reason: Schema.String.check(Schema.isNonEmpty()),
  }),
  Schema.Struct({
    kind: Schema.Literal("watch"),
    revisitAfter: Schema.optionalKey(UpstreamDate),
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("equivalent"),
    f5Refs: Schema.optionalKey(Schema.Array(Schema.String)),
    evidence: Schema.optionalKey(Schema.Array(Schema.String)),
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("inbox"),
    reason: Schema.optionalKey(Schema.String),
  }),
]);
export type UpstreamDecision = typeof UpstreamDecision.Type;

export const UpstreamDecideInput = Schema.Struct({
  projectId: ProjectId,
  topicIds: TopicIds(UPSTREAM_MAX_DECIDE_TOPICS),
  decision: UpstreamDecision,
});
export type UpstreamDecideInput = typeof UpstreamDecideInput.Type;

export const UpstreamAcceptSuggestionsInput = Schema.Struct({
  projectId: ProjectId,
  topicIds: TopicIds(UPSTREAM_MAX_DECIDE_TOPICS),
});
export type UpstreamAcceptSuggestionsInput = typeof UpstreamAcceptSuggestionsInput.Type;

export const UpstreamDecideResult = Schema.Struct({
  revision: Schema.String,
  updated: Schema.Array(UpstreamTopicId),
  unchanged: Schema.Array(UpstreamTopicId),
});
export type UpstreamDecideResult = typeof UpstreamDecideResult.Type;

export const UpstreamRunInput = Schema.Struct({
  projectId: ProjectId,
  kind: UpstreamRunKind,
  triage: UpstreamRunTriage,
});
export type UpstreamRunInput = typeof UpstreamRunInput.Type;

export const UpstreamRunResult = Schema.Struct({
  runId: Schema.String,
});
export type UpstreamRunResult = typeof UpstreamRunResult.Type;

export const UpstreamStartPortInput = Schema.Struct({
  projectId: ProjectId,
  topicIds: TopicIds(UPSTREAM_MAX_PORT_TOPICS),
  grouping: Schema.Literals(["together", "separately"]),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  clientRequestId: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128)),
});
export type UpstreamStartPortInput = typeof UpstreamStartPortInput.Type;

export const UpstreamPortGroupStatus = Schema.Literals(["pending", "submitted", "rejected"]);
export type UpstreamPortGroupStatus = typeof UpstreamPortGroupStatus.Type;

export const UpstreamStartPortResult = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      topicIds: Schema.Array(UpstreamTopicId),
      status: UpstreamPortGroupStatus,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
});
export type UpstreamStartPortResult = typeof UpstreamStartPortResult.Type;

export const UpstreamUnlinkPortInput = Schema.Struct({
  projectId: ProjectId,
  topicId: UpstreamTopicId,
  threadId: ThreadId,
});
export type UpstreamUnlinkPortInput = typeof UpstreamUnlinkPortInput.Type;

export const UpstreamGetPortPromptInput = Schema.Struct({
  projectId: ProjectId,
  topicIds: TopicIds(UPSTREAM_MAX_PORT_TOPICS),
});
export type UpstreamGetPortPromptInput = typeof UpstreamGetPortPromptInput.Type;

export const UpstreamGetPortPromptResult = Schema.Struct({ prompt: Schema.String });
export type UpstreamGetPortPromptResult = typeof UpstreamGetPortPromptResult.Type;

export const UpstreamResolvePublicationInput = Schema.Struct({
  projectId: ProjectId,
  action: Schema.Literals(["retry", "republish", "discard"]),
});
export type UpstreamResolvePublicationInput = typeof UpstreamResolvePublicationInput.Type;

export const UpstreamRevisionResult = Schema.Struct({ revision: Schema.String });
export type UpstreamRevisionResult = typeof UpstreamRevisionResult.Type;

export const UpstreamChangedReason = Schema.Literals([
  "run-started",
  "run-finished",
  "ledger-updated",
  "ports-updated",
  "publication-updated",
]);
export type UpstreamChangedReason = typeof UpstreamChangedReason.Type;

export const UpstreamPortsChanged = Schema.Struct({
  projectId: ProjectId,
  reason: UpstreamChangedReason,
  newInboxCount: Schema.optionalKey(NonNegativeInt),
});
export type UpstreamPortsChanged = typeof UpstreamPortsChanged.Type;
