/**
 * Roster access for workflow actors (authors, reviewers, investigators).
 *
 * Records keep the first two actors in their historical pair fields (`branchA`/`branchB`,
 * `reviewerA`/`reviewerB`, `investigatorA`/`investigatorB`) and any further actors in an optional
 * `additional*` array, so two-actor records stay byte-identical. Every reader and writer goes
 * through this module: actors are addressed by participant id, never by pair field or index.
 */
import {
  WORKFLOW_MESH_MAX_PARTICIPANTS,
  WORKFLOW_PARTICIPANT_IDS,
  WORKFLOW_REVIEW_MAX_PARTICIPANTS,
  type CommandId,
  type InvestigationCrossReview,
  type InvestigationPhaseStatus,
  type ThreadId,
  type WorkflowModelSlot,
  type WorkflowParticipantId,
  type WorkflowReviewSlot,
} from "@t3tools/contracts";

export class WorkflowParticipantInvariantError extends Error {
  override readonly name = "WorkflowParticipantInvariantError";
}

// ---------------------------------------------------------------------------
// Ids, labels and slots
// ---------------------------------------------------------------------------

export function workflowParticipantIds(count: number): WorkflowParticipantId[] {
  if (count < 0 || count > WORKFLOW_PARTICIPANT_IDS.length) {
    throw new WorkflowParticipantInvariantError(`Unsupported workflow actor count ${count}.`);
  }
  return WORKFLOW_PARTICIPANT_IDS.slice(0, count);
}

export function workflowParticipantIndex(id: WorkflowParticipantId): number {
  return WORKFLOW_PARTICIPANT_IDS.indexOf(id);
}

/** `"a"` → `"A"`. */
export function workflowParticipantLabel(id: WorkflowParticipantId): string {
  return id.toUpperCase();
}

/** Runs with more than two actors use the full-mesh ids, labels, node ids and prompts. */
export function workflowUsesMesh(count: number): boolean {
  return count > 2;
}

/** Whether two slots name the same provider and model. */
export function workflowModelSlotsMatch(
  left: Pick<WorkflowModelSlot, "provider" | "model">,
  right: Pick<WorkflowModelSlot, "provider" | "model">,
): boolean {
  return left.provider === right.provider && left.model === right.model;
}

export function workflowModelSlotsHaveDuplicate(
  slots: ReadonlyArray<Pick<WorkflowModelSlot, "provider" | "model">>,
): boolean {
  return slots.some((slot, index) =>
    slots.slice(index + 1).some((other) => workflowModelSlotsMatch(slot, other)),
  );
}

export type WorkflowActorKind = "planning" | "document" | "codeReview" | "investigation";

/** Largest roster each workflow type accepts. */
export function workflowMaxParticipants(kind: WorkflowActorKind): number {
  return kind === "codeReview" ? WORKFLOW_REVIEW_MAX_PARTICIPANTS : WORKFLOW_MESH_MAX_PARTICIPANTS;
}

/** Turns a run will dispatch for its actors (excluding the single merge/synthesis/consolidation). */
export interface WorkflowTurnEstimate {
  readonly actors: number;
  readonly crossReviews: number;
  readonly ownModelReviews: number;
  readonly revisions: number;
  readonly finalTurns: number;
}

export function workflowTurnEstimate(
  kind: WorkflowActorKind,
  count: number,
  selfReviewEnabled: boolean,
): WorkflowTurnEstimate {
  if (kind === "codeReview") {
    return { actors: count, crossReviews: 0, ownModelReviews: 0, revisions: 0, finalTurns: 1 };
  }
  return {
    actors: count,
    crossReviews: count * (count - 1),
    ownModelReviews: selfReviewEnabled ? count : 0,
    revisions: kind === "investigation" ? 0 : count,
    finalTurns: 1,
  };
}

// ---------------------------------------------------------------------------
// Generic pair + additional roster access
// ---------------------------------------------------------------------------

function rosterItems<T>(first: T, second: T, additional: ReadonlyArray<T> | undefined): T[] {
  return [first, second, ...(additional ?? [])];
}

function requireIndex(id: WorkflowParticipantId, count: number, kind: string): number {
  const index = workflowParticipantIndex(id);
  if (index < 0 || index >= count) {
    throw new WorkflowParticipantInvariantError(
      `Workflow has no ${kind} '${workflowParticipantLabel(id)}'.`,
    );
  }
  return index;
}

