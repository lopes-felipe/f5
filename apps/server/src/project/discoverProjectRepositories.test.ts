import { layer as nodeFileSystem } from "@effect/platform-node/NodeFileSystem";
import { Effect, FileSystem } from "effect";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { discoverProjectRepositories } from "./discoverProjectRepositories.ts";

describe("discoverProjectRepositories", () => {
  it("discovers repositories at two levels and excludes linked checkouts and external aliases", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temp = yield* fs.makeTempDirectoryScoped();
        const root = path.join(temp, "project");
        for (const folder of [
          "api/.git",
          "api/subproject/.git",
          "packages/web/.git",
          "packages/backend/deep/.git",
          "vendor/library/.git",
          "linked",
        ]) {
          yield* fs.makeDirectory(path.join(root, folder), { recursive: true });
        }
        const outside = path.join(temp, "outside");
        yield* fs.makeDirectory(path.join(outside, ".git"), { recursive: true });
        yield* fs.symlink(outside, path.join(root, "alias"));
        yield* fs.writeFileString(path.join(root, "linked", ".git"), "gitdir: ../api/.git\n");

        expect(
          (yield* discoverProjectRepositories(root, ["vendor"])).map((row) => row.relativePath),
        ).toEqual(["api", "packages/web"]);
      }).pipe(Effect.scoped, Effect.provide(nodeFileSystem)),
    );
  });

  it("skips filesystem access when the entire project is ignored", async () => {
    expect(
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* discoverProjectRepositories("/workspace/project", ["."]).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readDirectory: () => Effect.die("Unexpected project walk"),
              realPath: () => Effect.die("Unexpected path lookup"),
            }),
          );
        }).pipe(Effect.provide(nodeFileSystem)),
      ),
    ).toEqual([]);
  });
});
