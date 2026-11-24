import type {
  CodeReviewWorkflow,
  CodeReviewWorkflowId,
  InvestigationInvestigator,
  InvestigationWorkflow,
  InvestigationWorkflowId,
  WorkflowDocumentType,
  PlanningWorkflow,
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
  WorkflowBranch,
  WorkflowModelSlot,
  CodeReviewReviewer,
} from "@t3tools/contracts";
import {
  initialInvestigationCrossReview,
  workflowParticipantIds,
  workflowParticipantLabel,
  workflowUsesMesh,
  WorkflowParticipantInvariantError,
} from "@t3tools/shared/workflowParticipants";

/**
 * Records keep their first two actors in the historical pair fields and any further actors in
 * an optional `additional*` array. This module is the one place that maps between an ordered
 * actor list and those pair-shaped records, create inputs and create commands.
 */

function slotLabel(slot: WorkflowModelSlot): string {
  return `${slot.provider}:${slot.model}`;
}

interface VersionedRecordInput {
  readonly templateId: string;
  readonly templateVersion: number;
}

/** One actor of a run being created: its model and pre-minted primary thread. */
export interface WorkflowActorSeed {
  readonly slot: WorkflowModelSlot;
  readonly threadId: ThreadId;
}

function requirePair<T>(items: ReadonlyArray<T>): readonly [T, T, ReadonlyArray<T>] {
  const [first, second, ...rest] = items;
  if (first === undefined || second === undefined) {
    throw new WorkflowParticipantInvariantError("Workflows need at least two actors.");
  }
  return [first, second, rest];
}

/** `[a, b, ...rest]` → the pair fields plus an `additional*` key that is omitted when empty. */
function pairFields<T, A extends string, B extends string, K extends string>(
  items: ReadonlyArray<T>,
  keys: readonly [A, B, K],
): { [P in A | B]: T } & { [P in K]?: T[] } {
  const [first, second, rest] = requirePair(items);
  return {
    [keys[0]]: first,
    [keys[1]]: second,
    ...(rest.length > 0 ? { [keys[2]]: [...rest] } : {}),
  } as { [P in A | B]: T } & { [P in K]?: T[] };
}

// ---------------------------------------------------------------------------
// Create inputs and commands
// ---------------------------------------------------------------------------

/** Ordered author slots of a planning create input. */
export function planningInputAuthorSlots(input: {
  readonly branchA: WorkflowModelSlot;
  readonly branchB: WorkflowModelSlot;
  readonly additionalBranches?: ReadonlyArray<WorkflowModelSlot> | undefined;
}): WorkflowModelSlot[] {
  return [input.branchA, input.branchB, ...(input.additionalBranches ?? [])];
}

/** Ordered reviewer slots of a code review create input or port review request. */
export function codeReviewInputReviewerSlots(input: {
  readonly reviewerA: WorkflowModelSlot;
  readonly reviewerB: WorkflowModelSlot;
  readonly additionalReviewers?: ReadonlyArray<WorkflowModelSlot> | undefined;
}): WorkflowModelSlot[] {
  return [input.reviewerA, input.reviewerB, ...(input.additionalReviewers ?? [])];
}

/** Ordered investigator slots of an investigation create input. */
export function investigationInputInvestigatorSlots(input: {
  readonly investigatorA: WorkflowModelSlot;
  readonly investigatorB: WorkflowModelSlot;
  readonly additionalInvestigators?: ReadonlyArray<WorkflowModelSlot> | undefined;
}): WorkflowModelSlot[] {
  return [input.investigatorA, input.investigatorB, ...(input.additionalInvestigators ?? [])];
}

/** Ordered slots → create-input fields; extras are sent only for more than two actors. */
export function planningInputAuthorFields(slots: ReadonlyArray<WorkflowModelSlot>): {
  branchA: WorkflowModelSlot;
  branchB: WorkflowModelSlot;
  additionalBranches?: WorkflowModelSlot[];
} {
  return pairFields(slots, ["branchA", "branchB", "additionalBranches"] as const);
}

export function codeReviewInputReviewerFields(slots: ReadonlyArray<WorkflowModelSlot>): {
  reviewerA: WorkflowModelSlot;
  reviewerB: WorkflowModelSlot;
  additionalReviewers?: WorkflowModelSlot[];
} {
  return pairFields(slots, ["reviewerA", "reviewerB", "additionalReviewers"] as const);
}

export function investigationInputInvestigatorFields(slots: ReadonlyArray<WorkflowModelSlot>): {
  investigatorA: WorkflowModelSlot;
  investigatorB: WorkflowModelSlot;
  additionalInvestigators?: WorkflowModelSlot[];
} {
  return pairFields(slots, ["investigatorA", "investigatorB", "additionalInvestigators"] as const);
}

