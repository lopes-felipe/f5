import { Schema } from "effect";
import { CommandId, NonNegativeInt, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas";

export const WorkflowRunKind = Schema.Literals(["planning", "codeReview", "investigation"]);
export type WorkflowRunKind = typeof WorkflowRunKind.Type;

export const WorkflowBenchmarkPhase = Schema.Literals([
  "authoring",
  "reviews",
  "revision",
  "merge",
  "implementation",
  "code-review",
  "apply-feedback",
  "reader-review",
  "polish",
  "consolidation",
  "investigation",
  "synthesis",
]);
export type WorkflowBenchmarkPhase = typeof WorkflowBenchmarkPhase.Type;

export const WorkflowFindingSeverity = Schema.Literals(["critical", "high", "medium", "low"]);
export const WorkflowFindingVerdict = Schema.Literals(["confirmed", "checking", "dismissed"]);
export const WorkflowFindingStatus = Schema.Literals([
  "confirmed",
  "checking",
  "dismissed",
  "fixed",
  "addressed",
]);

export const WorkflowReviewTarget = Schema.Struct({
  label: Schema.String,
  threadId: Schema.optional(ThreadId),
  turnId: Schema.optional(Schema.String),
  planId: Schema.optional(Schema.String),
  patchHash: Schema.optional(Schema.String),
  baseRevision: Schema.optional(Schema.String),
  headRevision: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  anchors: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkflowReviewTarget = typeof WorkflowReviewTarget.Type;

export const WorkflowAttribution = Schema.Struct({
  runKind: WorkflowRunKind,
  workflowId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  originCommandId: CommandId,
  reviewTarget: Schema.optional(WorkflowReviewTarget),
  findingRefs: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkflowAttribution = typeof WorkflowAttribution.Type;

export const WorkflowBenchmarkInput = Schema.Struct({
  runKind: WorkflowRunKind,
  workflowId: TrimmedNonEmptyString,
  select: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("summary") }),
    Schema.Struct({
      kind: Schema.Literal("turns"),
      phase: WorkflowBenchmarkPhase,
      offset: Schema.optional(NonNegativeInt),
    }),
    Schema.Struct({
      kind: Schema.Literal("findings"),
      phase: WorkflowBenchmarkPhase,
      offset: Schema.optional(NonNegativeInt),
      search: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
      model: Schema.optional(Schema.String),
      severity: Schema.optional(WorkflowFindingSeverity),
      status: Schema.optional(WorkflowFindingStatus),
    }),
  ]),
});
export type WorkflowBenchmarkInput = typeof WorkflowBenchmarkInput.Type;
export const WorkflowBenchmarkChanged = Schema.Struct({
  runKind: WorkflowRunKind,
  workflowId: TrimmedNonEmptyString,
});
export type WorkflowBenchmarkChanged = typeof WorkflowBenchmarkChanged.Type;

export const WorkflowBenchmarkUsage = Schema.Struct({
  tokens: Schema.NullOr(NonNegativeInt),
  costUsd: Schema.NullOr(Schema.Number),
  estimated: Schema.Boolean,
  missingTokens: NonNegativeInt,
  missingCost: NonNegativeInt,
  pending: NonNegativeInt,
});
export type WorkflowBenchmarkUsage = typeof WorkflowBenchmarkUsage.Type;

const BenchmarkModel = Schema.Struct({ id: Schema.String, label: Schema.String });
const BenchmarkCell = Schema.Struct({ model: Schema.String, usage: WorkflowBenchmarkUsage });
const FindingCounts = Schema.Struct({
  confirmed: NonNegativeInt,
  checking: NonNegativeInt,
  dismissed: NonNegativeInt,
  shared: NonNegativeInt,
  exclusive: Schema.Array(Schema.Struct({ model: Schema.String, count: NonNegativeInt })),
});

const BenchmarkSummary = Schema.Struct({
  kind: Schema.Literal("summary"),
  models: Schema.Array(BenchmarkModel),
  phases: Schema.Array(
    Schema.Struct({
      id: WorkflowBenchmarkPhase,
      label: Schema.String,
      cells: Schema.Array(BenchmarkCell),
      total: WorkflowBenchmarkUsage,
      findings: NonNegativeInt,
      review: Schema.Boolean,
    }),
  ),
  total: WorkflowBenchmarkUsage,
  modelTotals: Schema.Array(BenchmarkCell),
  findings: NonNegativeInt,
  historicalPartial: Schema.Boolean,
  ambiguous: NonNegativeInt,
  evaluationsIncomplete: NonNegativeInt,
  coverage: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      structured: NonNegativeInt,
      completed: NonNegativeInt,
      invalid: NonNegativeInt,
    }),
  ),
});
export type WorkflowBenchmarkSummary = typeof BenchmarkSummary.Type;

const BenchmarkTurn = Schema.Struct({
  id: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(TurnId),
  model: BenchmarkModel,
  modelSource: Schema.Literals(["effective", "configured", "historical", "unknown"]),
  role: Schema.String,
  attempt: NonNegativeInt,
  durationMs: Schema.NullOr(NonNegativeInt),
  status: Schema.String,
  target: Schema.NullOr(WorkflowReviewTarget),
  aggregateRerouteUsage: Schema.Boolean,
  usage: WorkflowBenchmarkUsage,
});
export type WorkflowBenchmarkTurn = typeof BenchmarkTurn.Type;

const FindingOrigin = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  messageId: Schema.NullOr(Schema.String),
  planId: Schema.NullOr(Schema.String),
});
export type WorkflowFindingOrigin = typeof FindingOrigin.Type;

const BenchmarkFinding = Schema.Struct({
  id: Schema.String,
  aliases: Schema.Array(Schema.String),
  severity: WorkflowFindingSeverity,
  title: Schema.String,
  description: Schema.String,
  location: Schema.NullOr(Schema.String),
  evidence: Schema.Array(Schema.String),
  reporters: Schema.Array(Schema.Struct({ model: BenchmarkModel, origin: FindingOrigin })),
  status: WorkflowFindingStatus,
  resolution: Schema.NullOr(
    Schema.Struct({
      model: BenchmarkModel,
      origin: FindingOrigin,
      evidence: Schema.NullOr(Schema.String),
      diffFileChangeId: Schema.optional(Schema.String),
    }),
  ),
  test: Schema.NullOr(Schema.Literals(["reported", "confirmed", "passed"])),
  testEvidence: Schema.optional(Schema.Struct({ id: Schema.String, origin: FindingOrigin })),
});
export type WorkflowBenchmarkFinding = typeof BenchmarkFinding.Type;

export const WorkflowBenchmarkResult = Schema.Union([
  BenchmarkSummary,
  Schema.Struct({
    kind: Schema.Literal("turns"),
    items: Schema.Array(BenchmarkTurn),
    count: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("findings"),
    items: Schema.Array(BenchmarkFinding),
    count: NonNegativeInt,
    counts: FindingCounts,
  }),
]);
export type WorkflowBenchmarkResult = typeof WorkflowBenchmarkResult.Type;
