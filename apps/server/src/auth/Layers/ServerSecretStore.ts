import * as Crypto from "node:crypto";

import { Effect, FileSystem, Layer, Path, Predicate } from "effect";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../../config.ts";
import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../Services/ServerSecretStore.ts";

export const makeServerSecretStore = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const secretsDir = serverConfig.secretsDir ?? path.join(serverConfig.stateDir, "secrets");

  yield* fileSystem.makeDirectory(secretsDir, { recursive: true });
  yield* fileSystem.chmod(secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreError({
          message: `Failed to secure secrets directory ${secretsDir}.`,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(secretsDir, `${name}.bin`);

  const isPlatformError = (u: unknown): u is PlatformError.PlatformError =>
    Predicate.isTagged(u, "PlatformError");

  const get: ServerSecretStoreShape["get"] = (name) =>
    fileSystem.readFile(resolveSecretPath(name)).pipe(
      Effect.map((bytes) => Uint8Array.from(bytes)),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to read secret ${name}.`,
                cause,
              }),
            ),
      ),
    );

  // Publish only fully written files. Creating the destination with `wx` exposes an
  // empty (or partially written) secret to other processes before writeAll finishes.
  const persist = (name: string, value: Uint8Array, overwrite: boolean) => {
    const secretPath = resolveSecretPath(name);
    const tempPath = `${secretPath}.${Crypto.randomUUID()}.tmp`;
    return Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.succeed(tempPath), (temporary) =>
          fileSystem.remove(temporary).pipe(Effect.ignore),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(tempPath, {
              flag: "wx",
              mode: 0o600,
            });
            yield* file.writeAll(value);
            yield* file.sync;
          }),
        );
        yield* fileSystem.chmod(tempPath, 0o600);
        // A hard link publishes atomically without replacing a concurrent winner.
        // Both paths are in secretsDir, so they always reside on the same volume.
        yield* overwrite
          ? fileSystem.rename(tempPath, secretPath)
          : fileSystem.link(tempPath, secretPath);
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to persist secret ${name}.`,
            cause,
          }),
      ),
    );
  };

  const set: ServerSecretStoreShape["set"] = (name, value) => persist(name, value, true);
  const create: ServerSecretStoreShape["set"] = (name, value) => persist(name, value, false);

  const getOrCreateRandom: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap((existing) => {
        if (existing) {
          return Effect.succeed(existing);
        }

        const generated = Crypto.randomBytes(bytes);
        return create(name, generated).pipe(
          Effect.as(Uint8Array.from(generated)),
          Effect.catchTag("SecretStoreError", (error) =>
            isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists"
              ? get(name).pipe(
                  Effect.flatMap((created) =>
                    created !== null
                      ? Effect.succeed(created)
                      : Effect.fail(
                          new SecretStoreError({
                            message: `Failed to read secret ${name} after concurrent creation.`,
                          }),
                        ),
                  ),
                )
              : Effect.fail(error),
          ),
        );
      }),
    );

  const remove: ServerSecretStoreShape["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name)).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to remove secret ${name}.`,
                cause,
              }),
            ),
      ),
    );

  return {
    get,
    set,
    getOrCreateRandom,
    remove,
  } satisfies ServerSecretStoreShape;
});

export const ServerSecretStoreLive = Layer.effect(ServerSecretStore, makeServerSecretStore);
