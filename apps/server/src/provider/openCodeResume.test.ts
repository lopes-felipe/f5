import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { isOpenCodeNotFound, isSameOpenCodeDirectory } from "./openCodeResume.ts";

it("recognizes only structured missing-session errors through runtime wrappers", () => {
  for (const cause of [
    { cause: new Error("missing", { cause: { status: 404 } }) },
    { cause: { response: { status: 404 } } },
    { statusCode: 404 },
    { body: { name: "NotFoundError" } },
  ])
    assert.equal(isOpenCodeNotFound(cause), true);
  for (const cause of [
    undefined,
    new Error("session not found"),
    { name: "ProviderNotFoundError" },
    { status: 500, body: { name: "NotFoundError" } },
    { cause: { response: { status: 401 }, body: { name: "NotFoundError" } } },
  ])
    assert.equal(isOpenCodeNotFound(cause), false);
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(isOpenCodeNotFound(cyclic), false);
});

it.layer(NodeServices.layer)("OpenCode resume directories", (it) => {
  it.effect("reuses symlinked paths and handles unavailable directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const original = path.join(temp, "original");
      const link = path.join(temp, "link");
      yield* fs.makeDirectory(original);
      yield* fs.symlink(original, link);
      assert.equal(yield* isSameOpenCodeDirectory(fs, path, original, link), true);
      assert.equal(yield* isSameOpenCodeDirectory(fs, path, original + "/.", original), true);
      assert.equal(yield* isSameOpenCodeDirectory(fs, path, "/missing/a", "/missing/b"), false);
    }).pipe(Effect.scoped),
  );
});
