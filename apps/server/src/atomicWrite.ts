import { Effect, FileSystem, Path, PlatformError } from "effect";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Random from "effect/Random";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  /** Settings may follow user-owned links; asset writers keep their existing behavior. */
  readonly followSymlinks?: boolean;
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
      yield* fs.rename(tempPath, canonicalTarget);
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
