import type { MessageId, TurnId } from "@t3tools/contracts";

export interface RevertImpactMessage {
  readonly id: MessageId;
  readonly turnId?: TurnId | null | undefined;
}

export interface RevertImpactTurnDiff {
  readonly files: ReadonlyArray<{ readonly path: string }>;
}

export interface RevertImpact {
  /** Messages removed by the revert, including the target itself. */
  readonly removedMessageCount: number;
  /** Messages after the target that are removed with it. */
  readonly laterMessageCount: number;
  /** Distinct files changed by the removed turns, according to their diff summaries. */
  readonly changedFileCount: number;
}

/**
 * What reverting to `targetMessageId` removes. Reverting drops the target
 * message and everything after it; its prompt is offered back as a draft.
 */
export function computeRevertImpact(
  messages: ReadonlyArray<RevertImpactMessage>,
  targetMessageId: MessageId,
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, RevertImpactTurnDiff>,
): RevertImpact | null {
  const targetIndex = messages.findIndex((message) => message.id === targetMessageId);
  if (targetIndex < 0) return null;
  const removed = messages.slice(targetIndex);
  const turnIds = new Set<TurnId>();
  for (const message of removed) if (message.turnId) turnIds.add(message.turnId);
  const paths = new Set<string>();
  for (const turnId of turnIds)
    for (const file of turnDiffSummaryByTurnId.get(turnId)?.files ?? []) paths.add(file.path);
  return {
    removedMessageCount: removed.length,
    laterMessageCount: removed.length - 1,
    changedFileCount: paths.size,
  };
}

export function describeRevertRemoval(impact: RevertImpact | null): string {
  if (!impact || impact.laterMessageCount === 0) return "Removes this message.";
  if (impact.laterMessageCount === 1) return "Removes this message and the one after it.";
  return `Removes this message and the ${impact.laterMessageCount} after it.`;
}

export function describeRevertFiles(impact: RevertImpact | null, restoreFiles: boolean): string {
  if (!restoreFiles) return "Your files stay exactly as they are now.";
  const count = impact?.changedFileCount ?? 0;
  if (count === 0) return "Files go back to how they were before this message.";
  return `Restores ${count} ${count === 1 ? "file" : "files"} to how they were before this message.`;
}