function replaceAdditional<T>(
  additional: ReadonlyArray<T> | undefined,
  index: number,
  next: T,
): T[] {
  const items = [...(additional ?? [])];
  items[index - 2] = next;
  return items;
}

// ---------------------------------------------------------------------------
// Planning (Feature and Document)
// ---------------------------------------------------------------------------

export interface PlanningRoster<B> {
  readonly branchA: B;
  readonly branchB: B;
  readonly additionalBranches?: ReadonlyArray<B> | undefined;
  readonly selfReviewEnabled?: boolean | undefined;
}

interface PlanningBranchShape {
  readonly branchId: WorkflowParticipantId;
  readonly reviews: ReadonlyArray<{
    readonly slot: WorkflowReviewSlot;
    readonly reviewerBranchId?: WorkflowParticipantId | undefined;
  }>;
}

export function planningBranches<B>(workflow: PlanningRoster<B>): B[] {
  return rosterItems(workflow.branchA, workflow.branchB, workflow.additionalBranches);
}

export function planningBranchIds(workflow: PlanningRoster<unknown>): WorkflowParticipantId[] {
  return workflowParticipantIds(planningBranches(workflow).length);
}

export function requirePlanningBranch<B>(
  workflow: PlanningRoster<B>,
  id: WorkflowParticipantId,
): B {
  const branches = planningBranches(workflow);
  return branches[requireIndex(id, branches.length, "author")]!;
}

export function findPlanningBranch<B>(
  workflow: PlanningRoster<B>,
  id: WorkflowParticipantId,
): B | undefined {
  const index = workflowParticipantIndex(id);
  return index < 0 ? undefined : planningBranches(workflow)[index];
}

export function updatePlanningBranch<W extends PlanningRoster<unknown>>(
  workflow: W,
  id: WorkflowParticipantId,
  update: (branch: W["branchA"]) => W["branchA"],
): W {
  const branches = planningBranches(workflow) as Array<W["branchA"]>;
  const index = requireIndex(id, branches.length, "author");
  const next = update(branches[index]!);
  if (index === 0) return { ...workflow, branchA: next };
  if (index === 1) return { ...workflow, branchB: next };
  return {
    ...workflow,
    additionalBranches: replaceAdditional(workflow.additionalBranches, index, next),
  };
}

export interface PlanReviewEdge {
  readonly slot: WorkflowReviewSlot;
  readonly reviewerBranchId: WorkflowParticipantId;
}

/** Reviews a branch's plan expects: one cross review per other branch in id order, then self. */
export function expectedPlanReviewEdges(
  workflow: PlanningRoster<unknown>,
  reviewedId: WorkflowParticipantId,
): PlanReviewEdge[] {
  const ids = planningBranchIds(workflow);
  const edges: PlanReviewEdge[] = ids
    .filter((id) => id !== reviewedId)
    .map((reviewerBranchId) => ({ slot: "cross", reviewerBranchId }));
  if (workflow.selfReviewEnabled !== false)
    edges.push({ slot: "self", reviewerBranchId: reviewedId });
  return edges;
}

/** The branch whose author model writes a review of `reviewedId`'s plan. */
export function planReviewReviewerBranchId(
  workflow: PlanningRoster<unknown>,
  reviewedId: WorkflowParticipantId,
  review: {
    readonly slot: WorkflowReviewSlot;
    readonly reviewerBranchId?: WorkflowParticipantId | undefined;
  },
): WorkflowParticipantId {
  if (review.reviewerBranchId) return review.reviewerBranchId;
  if (review.slot === "self") return reviewedId;
  const others = planningBranchIds(workflow).filter((id) => id !== reviewedId);
  if (others.length !== 1) {
    throw new WorkflowParticipantInvariantError(
      `Cross review of plan ${workflowParticipantLabel(reviewedId)} does not name its reviewer.`,
    );
  }
  return others[0]!;
}

