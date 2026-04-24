/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationGetStartupSnapshotInput,
  OrchestrationGetStartupSnapshotResult,
  OrchestrationGetThreadTailDetailsInput,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadTailDetails,
  OrchestrationGetThreadDetailsInput,
  OrchestrationThreadDetails,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the retained snapshot used to bootstrap the in-memory orchestration
   * engine on startup.
   *
   * Preserves full thread metadata while bounding historical collections to
   * the same limits enforced by the live projector.
   */
  readonly getBootstrapSnapshot: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the lightweight startup snapshot used for first paint.
   *
   * Excludes heavyweight per-thread detail collections that are fetched on
   * demand after navigation.
   */
  readonly getStartupSnapshot: (
    input?: OrchestrationGetStartupSnapshotInput,
  ) => Effect.Effect<OrchestrationGetStartupSnapshotResult, ProjectionRepositoryError>;

  /**
   * Read the newest renderable tail slice for a thread.
   */
  readonly getThreadTailDetails: (
    input: OrchestrationGetThreadTailDetailsInput,
  ) => Effect.Effect<OrchestrationThreadTailDetails, ProjectionRepositoryError>;

  /**
   * Read the next older page of thread history to prepend.
   */
  readonly getThreadHistoryPage: (
    input: OrchestrationGetThreadHistoryPageInput,
  ) => Effect.Effect<OrchestrationThreadHistoryPage, ProjectionRepositoryError>;

  /**
   * Read lazily-loaded per-thread detail collections and a projection
   * sequence watermark for buffered event reconciliation.
   */
  readonly getThreadDetails: (
    input: OrchestrationGetThreadDetailsInput,
  ) => Effect.Effect<OrchestrationThreadDetails, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends ServiceMap.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
