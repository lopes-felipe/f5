/**
 * NativeSessionCleanupReactor - Removes a provider's local transcript when
 * its F5 thread is permanently deleted.
 *
 * @module NativeSessionCleanupReactor
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface NativeSessionCleanupReactorShape {
  /**
   * Start reacting to `thread.deleted`. Must run in a scope so the worker
   * fiber is finalized on shutdown.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /** Resolves once every cleanup started so far has finished. For tests. */
  readonly drain: Effect.Effect<void>;
}

export class NativeSessionCleanupReactor extends ServiceMap.Service<
  NativeSessionCleanupReactor,
  NativeSessionCleanupReactorShape
>()("t3/orchestration/Services/NativeSessionCleanupReactor") {}