/** Validation message for a planning record's branch ids and review edges, or null. */
export function planReviewEdgesError(workflow: PlanningRoster<PlanningBranchShape>): string | null {
  const branches = planningBranches(workflow);
  const ids = workflowParticipantIds(branches.length);
  for (const [index, branch] of branches.entries()) {
    if (branch.branchId !== ids[index]) {
      return `Workflow branch ${index + 1} must have id '${ids[index]}'.`;
    }
  }
  if (!workflowUsesMesh(branches.length)) return null;
  for (const branch of branches) {
    if (branch.reviews.length === 0) continue;
    const expected = expectedPlanReviewEdges(workflow, branch.branchId);
    const label = workflowParticipantLabel(branch.branchId);
    if (branch.reviews.length !== expected.length) {
      return `Plan ${label} must hold all ${expected.length} expected reviews.`;
    }
    for (const edge of expected) {
      const matches = branch.reviews.filter(
        (review) => review.slot === edge.slot && review.reviewerBranchId === edge.reviewerBranchId,
      );
      if (matches.length !== 1) {
        return `Plan ${label} must hold exactly one ${edge.slot} review by ${workflowParticipantLabel(edge.reviewerBranchId)}.`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Code Review
// ---------------------------------------------------------------------------

export interface CodeReviewRoster<R> {
  readonly reviewerA: R;
  readonly reviewerB: R;
  readonly additionalReviewers?: ReadonlyArray<R> | undefined;
}

export function codeReviewReviewers<R>(
  workflow: CodeReviewRoster<R>,
): Array<{ readonly id: WorkflowParticipantId; readonly reviewer: R }> {
  const reviewers = rosterItems(
    workflow.reviewerA,
    workflow.reviewerB,
    workflow.additionalReviewers,
  );
  const ids = workflowParticipantIds(reviewers.length);
  return reviewers.map((reviewer, index) => ({ id: ids[index]!, reviewer }));
}

export function requireCodeReviewReviewer<R>(
  workflow: CodeReviewRoster<R>,
  id: WorkflowParticipantId,
): R {
  const reviewers = codeReviewReviewers(workflow);
  return reviewers[requireIndex(id, reviewers.length, "reviewer")]!.reviewer;
}

export function updateCodeReviewReviewer<W extends CodeReviewRoster<unknown>>(
  workflow: W,
  id: WorkflowParticipantId,
  update: (reviewer: W["reviewerA"]) => W["reviewerA"],
): W {
  const reviewers = codeReviewReviewers(workflow) as Array<{ reviewer: W["reviewerA"] }>;
  const index = requireIndex(id, reviewers.length, "reviewer");
  const next = update(reviewers[index]!.reviewer);
  if (index === 0) return { ...workflow, reviewerA: next };
  if (index === 1) return { ...workflow, reviewerB: next };
  return {
    ...workflow,
    additionalReviewers: replaceAdditional(workflow.additionalReviewers, index, next),
  };
}

// ---------------------------------------------------------------------------
// Investigation
// ---------------------------------------------------------------------------

export interface InvestigationRoster<I> {
  readonly investigatorA: I;
  readonly investigatorB: I;
  readonly additionalInvestigators?: ReadonlyArray<I> | undefined;
}

/** The investigator fields the cross-review view reads and writes. */
export interface InvestigatorCrossReviewFields {
  readonly crossReviewThreadId: ThreadId | null;
  readonly crossReviewStatus: InvestigationPhaseStatus;
  readonly crossReviewTurnId: string | null;
  readonly crossReviewMessageId: string | null;
  readonly crossReviewRetryCount?: number | undefined;
  readonly crossReviewDispatchCommandId?: CommandId | null | undefined;
  readonly investigationStatus: string;
  readonly selfReviewStatus: string;
  readonly error: string | null;
  readonly crossReviews?: ReadonlyArray<InvestigationCrossReview> | undefined;
}

export function investigationInvestigators<I>(
  workflow: InvestigationRoster<I>,
): Array<{ readonly id: WorkflowParticipantId; readonly investigator: I }> {
  const investigators = rosterItems(
    workflow.investigatorA,
    workflow.investigatorB,
    workflow.additionalInvestigators,
  );
  const ids = workflowParticipantIds(investigators.length);
  return investigators.map((investigator, index) => ({ id: ids[index]!, investigator }));
}

export function requireInvestigator<I>(
  workflow: InvestigationRoster<I>,
  id: WorkflowParticipantId,
): I {
  const investigators = investigationInvestigators(workflow);
  return investigators[requireIndex(id, investigators.length, "investigator")]!.investigator;
}

export function updateInvestigator<W extends InvestigationRoster<unknown>>(
  workflow: W,
  id: WorkflowParticipantId,
  update: (investigator: W["investigatorA"]) => W["investigatorA"],
): W {
  const investigators = investigationInvestigators(workflow) as Array<{
    investigator: W["investigatorA"];
  }>;
  const index = requireIndex(id, investigators.length, "investigator");
  const next = update(investigators[index]!.investigator);
  if (index === 0) return { ...workflow, investigatorA: next };
  if (index === 1) return { ...workflow, investigatorB: next };
  return {
    ...workflow,
    additionalInvestigators: replaceAdditional(workflow.additionalInvestigators, index, next),
  };
}

/**
 * The investigator's shared `error`, cleared for `phase` unless another phase of the same
 * investigator is still in error. On mesh runs cross-review errors live on their own edges.
 */
export function clearInvestigatorErrorForPhase(
  investigator: Pick<
    InvestigatorCrossReviewFields,
    "investigationStatus" | "crossReviewStatus" | "selfReviewStatus" | "error"
  >,
  phase: "investigation" | "crossReview" | "selfReview",
): string | null {
  const hasOtherPhaseError =
    (phase !== "investigation" && investigator.investigationStatus === "error") ||
    (phase !== "crossReview" && investigator.crossReviewStatus === "error") ||
    (phase !== "selfReview" && investigator.selfReviewStatus === "error");
  return hasOtherPhaseError ? investigator.error : null;
}

/** One expected directed cross-review: `reviewerId` reviews `revieweeId`'s report. */
export interface InvestigationCrossReviewView {
  readonly reviewerId: WorkflowParticipantId;
  readonly revieweeId: WorkflowParticipantId;
  readonly threadId: ThreadId | null;
  readonly status: InvestigationPhaseStatus;
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly error: string | null;
  readonly retryCount: number;
  readonly dispatchCommandId: CommandId | null;
}

export interface InvestigationCrossReviewEdge {
  readonly reviewerId: WorkflowParticipantId;
  readonly revieweeId: WorkflowParticipantId;
}

export interface InvestigationCrossReviewPatch {
  readonly threadId?: ThreadId | null;
  readonly status?: InvestigationPhaseStatus;
  readonly turnId?: string | null;
  readonly messageId?: string | null;
  /** `null` clears this edge's error (legacy: unless another phase is still in error). */
  readonly error?: string | null;
  readonly retryCount?: number;
  readonly dispatchCommandId?: CommandId | null;
}

export function sameInvestigationCrossReviewEdge(
  left: InvestigationCrossReviewEdge,
  right: InvestigationCrossReviewEdge,
): boolean {
  return left.reviewerId === right.reviewerId && left.revieweeId === right.revieweeId;
}

/** Every expected directed cross-review edge, by reviewer id then reviewee id. */
export function investigationCrossReviews(
  workflow: InvestigationRoster<InvestigatorCrossReviewFields>,
): InvestigationCrossReviewView[] {
  const investigators = investigationInvestigators(workflow);
  const mesh = workflowUsesMesh(investigators.length);
  return investigators.flatMap(({ id: reviewerId, investigator }) => {
    if (!mesh) {
      const revieweeId = investigators.find((entry) => entry.id !== reviewerId)!.id;
      return [
        {
          reviewerId,
          revieweeId,
          threadId: investigator.crossReviewThreadId,
          status: investigator.crossReviewStatus,
          turnId: investigator.crossReviewTurnId,
          messageId: investigator.crossReviewMessageId,
          error: investigator.crossReviewStatus === "error" ? investigator.error : null,
          retryCount: investigator.crossReviewRetryCount ?? 0,
          dispatchCommandId: investigator.crossReviewDispatchCommandId ?? null,
        },
      ];
    }
    return investigators
      .filter((entry) => entry.id !== reviewerId)
      .flatMap(({ id: revieweeId }) => {
        const entry = investigator.crossReviews?.find((review) => review.revieweeId === revieweeId);
        if (!entry) return [];
        return [
          {
            reviewerId,
            revieweeId,
            threadId: entry.threadId,
            status: entry.status,
            turnId: entry.turnId,
            messageId: entry.messageId,
            error: entry.error,
            retryCount: entry.retryCount ?? 0,
            dispatchCommandId: entry.dispatchCommandId ?? null,
          },
        ];
      });
  });
}

export function findInvestigationCrossReview(
  workflow: InvestigationRoster<InvestigatorCrossReviewFields>,
  edge: InvestigationCrossReviewEdge,
): InvestigationCrossReviewView | undefined {
  return investigationCrossReviews(workflow).find((view) =>
    sameInvestigationCrossReviewEdge(view, edge),
  );
}

/** Cross-reviews of one investigator's report, by reviewer id. */
export function investigationCrossReviewsOf(
  workflow: InvestigationRoster<InvestigatorCrossReviewFields>,
  revieweeId: WorkflowParticipantId,
): InvestigationCrossReviewView[] {
  return investigationCrossReviews(workflow).filter((view) => view.revieweeId === revieweeId);
}

/** The one writer for both cross-review storage forms. */
export function updateInvestigationCrossReview<
  W extends InvestigationRoster<InvestigatorCrossReviewFields>,
>(
  workflow: W,
  edge: InvestigationCrossReviewEdge,
  patch: InvestigationCrossReviewPatch,
  updatedAt: string,
): W {
  const mesh = workflowUsesMesh(investigationInvestigators(workflow).length);
  return updateInvestigator(workflow, edge.reviewerId, (investigator) => {
    if (!mesh) {
      const status = patch.status ?? investigator.crossReviewStatus;
      const error =
        patch.error === undefined
          ? investigator.error
          : patch.error === null
            ? clearInvestigatorErrorForPhase(investigator, "crossReview")
            : patch.error;
      return {
        ...investigator,
        ...(patch.threadId !== undefined ? { crossReviewThreadId: patch.threadId } : {}),
        crossReviewStatus: status,
        ...(patch.turnId !== undefined ? { crossReviewTurnId: patch.turnId } : {}),
        ...(patch.messageId !== undefined ? { crossReviewMessageId: patch.messageId } : {}),
        ...(patch.retryCount !== undefined ? { crossReviewRetryCount: patch.retryCount } : {}),
        ...(patch.dispatchCommandId !== undefined
          ? { crossReviewDispatchCommandId: patch.dispatchCommandId }
          : {}),
        error,
        updatedAt,
      };
    }
    const entries = investigator.crossReviews ?? [];
    if (!entries.some((entry) => entry.revieweeId === edge.revieweeId)) {
      throw new WorkflowParticipantInvariantError(
        `Investigator ${workflowParticipantLabel(edge.reviewerId)} has no cross-review of ${workflowParticipantLabel(edge.revieweeId)}.`,
      );
    }
    return {
      ...investigator,
      crossReviews: entries.map((entry) =>
        entry.revieweeId !== edge.revieweeId
          ? entry
          : {
              ...entry,
              ...(patch.threadId !== undefined ? { threadId: patch.threadId } : {}),
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.turnId !== undefined ? { turnId: patch.turnId } : {}),
              ...(patch.messageId !== undefined ? { messageId: patch.messageId } : {}),
              ...(patch.error !== undefined ? { error: patch.error } : {}),
              ...(patch.retryCount !== undefined ? { retryCount: patch.retryCount } : {}),
              ...(patch.dispatchCommandId !== undefined
                ? { dispatchCommandId: patch.dispatchCommandId }
                : {}),
              updatedAt,
            },
      ),
      updatedAt,
    };
  });
}

/** A fresh `not_started` mesh cross-review entry. */
export function initialInvestigationCrossReview(
  revieweeId: WorkflowParticipantId,
  updatedAt: string,
): InvestigationCrossReview {
  return {
    revieweeId,
    threadId: null,
    status: "not_started",
    turnId: null,
    messageId: null,
    error: null,
    retryCount: 0,
    dispatchCommandId: null,
    updatedAt,
  };
}

/** Validation message for an investigation record's cross-review storage, or null. */
export function investigationCrossReviewsError(
  workflow: InvestigationRoster<InvestigatorCrossReviewFields>,
): string | null {
  const investigators = investigationInvestigators(workflow);
  const mesh = workflowUsesMesh(investigators.length);
  for (const { id, investigator } of investigators) {
    const label = workflowParticipantLabel(id);
    if (!mesh) {
      if (investigator.crossReviews !== undefined) {
        return `Investigator ${label} must keep its cross-review in the single cross-review fields.`;
      }
      continue;
    }
    const expected = investigators.filter((entry) => entry.id !== id).map((entry) => entry.id);
    const entries = investigator.crossReviews ?? [];
    if (
      entries.length !== expected.length ||
      expected.some(
        (revieweeId) => entries.filter((entry) => entry.revieweeId === revieweeId).length !== 1,
      )
    ) {
      return `Investigator ${label} needs exactly one cross-review per other investigator.`;
    }
  }
  return null;
}