/** Planning create command → ordered authors. */
export function planningCommandAuthors(command: {
  readonly authorThreadIdA: ThreadId;
  readonly authorThreadIdB: ThreadId;
  readonly branchA: WorkflowModelSlot;
  readonly branchB: WorkflowModelSlot;
  readonly additionalBranches?:
    | ReadonlyArray<{ readonly authorSlot: WorkflowModelSlot; readonly authorThreadId: ThreadId }>
    | undefined;
}): WorkflowActorSeed[] {
  return [
    { slot: command.branchA, threadId: command.authorThreadIdA },
    { slot: command.branchB, threadId: command.authorThreadIdB },
    ...(command.additionalBranches ?? []).map((entry) => ({
      slot: entry.authorSlot,
      threadId: entry.authorThreadId,
    })),
  ];
}

/** Ordered authors → planning create command fields. */
export function planningCommandAuthorFields(authors: ReadonlyArray<WorkflowActorSeed>) {
  const [first, second, rest] = requirePair(authors);
  return {
    authorThreadIdA: first.threadId,
    authorThreadIdB: second.threadId,
    branchA: first.slot,
    branchB: second.slot,
    ...(rest.length > 0
      ? {
          additionalBranches: rest.map((entry) => ({
            authorSlot: entry.slot,
            authorThreadId: entry.threadId,
          })),
        }
      : {}),
  };
}

export function codeReviewCommandReviewers(command: {
  readonly reviewerThreadIdA: ThreadId;
  readonly reviewerThreadIdB: ThreadId;
  readonly reviewerA: WorkflowModelSlot;
  readonly reviewerB: WorkflowModelSlot;
  readonly additionalReviewers?:
    | ReadonlyArray<{ readonly slot: WorkflowModelSlot; readonly threadId: ThreadId }>
    | undefined;
}): WorkflowActorSeed[] {
  return [
    { slot: command.reviewerA, threadId: command.reviewerThreadIdA },
    { slot: command.reviewerB, threadId: command.reviewerThreadIdB },
    ...(command.additionalReviewers ?? []).map((entry) => ({
      slot: entry.slot,
      threadId: entry.threadId,
    })),
  ];
}

export function codeReviewCommandReviewerFields(reviewers: ReadonlyArray<WorkflowActorSeed>) {
  const [first, second, rest] = requirePair(reviewers);
  return {
    reviewerThreadIdA: first.threadId,
    reviewerThreadIdB: second.threadId,
    reviewerA: first.slot,
    reviewerB: second.slot,
    ...(rest.length > 0
      ? {
          additionalReviewers: rest.map((entry) => ({
            slot: entry.slot,
            threadId: entry.threadId,
          })),
        }
      : {}),
  };
}

export function investigationCommandInvestigators(command: {
  readonly investigationThreadIdA: ThreadId;
  readonly investigationThreadIdB: ThreadId;
  readonly investigatorA: WorkflowModelSlot;
  readonly investigatorB: WorkflowModelSlot;
  readonly additionalInvestigators?:
    | ReadonlyArray<{ readonly slot: WorkflowModelSlot; readonly investigationThreadId: ThreadId }>
    | undefined;
}): WorkflowActorSeed[] {
  return [
    { slot: command.investigatorA, threadId: command.investigationThreadIdA },
    { slot: command.investigatorB, threadId: command.investigationThreadIdB },
    ...(command.additionalInvestigators ?? []).map((entry) => ({
      slot: entry.slot,
      threadId: entry.investigationThreadId,
    })),
  ];
}

