import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import { Cause, Effect, FileSystem, Path, PlatformError, Queue, Stream } from "effect";

/** Attach before returning so the first external save cannot race watcher startup. */
export const watchSettingsFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Events are invalidations, so only the latest pending invalidation is needed.
    const invalidations = yield* Queue.sliding<void, PlatformError.PlatformError>(1);
    const watchError = (cause: unknown) =>
      PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "watch",
        pathOrDescriptor: filePath,
        cause,
      });
    const fingerprint = Effect.tryPromise({
      try: async () => {
        try {
          const info = await stat(filePath, { bigint: true });
          return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "missing";
          throw cause;
        }
      },
      catch: watchError,
    });
    let lastFingerprint = "";
    const attach = (target: string) =>
      Effect.try({
        try: () => {
          const watcher = watch(path.dirname(target), { recursive: false }, (_event, name) => {
            if (name === null || name.toString() === path.basename(target)) {
              Queue.offerUnsafe(invalidations, undefined);
            }
          });
          watcher.on("error", (cause) =>
            Queue.failCauseUnsafe(invalidations, Cause.fail(watchError(cause))),
          );
          return watcher;
        },
        catch: watchError,
      });
    const canonicalize = (target: string) =>
      Effect.gen(function* () {
        const directory = yield* fs.realPath(path.dirname(target));
        return path.join(directory, path.basename(target));
      });
    const canonicalLink = yield* canonicalize(filePath);
    let watchedTarget = canonicalLink;
    let targetWatch: { readonly path: string; readonly watcher: FSWatcher } | undefined;
    yield* Effect.acquireRelease(attach(filePath), (watcher) => Effect.sync(() => watcher.close()));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        targetWatch?.watcher.close();
      }),
    );
    const refreshTarget = (verifyChanges: boolean) =>
      Effect.gen(function* () {
        const target = yield* resolveSymlinkTarget(filePath);
        // A dangling link can still be watched through its destination directory.
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        const canonicalTarget = yield* canonicalize(target);
        lastFingerprint = yield* fingerprint;
        if (watchedTarget === canonicalTarget) return;
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const next =
              canonicalTarget === canonicalLink
                ? undefined
                : {
                    path: canonicalTarget,
                    watcher: yield* attach(canonicalTarget),
                  };
            targetWatch?.watcher.close();
            targetWatch = next;
            watchedTarget = canonicalTarget;
            // A remove/create pair can share one OS event. Recheck once after a
            // destination change, including the transient missing-link state.
            if (verifyChanges) Queue.offerUnsafe(invalidations, undefined);
          }),
        );
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    yield* refreshTarget(false);
    // Native events can be lost, including the first save in a newly created
    // directory. This scope owns one sequential metadata check at a time.
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        const current = yield* fingerprint;
        if (current !== lastFingerprint) {
          lastFingerprint = current;
          Queue.offerUnsafe(invalidations, undefined);
        }
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() => Queue.failCauseUnsafe(invalidations, Cause.fail(error))),
      ),
      Effect.forkScoped,
    );
    return Stream.fromQueue(invalidations).pipe(Stream.tap(() => refreshTarget(true)));
  });
