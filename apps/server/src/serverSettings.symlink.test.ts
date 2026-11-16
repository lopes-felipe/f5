import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import { ServerConfig } from "./config.ts";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings.ts";

const settingsLayer = () =>
  ServerSettingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "f5-settings-symlink-" })),
    ),
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const service = yield* ServerSettingsService;
  // Scoped to the test, so the folder outlives the settings layer that may still write into it.
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "f5-dotfiles-" });
  const first = path.join(directory, "first", "settings.json");
  const second = path.join(directory, "second", "settings.json");
  const write = (filePath: string, name: string) =>
    writeFileStringAtomically({
      filePath,
      contents: JSON.stringify({ gitAuthorName: name }),
    });
  return { fs, path, config, service, first, second, write };
});

it.layer(NodeServices.layer)("symlinked server settings", (it) => {
  it.effect("saves the destination while retaining the settings symlink", () =>
    Effect.gen(function* () {
      const { fs, config, service, first, write } = yield* fixture;
      yield* write(first, "Initial");
      yield* fs.symlink(first, config.settingsPath!);
      yield* service.updateSettings({ gitAuthorName: "Saved" });
      assert.equal(yield* fs.readLink(config.settingsPath!), first);
      assert.equal(JSON.parse(yield* fs.readFileString(first)).gitAuthorName, "Saved");
    }).pipe(Effect.provide(settingsLayer())),
  );

  it.effect("reloads an atomically replaced destination outside the link directory", () =>
    Effect.gen(function* () {
      const { fs, config, service, first, write } = yield* fixture;
      yield* write(first, "Initial");
      yield* fs.symlink(first, config.settingsPath!);
      yield* service.start;
      const changes = yield* service.subscribeChanges;
      yield* write(first, "External edit");
      const changed = yield* Stream.runHead(changes).pipe(Effect.timeout("2 seconds"));
      assert.equal(Option.getOrUndefined(changed)?.gitAuthorName, "External edit");
      assert.equal((yield* service.getSettings).gitAuthorName, "External edit");
    }).pipe(TestClock.withLive, Effect.provide(settingsLayer())),
  );

  it.effect("moves its destination watch when the link is repointed", () =>
    Effect.gen(function* () {
      const { fs, config, service, first, second, write } = yield* fixture;
      yield* write(first, "Initial");
      yield* write(second, "Second");
      yield* fs.symlink(first, config.settingsPath!);
      yield* service.start;
      const repoint = yield* service.subscribeChanges;
      yield* fs.remove(config.settingsPath!);
      yield* fs.symlink(second, config.settingsPath!);
      const repointed = yield* Stream.runHead(repoint).pipe(Effect.timeout("2 seconds"));
      assert.equal(Option.getOrUndefined(repointed)?.gitAuthorName, "Second");
      const edits = yield* service.subscribeChanges;
      yield* write(second, "Moved edit");
      const edited = yield* Stream.runHead(edits).pipe(Effect.timeout("2 seconds"));
      assert.equal(Option.getOrUndefined(edited)?.gitAuthorName, "Moved edit");
    }).pipe(TestClock.withLive, Effect.provide(settingsLayer())),
  );

  it.effect("reloads a dangling link when its missing destination is created", () =>
    Effect.gen(function* () {
      const { fs, config, service, first, write } = yield* fixture;
      yield* fs.symlink(first, config.settingsPath!);
      yield* service.start;
      const changes = yield* service.subscribeChanges;
      yield* write(first, "Created");
      const created = yield* Stream.runHead(changes).pipe(Effect.timeout("2 seconds"));
      assert.equal(Option.getOrUndefined(created)?.gitAuthorName, "Created");
    }).pipe(TestClock.withLive, Effect.provide(settingsLayer())),
  );
});
