import * as PathNode from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { defaultF5BaseDir } from "@t3tools/shared/appStatePaths";

import { deriveServerPaths, ensureStateDirectories } from "./config";
import { resolveBaseDir, resolveStateDir } from "./os-jank";

it.layer(NodeServices.layer)("server config paths", (it) => {
  it.effect("restricts new and existing state directories to their owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "f5-state-mode-" });
        const paths = yield* deriveServerPaths({
          baseDir,
          defaultStateDir: PathNode.join(baseDir, "state"),
        });
        yield* ensureStateDirectories(paths);
        if (process.platform !== "win32")
          assert.equal((yield* fs.stat(paths.stateDir)).mode & 0o777, 0o700);
        yield* fs.chmod(paths.stateDir, 0o755);
        yield* ensureStateDirectories(paths);
        if (process.platform !== "win32")
          assert.equal((yield* fs.stat(paths.stateDir)).mode & 0o777, 0o700);
      }),
    ),
  );

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
      const baseDir = PathNode.resolve("tmp", "f5-home");
      const productionPaths = yield* deriveServerPaths({
        baseDir,
        defaultStateDir: PathNode.join(baseDir, "userdata"),
      });
      const devPaths = yield* deriveServerPaths({
        baseDir,
        defaultStateDir: PathNode.join(baseDir, "dev"),
      });

      assert.equal(productionPaths.stateDir, PathNode.join(baseDir, "userdata"));
      assert.equal(productionPaths.dbPath, PathNode.join(baseDir, "userdata", "state.sqlite"));
      assert.equal(devPaths.stateDir, PathNode.join(baseDir, "dev"));
      assert.equal(devPaths.dbPath, PathNode.join(baseDir, "dev", "state.sqlite"));
    }),
  );
  it.effect("includes settings, secrets and status cache for an explicit state directory", () =>
    Effect.gen(function* () {
      const baseDir = PathNode.resolve("custom-root");
      const stateDir = PathNode.join(baseDir, "custom-state");
      const paths = yield* deriveServerPaths({ baseDir, defaultStateDir: stateDir });
      assert.equal(paths.settingsPath, PathNode.join(stateDir, "settings.json"));
      assert.equal(paths.secretsDir, PathNode.join(stateDir, "secrets"));
      assert.equal(paths.providerStatusCacheDir, PathNode.join(stateDir, "provider-status-cache"));
      assert.equal(paths.worktreesDir, PathNode.join(baseDir, "worktrees"));
    }),
  );
});
