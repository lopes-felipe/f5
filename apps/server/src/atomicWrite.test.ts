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
