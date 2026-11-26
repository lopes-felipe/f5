import * as Crypto from "node:crypto";

import { Effect, FileSystem, Layer, Path, Predicate, Semaphore } from "effect";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../../config.ts";
import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../Services/ServerSecretStore.ts";
import {
  decryptSecretValue,
  ENCRYPTED_SECRET_PREFIXES,
  encryptSecretValue,
  isEncryptedSecretName,
  isEncryptedSecretValue,
  SECRET_STORE_KEY_FILE,
} from "../secretStoreKey.ts";

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

  const readRaw: ServerSecretStoreShape["get"] = (name) =>
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

  const create: ServerSecretStoreShape["set"] = (name, value) => persist(name, value, false);

  const getOrCreateRandomRaw: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) =>
    readRaw(name).pipe(
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

  // MCP secrets and OAuth tokens are encrypted at rest. Desktop passes a keychain-wrapped
  // key; otherwise a 0600 key file in this directory is the key.
  const configuredKey = serverConfig.secretStoreKey;
  let fileKey: Uint8Array | undefined;
  const encryptionKey = configuredKey
    ? Effect.succeed(configuredKey)
    : Effect.suspend(() =>
        fileKey
          ? Effect.succeed(fileKey)
          : getOrCreateRandomRaw(SECRET_STORE_KEY_FILE, 32).pipe(
              Effect.tap((key) => Effect.sync(() => (fileKey = key))),
            ),
      );
  /** The configured key first, then a key file left by an earlier headless run. */
  const decryptionKeys = Effect.suspend(() =>
    (fileKey ? Effect.succeed(fileKey) : readRaw(SECRET_STORE_KEY_FILE)).pipe(
      Effect.tap((key) => Effect.sync(() => (fileKey = key ?? undefined))),
      Effect.map((key) => [
        ...(configuredKey ? [{ key: configuredKey, current: true }] : []),
        ...(key && key.length === 32 ? [{ key, current: !configuredKey }] : []),
      ]),
    ),
  );
  const writeEncrypted = (name: string, plain: Uint8Array, overwrite: boolean) =>
    encryptionKey.pipe(
      Effect.flatMap((key) => persist(name, encryptSecretValue(key, name, plain), overwrite)),
    );

  // Writes to encrypted names take turns, so a read's migration or re-key rewrite
  // cannot land after (and undo) a newer `set` or `remove` of the same value.
  const encryptedWrites = yield* Semaphore.make(1);
  const serialized = encryptedWrites.withPermits(1);
  /** Rewrites a value read as `seen`, unless a write replaced or removed it since. */
  const rewriteIfUnchanged = (name: string, seen: Uint8Array, plain: Uint8Array) =>
    serialized(
      readRaw(name).pipe(
        Effect.flatMap((current) =>
          current !== null && Buffer.compare(current, seen) === 0
            ? writeEncrypted(name, plain, true)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.ignore);

  const get: ServerSecretStoreShape["get"] = (name) =>
    readRaw(name).pipe(
      Effect.flatMap((bytes) => {
        if (bytes === null || !isEncryptedSecretName(name)) return Effect.succeed(bytes);
        if (!isEncryptedSecretValue(bytes))
          // Written before encryption; protect it now. A failed rewrite keeps the value usable.
          return rewriteIfUnchanged(name, bytes, bytes).pipe(Effect.as(bytes));
        return decryptionKeys.pipe(
          Effect.flatMap((keys) => {
            for (const { key, current } of keys) {
              const plain = decryptSecretValue(key, name, bytes);
              if (plain === null) continue;
              return current
                ? Effect.succeed(plain)
                : rewriteIfUnchanged(name, bytes, plain).pipe(Effect.as(plain));
            }
            return Effect.fail(
              new SecretStoreError({
                message: `Secret ${name} cannot be decrypted with this profile's key.`,
              }),
            );
          }),
        );
      }),
    );

  const set: ServerSecretStoreShape["set"] = (name, value) =>
    isEncryptedSecretName(name)
      ? serialized(writeEncrypted(name, value, true))
      : persist(name, value, true);

  const getOrCreateRandom: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) =>
    isEncryptedSecretName(name)
      ? get(name).pipe(
          Effect.flatMap((existing) => {
            if (existing) return Effect.succeed(existing);
            const generated = Uint8Array.from(Crypto.randomBytes(bytes));
            return writeEncrypted(name, generated, false).pipe(
              Effect.flatMap(() => get(name)),
              Effect.catchTag("SecretStoreError", () => get(name)),
              Effect.flatMap((created) =>
                created
                  ? Effect.succeed(created)
                  : Effect.fail(
                      new SecretStoreError({ message: `Failed to create secret ${name}.` }),
                    ),
              ),
            );
          }),
        )
      : getOrCreateRandomRaw(name, bytes);

  const removeFile = (name: string) =>
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
  const remove: ServerSecretStoreShape["remove"] = (name) =>
    isEncryptedSecretName(name) ? serialized(removeFile(name)) : removeFile(name);

  const list: ServerSecretStoreShape["list"] = (prefix) =>
    Effect.gen(function* () {
      const names = yield* fileSystem.readDirectory(secretsDir);
      const result: { name: string; modifiedAt: number }[] = [];
      for (const filename of names) {
        if (!filename.startsWith(prefix) || !filename.endsWith(".bin")) continue;
        const stat = yield* fileSystem.stat(path.join(secretsDir, filename));
        if (stat.type === "File" && stat.mtime !== undefined)
          result.push({ name: filename.slice(0, -4), modifiedAt: stat.mtime.getTime() });
      }
      return result;
    }).pipe(
      Effect.mapError(
        (cause) => new SecretStoreError({ message: "Failed to list secrets.", cause }),
      ),
    );

  // With a keychain key, values an earlier headless run left under the key file are
  // moved onto the keychain key, and the key file is removed once nothing needs it.
  if (configuredKey)
    yield* Effect.gen(function* () {
      if ((yield* readRaw(SECRET_STORE_KEY_FILE)) === null) return;
      let dependents = 0;
      for (const prefix of ENCRYPTED_SECRET_PREFIXES)
        for (const { name } of yield* list(prefix)) {
          // `get` rewrites a value it could only decrypt with the file key.
          yield* get(name).pipe(Effect.ignore);
          const stored = yield* readRaw(name);
          if (stored && decryptSecretValue(configuredKey, name, stored) === null) dependents += 1;
        }
      if (dependents > 0) return;
      yield* remove(SECRET_STORE_KEY_FILE);
      fileKey = undefined;
    }).pipe(Effect.ignore);

  return {
    list,
    get,
    set,
    getOrCreateRandom,
    remove,
  } satisfies ServerSecretStoreShape;
});

export const ServerSecretStoreLive = Layer.effect(ServerSecretStore, makeServerSecretStore);
