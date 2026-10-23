import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { writeFileBytesAtomically, writeFileStringAtomically } from "./atomicWrite.ts";

it.layer(NodeServices.layer)("atomic writes", (it) => {
  it.effect("writes long filenames without duplicating them in the temporary path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "f5-atomic-" });
      const target = path.join(directory, `${"attachment-".repeat(13)}.png`);
      yield* writeFileBytesAtomically({ filePath: target, contents: new Uint8Array([1, 2, 3]) });
      assert.deepEqual(Array.from(yield* fs.readFile(target)), [1, 2, 3]);
      yield* writeFileStringAtomically({ filePath: target, contents: "replacement" });
      assert.equal(yield* fs.readFileString(target), "replacement");
      assert.deepEqual(yield* fs.readDirectory(directory), [path.basename(target)]);
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("linked settings atomic writes", (it) => {
  it.effect("keeps relative link chains and can create their missing destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "f5-linked-write-" });
      const first = path.join(dir, "first.json");
      const second = path.join(dir, "second.json");
      const target = path.join(dir, "missing", "settings.json");
      yield* fs.symlink("second.json", first);
      yield* fs.symlink(path.join("missing", "settings.json"), second);
      yield* writeFileStringAtomically({
        filePath: first,
        contents: "saved",
        followSymlinks: true,
      });
      assert.equal(yield* fs.readLink(first), "second.json");
      assert.equal(yield* fs.readLink(second), path.join("missing", "settings.json"));
      assert.equal(yield* fs.readFileString(target), "saved");
    }),
  );

  it.effect("does not change the existing non-settings writer policy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "f5-asset-write-" });
      const target = path.join(dir, "target");
      const link = path.join(dir, "link");
      yield* fs.writeFileString(target, "keep");
      yield* fs.symlink(target, link);
      yield* writeFileStringAtomically({ filePath: link, contents: "replacement" });
      assert.equal(yield* fs.readFileString(target), "keep");
      assert.equal(yield* fs.readFileString(link), "replacement");
    }),
  );

  for (const pivotParent of [false, true]) {
    it.effect(
      `refuses publication after ${pivotParent ? "a parent directory" : "the file link"} is repointed`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "f5-pivot-write-" });
          const first = path.join(dir, "first");
          const second = path.join(dir, "second");
          yield* fs.makeDirectory(first);
          yield* fs.makeDirectory(second);
          const firstFile = path.join(first, "settings.json");
          const secondFile = path.join(second, "settings.json");
          yield* fs.writeFileString(firstFile, "keep first");
          yield* fs.writeFileString(secondFile, "keep second");
          const link = path.join(dir, "link");
          yield* fs.symlink(pivotParent ? first : firstFile, link);
          const input = pivotParent ? path.join(link, "settings.json") : link;
          const result = yield* Effect.exit(
            writeFileStringAtomically({
              filePath: input,
              contents: "must not publish",
              followSymlinks: true,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                writeFileString: (file, contents, options) =>
                  fs.writeFileString(file, contents, options).pipe(
                    Effect.tap(() => fs.remove(link)),
                    Effect.tap(() => fs.symlink(pivotParent ? second : secondFile, link)),
                  ),
              }),
            ),
          );
          assert.equal(result._tag, "Failure");
          assert.equal(yield* fs.readFileString(firstFile), "keep first");
          assert.equal(yield* fs.readFileString(secondFile), "keep second");
          assert.deepEqual(yield* fs.readDirectory(first), ["settings.json"]);
        }),
    );
  }

  it.effect("fails on cycles without replacing a link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "f5-cycle-write-" });
      const first = path.join(dir, "first");
      const second = path.join(dir, "second");
      yield* fs.symlink(second, first);
      yield* fs.symlink(first, second);
      const result = yield* Effect.exit(
        writeFileStringAtomically({ filePath: first, contents: "no", followSymlinks: true }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(yield* fs.readLink(first), second);
      assert.equal(yield* fs.readLink(second), first);
    }),
  );
});
