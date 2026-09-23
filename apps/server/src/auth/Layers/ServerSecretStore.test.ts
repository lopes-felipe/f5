import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, FileSystem, Layer, Ref } from "effect";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../../config.ts";
import { SecretStoreError, ServerSecretStore } from "../Services/ServerSecretStore.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";

const makeServerConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const makeServerSecretStoreLayer = () =>
  Layer.provide(ServerSecretStoreLive, makeServerConfigLayer());

const PermissionDeniedFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makePermissionDeniedSecretStoreLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(PermissionDeniedFileSystemLayer),
  );

const RenameFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRenameFailureSecretStoreLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RenameFailureFileSystemLayer),
  );

const RemoveFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRemoveFailureSecretStoreLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RemoveFailureFileSystemLayer),
  );

const ConcurrentReadMissFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeConcurrentCreateSecretStoreLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(ConcurrentReadMissFileSystemLayer),
  );

it.layer(NodeServices.layer)("ServerSecretStoreLive", (it) => {
  it.effect("returns null when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      expect(secret).toBeNull();
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      expect(Array.from(second)).toEqual(Array.from(first));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");

      expect(persisted).not.toBeNull();
      expect(Array.from(first)).toEqual(Array.from(persisted ?? new Uint8Array()));
      expect(Array.from(second)).toEqual(Array.from(persisted ?? new Uint8Array()));
    }).pipe(Effect.provide(makeConcurrentCreateSecretStoreLayer())),
  );

  it.effect("does not expose a secret before its bytes are written", () =>
    Effect.gen(function* () {
      const observed: Array<Uint8Array | null> = [];
      const observingFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig;
          const secretPath = path.join(
            config.secretsDir ?? path.join(config.stateDir, "secrets"),
            "session-signing-key.bin",
          );
          return {
            ...fileSystem,
            open: (path, options) =>
              fileSystem.open(path, options).pipe(
                Effect.map((file) => ({
                  ...file,
                  sync: file.sync,
                  writeAll: (bytes) =>
                    Effect.gen(function* () {
                      const visible = yield* fileSystem
                        .readFile(secretPath)
                        .pipe(
                          Effect.catch((error) =>
                            error.reason._tag === "NotFound"
                              ? Effect.succeed(null)
                              : Effect.fail(error),
                          ),
                        );
                      observed.push(visible);
                      return yield* file.writeAll(bytes);
                    }),
                })),
              ),
          } satisfies FileSystem.FileSystem;
        }),
      );
      const configLayer = makeServerConfigLayer();
      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore;
        const created = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
        expect(created.byteLength).toBe(32);
        expect(yield* secretStore.get("session-signing-key")).toEqual(created);
        expect(observed).toEqual([null]);
        const config = yield* ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        expect(
          yield* fileSystem.readDirectory(
            config.secretsDir ?? path.join(config.stateDir, "secrets"),
          ),
        ).toEqual(["session-signing-key.bin"]);
      }).pipe(
        Effect.provide(
          ServerSecretStoreLive.pipe(
            Layer.provide(observingFileSystem),
            Layer.provideMerge(configLayer),
          ),
        ),
      );
    }),
  );

  it.effect("cleans up unpublished files when secret publication fails", () =>
    Effect.gen(function* () {
      const failingFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return {
            ...fileSystem,
            link: (from, _to) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "link",
                  pathOrDescriptor: String(from),
                  description: "Publication denied.",
                }),
              ),
          } satisfies FileSystem.FileSystem;
        }),
      );
      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore;
        const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));
        expect(error).toBeInstanceOf(SecretStoreError);
        expect(yield* secretStore.get("session-signing-key")).toBeNull();
        const config = yield* ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        expect(
          yield* fileSystem.readDirectory(
            config.secretsDir ?? path.join(config.stateDir, "secrets"),
          ),
        ).toEqual([]);
      }).pipe(
        Effect.provide(
          ServerSecretStoreLive.pipe(
            Layer.provide(failingFileSystem),
            Layer.provideMerge(makeServerConfigLayer()),
          ),
        ),
      );
    }),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () =>
    Effect.gen(function* () {
      const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
      const recordingFileSystemLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          return {
            ...fileSystem,
            open: (path, options) => {
              if (options?.mode !== undefined) {
                chmodCalls.push({ path: String(path), mode: options.mode });
              }
              return fileSystem.open(path, options);
            },
            writeFile: () => Effect.void,
            rename: () => Effect.void,
            chmod: (path, mode) =>
              Effect.sync(() => {
                chmodCalls.push({ path: String(path), mode });
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore;
        yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));
      }).pipe(
        Effect.provide(
          ServerSecretStoreLive.pipe(
            Layer.provide(makeServerConfigLayer()),
            Layer.provideMerge(recordingFileSystemLayer),
          ),
        ),
      );

      expect(
        chmodCalls.some((call) => call.mode === 0o700 && /[\\/]secrets$/.test(call.path)),
      ).toBe(true);
      expect(chmodCalls.filter((call) => call.mode === 0o600).length).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      expect(error).toBeInstanceOf(SecretStoreError);
      expect(error.message).toContain("Failed to read secret session-signing-key.");
      expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
      expect((error.cause as PlatformError.PlatformError).reason._tag).toBe("PermissionDenied");
    }).pipe(Effect.provide(makePermissionDeniedSecretStoreLayer())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      expect(error).toBeInstanceOf(SecretStoreError);
      expect(error.message).toContain("Failed to persist secret session-signing-key.");
      expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
      expect((error.cause as PlatformError.PlatformError).reason._tag).toBe("PermissionDenied");
    }).pipe(Effect.provide(makeRenameFailureSecretStoreLayer())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      expect(error).toBeInstanceOf(SecretStoreError);
      expect(error.message).toContain("Failed to remove secret session-signing-key.");
      expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
      expect((error.cause as PlatformError.PlatformError).reason._tag).toBe("PermissionDenied");
    }).pipe(Effect.provide(makeRemoveFailureSecretStoreLayer())),
  );
});
