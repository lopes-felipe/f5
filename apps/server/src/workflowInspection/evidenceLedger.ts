/**
 * Records failures to read a pinned review target, so a reviewer that could not
 * obtain its evidence is reported as failed instead of completed.
 */
import type { ThreadId } from "@t3tools/contracts";
import { Effect, Layer, ServiceMap } from "effect";

export interface WorkflowEvidenceFailure {
  readonly message: string;
  readonly at: string;
}

export interface WorkflowEvidenceLedgerShape {
  readonly recordFailure: (input: {
    readonly threadId: ThreadId;
    readonly key: string;
    readonly message: string;
  }) => Effect.Effect<void>;
  readonly recordSuccess: (input: {
    readonly threadId: ThreadId;
    readonly key: string;
  }) => Effect.Effect<void>;
  /** The earliest unresolved failure recorded at or after `since`. */
  readonly unresolvedFailureSince: (input: {
    readonly threadId: ThreadId;
    readonly since: string;
  }) => Effect.Effect<WorkflowEvidenceFailure | undefined>;
}

export class WorkflowEvidenceLedger extends ServiceMap.Service<
  WorkflowEvidenceLedger,
  WorkflowEvidenceLedgerShape
>()("t3/workflowInspection/evidenceLedger/WorkflowEvidenceLedger") {}

const MAX_THREADS = 512;

export function makeWorkflowEvidenceLedger(): WorkflowEvidenceLedgerShape {
  const failures = new Map<ThreadId, Map<string, WorkflowEvidenceFailure>>();
  return {
    recordFailure: ({ threadId, key, message }) =>
      Effect.sync(() => {
        const entries = failures.get(threadId) ?? new Map<string, WorkflowEvidenceFailure>();
        entries.set(key, { message, at: new Date().toISOString() });
        failures.delete(threadId);
        failures.set(threadId, entries);
        if (failures.size > MAX_THREADS) failures.delete(failures.keys().next().value!);
      }),
    recordSuccess: ({ threadId, key }) =>
      Effect.sync(() => {
        failures.get(threadId)?.delete(key);
      }),
    unresolvedFailureSince: ({ threadId, since }) =>
      Effect.sync(() =>
        [...(failures.get(threadId)?.values() ?? [])]
          .filter((failure) => failure.at >= since)
          .toSorted((left, right) => left.at.localeCompare(right.at))
          .at(0),
      ),
  };
}

export const WorkflowEvidenceLedgerLive = Layer.succeed(
  WorkflowEvidenceLedger,
  makeWorkflowEvidenceLedger(),
);
