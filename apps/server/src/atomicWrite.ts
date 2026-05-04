import { Effect, FileSystem, Path } from "effect";
import { randomUUID } from "node:crypto";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);
      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, `${randomUUID()}.tmp`);

      yield* fs.writeFileString(tempPath, input.contents);
      yield* fs.rename(tempPath, input.filePath);
    }),
  );
