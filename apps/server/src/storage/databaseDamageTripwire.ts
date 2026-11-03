/**
 * databaseDamageTripwire - Preserve the in-memory read model on corruption.
 *
 * When the profile database starts failing with SQLITE_CORRUPT/SQLITE_NOTADB,
 * the orchestration engine still holds everything it loaded at startup. The
 * tripwire writes that read model to `<stateDir>/recovery/` before anything
 * else can go wrong, then tells connected windows so the user does not quit.
 * The companion recovery tool (`apps/server/scripts/recover-from-snapshot.ts`,
 * lopes-felipe/f5#386) rebuilds a database from that file.
 *
 * @module databaseDamageTripwire
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";

import type { DatabaseDamage } from "@t3tools/contracts";
import { Data, Duration, Effect, Schedule } from "effect";

import { latestDatabaseSnapshot } from "../persistence/databaseFiles.ts";
import { onDatabaseDamage, updateDatabaseDamage } from "../persistence/databaseHealth.ts";

/**
 * Writes `value` as JSON one array element at a time, so a read model larger
 * than the maximum string length still serializes.
 *
 * The error listener is attached before the first write: an ENOSPC or EIO
 * while waiting for `drain` must reject here, not surface as an unhandled
 * stream error that would crash the process holding the only good state.
 */
export async function writeJsonStreamed(
  path: string,
  value: Record<string, unknown>,
  open: (path: string) => Writable = (target) =>
    createWriteStream(target, { flags: "wx", mode: 0o600 }),
): Promise<void> {
  const stream = open(path);
  let failure: Error | null = null;
  const failed = new Promise<never>((_, reject) => {
    stream.on("error", (error) => {
      failure ??= error;
      reject(error);
    });
  });
  // Observed only through the races below; keep an early error from being unhandled.
  failed.catch(() => undefined);
  const write = async (chunk: string) => {
    if (failure) throw failure;
    if (stream.write(chunk)) return;
    await Promise.race([once(stream, "drain"), failed]);
  };
  try {
    await write("{");
    let firstKey = true;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      await write(`${firstKey ? "" : ","}${JSON.stringify(key)}:`);
      firstKey = false;
      if (!Array.isArray(entry)) {
        await write(JSON.stringify(entry));
        continue;
      }
      await write("[");
      for (let index = 0; index < entry.length; index += 1)
        await write(`${index === 0 ? "" : ","}${JSON.stringify(entry[index])}`);
      await write("]");
    }
    await write("}\n");
    stream.end();
    await Promise.race([finished(stream), failed]);
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

export class RecoveryFileWriteError extends Data.TaggedError("RecoveryFileWriteError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export interface PreserveReadModelInput {
  readonly stateDir: string;
  readonly getReadModel: Effect.Effect<object>;
  readonly publish: (damage: DatabaseDamage) => Effect.Effect<void>;
  readonly now?: () => number;
  /** Overrides how the recovery file is opened (tests inject failures). */
  readonly openStream?: (path: string) => Writable;
  /** Delay before the first retry; doubles for each of the two retries. */
  readonly retryDelay?: Duration.Input;
}

/** Writes the read model atomically and publishes the updated damage record. */
export const preserveReadModel = (input: PreserveReadModelInput) =>
  Effect.gen(function* () {
    const directory = join(input.stateDir, "recovery");
    const target = join(directory, `readmodel-${(input.now ?? Date.now)()}.json`);
    const temporary = `${target}.${randomUUID()}.partial`;
    const model = yield* input.getReadModel;
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try {
          await writeJsonStreamed(temporary, model as Record<string, unknown>, input.openStream);
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      catch: (cause) => new RecoveryFileWriteError({ path: target, cause }),
    });
    const updated = updateDatabaseDamage({
      recoveryFile: target,
      recoveryError: null,
      latestSnapshot: latestDatabaseSnapshot(input.stateDir),
    });
    if (updated) yield* input.publish(updated);
    yield* Effect.logError("F5 database damaged; in-memory state preserved", {
      recoveryFile: target,
    });
    return target;
  });

/**
 * Preserves the read model, retrying twice with backoff. A final failure is
 * published as `recoveryError` so the banner stops claiming a save is underway.
 */
const preserveWithRetry = (input: PreserveReadModelInput) =>
  Effect.suspend(() => {
    // Each attempt gets its own timestamped file name.
    const attempt = preserveReadModel(input);
    return attempt.pipe(
      Effect.retry({ times: 2, schedule: Schedule.exponential(input.retryDelay ?? "2 seconds") }),
      Effect.catch((error: RecoveryFileWriteError) =>
        Effect.gen(function* () {
          const message = error.cause instanceof Error ? error.cause.message : String(error.cause);
          yield* Effect.logError("could not preserve the in-memory read model", {
            path: error.path,
            cause: message,
          });
          const updated = updateDatabaseDamage({
            recoveryError: `Could not write ${error.path}: ${message}`,
          });
          if (updated) yield* input.publish(updated);
        }),
      ),
    );
  });

/** Subscribes for the lifetime of the enclosing scope. */
export const startDatabaseDamageTripwire = (input: PreserveReadModelInput) =>
  Effect.gen(function* () {
    const services = yield* Effect.services<never>();
    const runFork = Effect.runForkWith(services);
    const unsubscribe = onDatabaseDamage((damage) => {
      runFork(
        Effect.gen(function* () {
          const initial = updateDatabaseDamage({
            latestSnapshot: latestDatabaseSnapshot(input.stateDir),
          });
          yield* input.publish(initial ?? damage);
          // After a restart the read model came from the damaged file, and the
          // first run's recovery copy is the better one; don't add another.
          if (damage.fromPreviousRun) return;
          yield* preserveWithRetry(input);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("could not preserve the in-memory read model", {
              cause: String(cause),
            }),
          ),
        ),
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  });
