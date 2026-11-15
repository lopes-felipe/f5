/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `ServiceMap.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  ThreadId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { OrchestrationDispatchError, OrchestrationOverloadError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export type { ProviderControlOrigin as ControlOrigin } from "../../provider/controlTarget.ts";
import type { ProviderControlOrigin as ControlOrigin } from "../../provider/controlTarget.ts";

export interface OrchestrationEngineShape {
  /** Releases a reserved control slot after its provider-side outcome is recorded. */
  /** Claim immediately before processing; expired/unowned events must never run late. */
  readonly claimControl?: (commandId: string) => Effect.Effect<boolean>;
  readonly completeControl?: (commandId: string) => Effect.Effect<void>;
  readonly controlOrigin?: (commandId: string) => ControlOrigin | undefined;
  readonly isTurnStartSuperseded?: (event: OrchestrationEvent) => boolean;
  /** Wait for controls already admitted for this thread before preparing a new send. */
  readonly waitForControlProgress?: (
    threadId: string,
  ) => Effect.Effect<void, OrchestrationOverloadError>;

  /** Process-local admission inventory; never includes command contents. */
  readonly inspectQueue?: () => { entries: number; bytes: number; oldestAgeMs: number };

  /**
   * Read the current in-memory orchestration read model.
   *
   * A thread that was archived before the server started is flagged
   * `activitiesOmitted` and has only its worktree-setup activity here until an
   * event reaches it. Call `ensureThreadActivities` before reading the
   * `activities` of a thread that carries the flag.
   *
   * @returns Effect containing the latest read model.
   */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /**
   * Load the retained activities of these threads into the read model, if
   * they are not there yet. A failed load is logged and leaves the thread
   * flagged `activitiesOmitted`; check the flag where incomplete activities
   * would lead to a wrong write.
   */
  readonly ensureThreadActivities?: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<void>;

  /**
   * Read a bounded page of persisted events after an exclusive sequence cursor.
   * Returns at most 1,000 events; continue from the last returned sequence.
   * Internal startup and recovery replay use the event store without this cap.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<
    { sequence: number; deletedThreadIds?: ReadonlyArray<ThreadId> },
    OrchestrationDispatchError,
    never
  >;

  /**
   * Acquire an exclusive process-local maintenance lock.
   *
   * Command dispatch processing takes a shared lock; callers must close the
   * returned scope to release the exclusive lock. This is intended for storage
   * cleanup and database maintenance that must not race with command writes.
   */
  readonly acquireMaintenanceLock: () => Effect.Effect<Scope.Closeable, never, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.getReadModel()
 * })
 * ```
 */
export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
