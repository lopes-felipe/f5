/**
 * databaseDamageTripwire - Preserve the in-memory read model on corruption.
 *
 * When the profile database starts failing with SQLITE_CORRUPT/SQLITE_NOTADB,
 * the orchestration engine still holds everything it loaded at startup. The
 * tripwire writes that read model to `<stateDir>/recovery/` before anything
 * else can go wrong, then tells connected windows so the user does not quit.
 * `scripts/recover-from-snapshot.ts` rebuilds a database from that file.
 *
 * @module databaseDamageTripwire
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import type { DatabaseDamage } from "@t3tools/contracts";
import { Data, Effect } from "effect";

import { latestDatabaseSnapshot } from "../persistence/databaseFiles.ts";
import { onDatabaseDamage, updateDatabaseDamage } from "../persistence/databaseHealth.ts";

/**
 * Writes `value` as JSON one array element at a time, so a read model larger
 * than the maximum string length still serializes.
 */
async function writeJsonStreamed(path: string, value: Record<string, unknown>): Promise<void> {
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const write = (chunk: string) =>
    stream.write(chunk) ? Promise.resolve() : new Promise<void>((r) => stream.once("drain", r));
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
    await finished(stream);
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
          await writeJsonStreamed(temporary, model as Record<string, unknown>);
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      catch: (cause) => new RecoveryFileWriteError({ path: target, cause }),
    });
    const updated = updateDatabaseDamage({
      recoveryFile: target,
      latestSnapshot: latestDatabaseSnapshot(input.stateDir),
    });
    if (updated) yield* input.publish(updated);
    yield* Effect.logError("F5 database damaged; in-memory state preserved", {
      recoveryFile: target,
    });
    return target;
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
          yield* preserveReadModel(input);
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
