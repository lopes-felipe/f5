import { Effect, FileSystem, Option, Path, PlatformError, Result } from "effect";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Random from "effect/Random";

/**
 * Windows refuses to rename over a file another process holds open without delete
 * sharing, such as a virus scanner or the search indexer. The same codes also mean a
 * denial that never clears, so retries need a bound.
 */
export const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// About 2 seconds in total. Settings and keybinding saves wait on this while holding
// their write lock, so a denial that is not a brief scan has to surface quickly.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

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
      const targetPath = input.followSymlinks
        ? yield* resolveSymlinkTarget(input.filePath)
        : input.filePath;
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const canonicalTarget = input.followSymlinks
        ? path.join(yield* fs.realPath(targetDirectory), path.basename(targetPath))
        : targetPath;
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: path.dirname(canonicalTarget),
        prefix: ".write-",
      });
      const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);

      yield* fs.writeFileString(tempPath, input.contents);
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
        platform: input.platform ?? process.platform,
      });
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
