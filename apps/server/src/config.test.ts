import * as PathNode from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { defaultF5BaseDir } from "@t3tools/shared/appStatePaths";

import { deriveServerPaths } from "./config";
import { resolveBaseDir, resolveStateDir } from "./os-jank";

it.layer(NodeServices.layer)("server config paths", (it) => {
  it.effect("defaults base and explicit state resolution to F5-owned paths", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveBaseDir(undefined), defaultF5BaseDir());
      assert.equal(
        yield* resolveStateDir(undefined),
        PathNode.join(defaultF5BaseDir(), "userdata"),
      );
    }),
  );

  it.effect("derives production and dev state paths under the configured F5 base dir", () =>
    Effect.gen(function* () {
      const baseDir = PathNode.join(PathNode.sep, "tmp", "f5-home");
      const productionPaths = yield* deriveServerPaths(baseDir, undefined);
      const devPaths = yield* deriveServerPaths(baseDir, new URL("http://localhost:5173"));

      assert.equal(productionPaths.stateDir, PathNode.join(baseDir, "userdata"));
      assert.equal(productionPaths.dbPath, PathNode.join(baseDir, "userdata", "state.sqlite"));
      assert.equal(devPaths.stateDir, PathNode.join(baseDir, "dev"));
      assert.equal(devPaths.dbPath, PathNode.join(baseDir, "dev", "state.sqlite"));
    }),
  );
});
