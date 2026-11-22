import { Effect, FileSystem, Option, Path, PlatformError, Result } from "effect";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Random from "effect/Random";

const errno = (error: PlatformError.PlatformError) =>
  (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;

/**
 * Windows refuses to rename over a file another process holds open without delete
 * sharing, such as a virus scanner or the search indexer. The same codes also mean a
 * denial that never clears, so retries need a bound.
 */
export const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = errno(error);
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// About 2 seconds in total. Settings and keybinding saves wait on this while holding
// their write lock, so a denial that is not a brief scan has to surface quickly.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";
const PRIVATE_FILE_MODE = 0o600;

const replacedMode = (fs: FileSystem.FileSystem, targetPath: string, followSymlinks: boolean) =>
  Effect.gen(function* () {
    if (!followSymlinks) {
      // Replacing a link creates a new file. Its destination's mode does not apply.
      const isLink = yield* fs.readLink(targetPath).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound" || errno(error) === "EINVAL",
          () => Effect.succeed(false),
        ),
      );
      if (isLink) return PRIVATE_FILE_MODE;
    }
    return yield* fs.stat(targetPath).pipe(
      Effect.map((info) => info.mode & 0o777),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(PRIVATE_FILE_MODE),
      ),
    );
  });

const syncDirectory = (fs: FileSystem.FileSystem, directory: string) =>
  fs.open(directory, { flag: "r" }).pipe(
    Effect.flatMap((file) => file.sync),
    Effect.scoped,
    Effect.catchIf((error) => {
      const code = errno(error);
      return (
        error.reason._tag === "PermissionDenied" ||
        code === "EINVAL" ||
        code === "ENOTSUP" ||
        code === "ENOSYS"
      );
    }, Effect.logWarning),
  );

const renameOverTarget = (input: {
  readonly tempPath: string;
  readonly targetPath: string;
  readonly platform: NodeJS.Platform;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (input.platform !== "win32") return yield* fs.rename(input.tempPath, input.targetPath);

    // A retry must not replace a save another process landed while this one waited,
    // so it gives up once the target is no longer the file seen here. A read-only
    // target fails with the same EPERM as a held one but never clears.
    const targetVersion = fs.stat(input.targetPath).pipe(
      Effect.map((info) => ({
        id: `${info.ino}:${info.size}:${info.mtime?.getTime()}`,
        readOnly: (info.mode & 0o200) === 0,
      })),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed({ id: "missing", readOnly: false }),
      ),
      Effect.option,
    );
    const before = yield* targetVersion;
    const firstAttempt = yield* Effect.result(fs.rename(input.tempPath, input.targetPath));
    if (Result.isSuccess(firstAttempt)) return;
    const lockError = firstAttempt.failure;
    if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
      return yield* lockError;
    }
    for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
      yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
      const current = yield* targetVersion;
      if (Option.isNone(current) || current.value.id !== before.value.id) break;
      const attempt = yield* Effect.result(fs.rename(input.tempPath, input.targetPath));
      if (Result.isSuccess(attempt)) return;
      if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
    }
    return yield* lockError;
  });

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  /** Settings may follow user-owned links; asset writers keep their existing behavior. */
  readonly followSymlinks?: boolean;
  /** Defaults to the host platform; Windows retries a rename blocked by a held target. */
  readonly platform?: NodeJS.Platform;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempFileId = yield* Random.nextUUIDv4;
      const platform = input.platform ?? process.platform;
      const targetPath = input.followSymlinks
        ? yield* resolveSymlinkTarget(input.filePath)
        : input.filePath;
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const canonicalTarget = input.followSymlinks
        ? path.join(yield* fs.realPath(targetDirectory), path.basename(targetPath))
        : targetPath;
      const canonicalDirectory = path.dirname(canonicalTarget);
      const tempDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: canonicalDirectory, prefix: ".write-" }),
        (directory) =>
          fs
            .remove(directory, { recursive: true, force: true })
            .pipe(Effect.catch(Effect.logWarning)),
      );
      const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);

      // Keep the same handle through chmod and sync, then close it before the rename.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(tempPath, { flag: "wx", mode: PRIVATE_FILE_MODE });
          // Opening creates the empty file. writeAll reports WriteZero for an empty buffer.
          if (input.contents.length > 0) {
            yield* file.writeAll(new TextEncoder().encode(input.contents));
          }
          if (process.platform !== "win32") {
            yield* fs.chmod(
              tempPath,
              yield* replacedMode(fs, canonicalTarget, input.followSymlinks ?? false),
            );
          }
          yield* file.sync;
        }),
      );
      if (input.followSymlinks) {
        const latestTarget = yield* resolveSymlinkTarget(input.filePath);
        const latestCanonicalTarget = path.join(
          yield* fs.realPath(path.dirname(latestTarget)),
          path.basename(latestTarget),
        );
        if (latestCanonicalTarget !== canonicalTarget) {
          return yield* PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "rename",
            description: "Settings symlink target changed while saving",
            pathOrDescriptor: input.filePath,
          });
        }
      }
      yield* renameOverTarget({
        tempPath,
        targetPath: canonicalTarget,
        platform,
      });
      if (process.platform !== "win32") {
        yield* syncDirectory(fs, canonicalDirectory);
      }
    }),
  );

export const writeFileBytesAtomically = (input: {
  readonly filePath: string;
  readonly contents: Uint8Array;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempFileId = yield* Random.nextUUIDv4;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: ".write-",
      });
      const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);

      yield* fs.writeFile(tempPath, input.contents);
      yield* fs.rename(tempPath, input.filePath);
    }),
  );
