import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface PersistedAccountSnapshot {
  readonly accountKey: string;
  readonly sectionKind: string;
  readonly identity: string;
  readonly fetchedAt: string;
  readonly dataJson: string;
}

export interface QuotaSampleRow {
  readonly accountKey: string;
  readonly windowKey: string;
  readonly identity: string;
  readonly sampledAt: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

export interface AccountObservation {
  readonly accountKey: string;
  readonly identity: string;
  readonly snapshots: ReadonlyArray<{
    readonly sectionKind: string;
    readonly fetchedAt: string;
    readonly dataJson: string;
  }>;
  readonly samples: ReadonlyArray<{
    readonly windowKey: string;
    readonly sampledAt: string;
    readonly usedPercent: number;
    readonly resetsAt: string | null;
  }>;
}

export interface UsageAccountHistoryRepositoryShape {
  readonly listSnapshots: Effect.Effect<
    ReadonlyArray<PersistedAccountSnapshot>,
    ProjectionRepositoryError
  >;
  /**
   * One transaction: drops rows recorded under a different identity, keeps the
   * newest snapshot per section, and ignores duplicate samples.
   */
  readonly recordObservation: (
    observation: AccountObservation,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteSnapshot: (
    accountKey: string,
    sectionKind: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Ordered by account key, window key, then sample time. */
  readonly listSamplesSince: (
    sampledAt: string,
  ) => Effect.Effect<ReadonlyArray<QuotaSampleRow>, ProjectionRepositoryError>;
  /**
   * Age-based retention: deletes samples older than `before`, and snapshots
   * older than `before` whose account is not in `keepAccountKeys`. Recent
   * rows are never deleted, so a transient registry read cannot erase an
   * account's history.
   */
  readonly prune: (input: {
    readonly before: string;
    readonly keepAccountKeys: ReadonlyArray<string>;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class UsageAccountHistoryRepository extends ServiceMap.Service<
  UsageAccountHistoryRepository,
  UsageAccountHistoryRepositoryShape
>()("t3/persistence/Services/UsageAccountHistory/UsageAccountHistoryRepository") {}