export function investigationCommandInvestigatorFields(
  investigators: ReadonlyArray<WorkflowActorSeed>,
) {
  const [first, second, rest] = requirePair(investigators);
  return {
    investigationThreadIdA: first.threadId,
    investigationThreadIdB: second.threadId,
    investigatorA: first.slot,
    investigatorB: second.slot,
    ...(rest.length > 0
      ? {
          additionalInvestigators: rest.map((entry) => ({
            slot: entry.slot,
            investigationThreadId: entry.threadId,
          })),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export function buildPlanningWorkflowRecord(
  input: VersionedRecordInput & {
    readonly workflowId: PlanningWorkflowId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly slug: string;
    readonly requirementPrompt: string;
    readonly plansDirectory: string;
    readonly selfReviewEnabled: boolean;
    readonly documentType?: WorkflowDocumentType | undefined;
    readonly readerReviewEnabled?: boolean | undefined;
    readonly readerPersona?: string | undefined;
    readonly readerSlot?: WorkflowModelSlot | undefined;
    readonly authors: ReadonlyArray<WorkflowActorSeed>;
    readonly merge: WorkflowModelSlot;
    readonly maxCostUsd?: number | undefined;
    readonly createdAt: string;
  },
): PlanningWorkflow {
  const ids = workflowParticipantIds(input.authors.length);
  const branches = input.authors.map(
    (author, index): WorkflowBranch => ({
      branchId: ids[index]!,
      authorSlot: author.slot,
      authorThreadId: author.threadId,
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      errorStage: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: input.createdAt,
    }),
  );
  return {
    id: input.workflowId,
    projectId: input.projectId,
    title: input.title,
    slug: input.slug,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    requirementPrompt: input.requirementPrompt,
    plansDirectory: input.plansDirectory,
    selfReviewEnabled: input.selfReviewEnabled,
    documentType: input.documentType ?? null,
    readerReviewEnabled: input.readerReviewEnabled ?? false,
    readerPersona: input.readerPersona ?? null,
    readerSlot: input.readerSlot ?? null,
    readerPass: null,
    ...pairFields(branches, ["branchA", "branchB", "additionalBranches"] as const),
    merge: {
      mergeSlot: input.merge,
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      updatedAt: input.createdAt,
    },
    implementation: null,
    totalCostUsd: 0,
    maxCostUsd: input.maxCostUsd ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    deletedAt: null,
  } as PlanningWorkflow;
}

export function buildCodeReviewWorkflowRecord(
  input: VersionedRecordInput & {
    readonly workflowId: CodeReviewWorkflowId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly slug: string;
    readonly reviewPrompt: string;
    readonly branch: string | null;
    readonly reviewers: ReadonlyArray<WorkflowActorSeed>;
    readonly consolidation: WorkflowModelSlot;
    readonly maxCostUsd?: number | undefined;
    readonly pullRequest?: CodeReviewWorkflow["pullRequest"] | undefined;
    readonly autoPost?: boolean | undefined;
    readonly createdAt: string;
  },
): CodeReviewWorkflow {
  const ids = workflowParticipantIds(input.reviewers.length);
  const reviewers = input.reviewers.map(
    (reviewer, index): CodeReviewReviewer => ({
      label: `Reviewer ${workflowParticipantLabel(ids[index]!)} (${slotLabel(reviewer.slot)})`,
      slot: reviewer.slot,
      threadId: reviewer.threadId,
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      retryCount: 0,
      updatedAt: input.createdAt,
    }),
  );
  return {
    id: input.workflowId,
    projectId: input.projectId,
    title: input.title,
    slug: input.slug,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    reviewPrompt: input.reviewPrompt,
    branch: input.branch,
    pullRequest: input.pullRequest ?? null,
    autoPost: input.autoPost ?? false,
    post: null,
    ...pairFields(reviewers, ["reviewerA", "reviewerB", "additionalReviewers"] as const),
    consolidation: {
      slot: input.consolidation,
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      retryCount: 0,
      updatedAt: input.createdAt,
    },
    totalCostUsd: 0,
    maxCostUsd: input.maxCostUsd ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    deletedAt: null,
  } as CodeReviewWorkflow;
}

export function buildInvestigationWorkflowRecord(
  input: VersionedRecordInput & {
    readonly workflowId: InvestigationWorkflowId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly slug: string;
    readonly problemPrompt: string;
    readonly branch: string | null;
    readonly selfReviewEnabled: boolean;
    readonly investigators: ReadonlyArray<WorkflowActorSeed>;
    readonly synthesis: WorkflowModelSlot;
    readonly maxCostUsd?: number | undefined;
    readonly createdAt: string;
  },
): InvestigationWorkflow {
  const ids = workflowParticipantIds(input.investigators.length);
  const mesh = workflowUsesMesh(ids.length);
  const investigators = input.investigators.map(
    (investigator, index): InvestigationInvestigator => ({
      label: `Investigator ${workflowParticipantLabel(ids[index]!)} (${slotLabel(investigator.slot)})`,
      slot: investigator.slot,
      investigationThreadId: investigator.threadId,
      investigationStatus: "pending",
      investigationTurnId: null,
      investigationMessageId: null,
      crossReviewThreadId: null,
      crossReviewStatus: "not_started",
      crossReviewTurnId: null,
      crossReviewMessageId: null,
      selfReviewThreadId: null,
      selfReviewStatus: "not_started",
      selfReviewTurnId: null,
      selfReviewMessageId: null,
      error: null,
      investigationRetryCount: 0,
      crossReviewRetryCount: 0,
      selfReviewRetryCount: 0,
      ...(mesh
        ? {
            crossReviews: ids
              .filter((id) => id !== ids[index])
              .map((revieweeId) => initialInvestigationCrossReview(revieweeId, input.createdAt)),
          }
        : {}),
      updatedAt: input.createdAt,
    }),
  );
  return {
    id: input.workflowId,
    projectId: input.projectId,
    title: input.title,
    slug: input.slug,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    problemPrompt: input.problemPrompt,
    branch: input.branch,
    selfReviewEnabled: input.selfReviewEnabled,
    ...pairFields(investigators, [
      "investigatorA",
      "investigatorB",
      "additionalInvestigators",
    ] as const),
    synthesis: {
      slot: input.synthesis,
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      retryCount: 0,
      updatedAt: input.createdAt,
    },
    totalCostUsd: 0,
    maxCostUsd: input.maxCostUsd ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    deletedAt: null,
  } as InvestigationWorkflow;
}
