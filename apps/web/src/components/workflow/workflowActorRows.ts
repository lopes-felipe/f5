import type { ProviderKind, ProviderModelOptions, ServerProvider } from "@t3tools/contracts";
import {
  workflowMaxParticipants,
  workflowModelSlotsMatch,
  workflowParticipantIds,
  workflowParticipantLabel,
  workflowTurnEstimate,
  type WorkflowActorKind,
} from "@t3tools/shared/workflowParticipants";
import { readOnlyWorkflowUnsupportedReason } from "@t3tools/shared/workflowProviders";

import type { WorkflowTypeValue } from "../../lib/workflowType";
import {
  AVAILABLE_PROVIDER_OPTIONS,
  findProviderStatus,
  isProviderSelectable,
} from "../chat/providerIconUtils";

/** One author, reviewer or investigator row of the New workflow dialog. */
export interface WorkflowActorRow {
  /** Stable client key; survives relabelling when an earlier row is removed. */
  readonly key: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly modelOptions: ProviderModelOptions | undefined;
}

const ACTOR_NOUN: Record<
  WorkflowTypeValue,
  { readonly singular: string; readonly plural: string }
> = {
  planning: { singular: "Author", plural: "authors" },
  document: { singular: "Author", plural: "authors" },
  codeReview: { singular: "Reviewer", plural: "reviewers" },
  investigation: { singular: "Investigator", plural: "investigators" },
};

const TYPE_NAME: Record<WorkflowTypeValue, string> = {
  planning: "Feature workflows",
  document: "Document workflows",
  codeReview: "Code review workflows",
  investigation: "Investigation workflows",
};

const FINAL_TURN_NAME: Record<WorkflowTypeValue, string> = {
  planning: "merge",
  document: "merge",
  codeReview: "consolidation",
  investigation: "synthesis",
};

export function workflowActorKind(type: WorkflowTypeValue): WorkflowActorKind {
  return type;
}

export function workflowActorMax(type: WorkflowTypeValue): number {
  return workflowMaxParticipants(workflowActorKind(type));
}

/** "Author C", "Reviewer E", "Investigator B". */
export function workflowActorRowLabel(type: WorkflowTypeValue, index: number): string {
  const id = workflowParticipantIds(index + 1)[index]!;
  return `${ACTOR_NOUN[type].singular} ${workflowParticipantLabel(id)}`;
}

export function workflowAddActorLabel(type: WorkflowTypeValue): string {
  return `Add ${ACTOR_NOUN[type].singular.toLowerCase()}`;
}

/** "Feature workflows support up to 4 authors." */
export function workflowActorLimitMessage(type: WorkflowTypeValue): string {
  return `${TYPE_NAME[type]} support up to ${workflowActorMax(type)} ${ACTOR_NOUN[type].plural}.`;
}

/** Document authors and investigators must all be different provider+model pairs. */
export function workflowActorsMustDiffer(type: WorkflowTypeValue): boolean {
  return type === "document" || type === "investigation";
}

/** Message for a duplicate model among more than two rows. */
export function workflowActorDuplicateMessage(type: WorkflowTypeValue): string {
  return type === "document"
    ? "Document workflows need a different model for every author."
    : "Investigation workflows need a different model for every investigator.";
}

/** Rows (by index) whose resolved provider+model repeats another row's, when the type forbids it. */
export function workflowActorDuplicateIndexes(
  type: WorkflowTypeValue,
  slots: ReadonlyArray<{ readonly provider: ProviderKind; readonly model: string }>,
): ReadonlySet<number> {
  const duplicates = new Set<number>();
  if (!workflowActorsMustDiffer(type)) return duplicates;
  slots.forEach((slot, index) => {
    if (
      slots.some(
        (other, otherIndex) => otherIndex !== index && workflowModelSlotsMatch(slot, other),
      )
    )
      duplicates.add(index);
  });
  return duplicates;
}

/** "3 authors: 6 cross-reviews, 3 own-model reviews, 3 revisions, 1 merge". */
export function formatWorkflowTurnEstimate(
  type: WorkflowTypeValue,
  count: number,
  selfReviewEnabled: boolean,
  /** Document runs end with a reader review and a polish turn when reader review is on. */
  readerReviewEnabled = false,
): string {
  const estimate = workflowTurnEstimate(workflowActorKind(type), count, selfReviewEnabled);
  const plural = (value: number, singular: string, pluralForm = `${singular}s`) =>
    `${value} ${value === 1 ? singular : pluralForm}`;
  const parts =
    type === "codeReview"
      ? [plural(estimate.actors, "review")]
      : [
          plural(estimate.crossReviews, "cross-review"),
          ...(estimate.ownModelReviews > 0
            ? [plural(estimate.ownModelReviews, "own-model review")]
            : []),
          ...(estimate.revisions > 0 ? [plural(estimate.revisions, "revision")] : []),
        ];
  parts.push(`${estimate.finalTurns} ${FINAL_TURN_NAME[type]}`);
  if (type === "document" && readerReviewEnabled) parts.push("1 reader review", "1 polish");
  return `${count} ${ACTOR_NOUN[type].plural}: ${parts.join(", ")}`;
}

/** Whether a provider can be chosen for a workflow row (enabled, available, read-only capable). */
export function workflowRowProviderUsable(
  provider: ProviderKind,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  const status = findProviderStatus(providers, provider);
  return (
    status !== null &&
    isProviderSelectable(status) &&
    readOnlyWorkflowUnsupportedReason(provider, providers) === null
  );
}

/**
 * The provider a new row starts on: the first usable provider no other row uses, or `null`
 * when every usable provider is taken (the caller then copies the last row for types that
 * allow repeats, or takes the first usable provider for the others).
 */
export function pickNewWorkflowActorProvider(
  rows: ReadonlyArray<Pick<WorkflowActorRow, "provider">>,
  providers: ReadonlyArray<ServerProvider>,
): ProviderKind | null {
  const used = new Set(rows.map((row) => row.provider));
  return (
    AVAILABLE_PROVIDER_OPTIONS.map((option) => option.value).find(
      (provider) => !used.has(provider) && workflowRowProviderUsable(provider, providers),
    ) ?? null
  );
}

export function firstUsableWorkflowProvider(
  providers: ReadonlyArray<ServerProvider>,
): ProviderKind | null {
  return (
    AVAILABLE_PROVIDER_OPTIONS.map((option) => option.value).find((provider) =>
      workflowRowProviderUsable(provider, providers),
    ) ?? null
  );
}
