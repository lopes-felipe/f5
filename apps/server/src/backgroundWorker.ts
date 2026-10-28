import { Effect } from "effect";
import {
  makeDrainableWorker,
  type DrainableWorker,
  type DrainableWorkerOptions,
} from "@t3tools/shared/DrainableWorker";

/**
 * Internal lossless subscribers await bounded admission. Item failures are logged
 * and counted in snapshot.failures; drain waits for attempts, not successful effects.
 * Admission still fails visibly when the worker is closed or its loop dies.
 */
export interface BackgroundWorker<A> extends Omit<DrainableWorker<A>, "enqueue"> {
  readonly enqueue: (item: A) => Effect.Effect<void>;
}
export const makeBackgroundWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options: DrainableWorkerOptions<A>,
) =>
  makeDrainableWorker(process, {
    maxEntries: 1024,
    // Lossless ingestion admits a large single provider frame without imposing
    // an undocumented protocol ceiling. Count admission remains bounded; byte
    // accounting is observable. Coalesced/rejecting jobs have a byte ceiling.
    maxBytes: options.key || options.admission === "reject" ? 32 * 1024 * 1024 : Infinity,
    sizeOf: (item) => Buffer.byteLength(JSON.stringify(item) ?? ""),
    ...options,
  }).pipe(
    Effect.map(
      (worker): BackgroundWorker<A> => ({
        ...worker,
        enqueue: (item) => worker.enqueue(item).pipe(Effect.orDie),
      }),
    ),
  );

/** Timer callbacks cannot await admission; closed/failed workers must not reject a detached Promise. */
export const enqueueBackgroundWork = (admission: Effect.Effect<void>) =>
  Effect.runFork(admission.pipe(Effect.ignoreCause));
