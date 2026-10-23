import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path, Scope, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vitest";
import { watchSettingsFile } from "./watchSettingsFile.ts";

const state = vi.hoisted(() => ({
  watchers: [] as {
    directory: string;
    listener: (event: string, name: string | null) => void;
    closes: number;
    on: (name: string, listener: (cause: Error) => void) => void;
    close: () => void;
  }[],
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: (
    directory: string,
    _options: unknown,
    listener: (event: string, name: string | null) => void,
  ) => {
    const watcher = {
      directory,
      listener,
      closes: 0,
      on: () => {},
      close: () => {
        watcher.closes++;
      },
    };
    state.watchers.push(watcher);
    return watcher;
  },
}));
beforeEach(() => {
  state.watchers.length = 0;
});

it.layer(NodeServices.layer)("settings watcher ownership", (it) => {
  it.effect(
    "rechecks a remove/create pair even when the OS coalesces away its creation event",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "f5-settings-events-" });
        const first = path.join(directory, "first");
        const second = path.join(directory, "second");
        yield* fs.makeDirectory(first);
        yield* fs.makeDirectory(second);
        const link = path.join(directory, "settings.json");
        yield* fs.symlink(path.join(first, "settings.json"), link);
        const scope = yield* Scope.make();
        const events = yield* watchSettingsFile(link).pipe(Scope.provide(scope));
        assert.equal(state.watchers.length, 2, "both watches are attached before startup returns");
        try {
          yield* fs.remove(link);
          state.watchers[0]!.listener("rename", "settings.json");
          yield* Stream.runHead(events);
          assert.equal(state.watchers[1]!.closes, 1);
          yield* fs.symlink(path.join(second, "settings.json"), link);
          // No creation event: the pending verification must discover this destination.
          yield* Stream.runHead(events).pipe(Effect.timeout("2 seconds"));
          assert.equal(state.watchers.at(-1)!.directory, yield* fs.realPath(second));
          assert.equal(state.watchers.at(-1)!.closes, 0);
        } finally {
          yield* Scope.close(scope, Exit.void);
        }
        assert.isTrue(state.watchers.every((watcher) => watcher.closes === 1));
      }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("detects an atomic save even when the native watcher sends no event", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "f5-settings-lost-event-" });
      const file = path.join(directory, "settings.json");
      yield* fs.writeFileString(file, "before");
      const events = yield* watchSettingsFile(file);
      const temporary = path.join(directory, "next.json");
      yield* fs.writeFileString(temporary, "after");
      yield* fs.rename(temporary, file);
      // The fake watcher never emits. Metadata changes must still invalidate.
      yield* Stream.runHead(events).pipe(Effect.timeout("2 seconds"));
      assert.equal(yield* fs.readFileString(file), "after");
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("closes the root watch when initial link resolution fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "f5-settings-loop-" });
      const link = path.join(directory, "settings.json");
      yield* fs.symlink("settings.json", link);
      const result = yield* Effect.exit(Effect.scoped(watchSettingsFile(link)));
      assert.isTrue(Exit.isFailure(result));
      assert.equal(state.watchers.length, 1);
      assert.equal(state.watchers[0]!.closes, 1);
    }).pipe(Effect.scoped),
  );
});
