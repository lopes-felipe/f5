import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Path, PlatformError } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { writeFileBytesAtomically, writeFileStringAtomically } from "./atomicWrite.ts";

// Retries stat the real target between waits, and that I/O finishes outside the
// test clock, so the clock moves one wait at a time until the write settles.
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("100 millis");
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    return yield* Fiber.join(fiber);
  });

const renameError = (code: string, path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    cause: Object.assign(new Error(`${code}, rename`), { code }),
  });

it.layer(NodeServices.layer)("Windows atomic writes", (it) => {
  it.effect("waits out a scanner holding the target, then replaces it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "f5-atomic-lock-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedTwice: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts <= 2
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      };

      const writing = yield* writeFileStringAtomically({
        filePath,
        contents: "after",
        platform: "win32",
      }).pipe(Effect.provideService(FileSystem.FileSystem, lockedTwice), Effect.forkChild);
      yield* Deferred.await(firstAttempt);
      yield* advanceUntilDone(writing);

      assert.strictEqual(attempts, 3);
      assert.strictEqual(yield* fs.readFileString(filePath), "after");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("gives up on a lock that does not clear and keeps the old contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "f5-atomic-lock-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const locked: FileSystem.FileSystem = {
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Deferred.succeed(firstAttempt, undefined).pipe(
              Effect.andThen(Effect.fail(renameError("EPERM", to))),
            );
          }),
      };

      const writing = yield* writeFileStringAtomically({
        filePath,
        contents: "after",
        platform: "win32",
      }).pipe(Effect.provideService(FileSystem.FileSystem, locked), Effect.exit, Effect.forkChild);
      yield* Deferred.await(firstAttempt);

      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(writing)));
      assert.strictEqual(attempts, 21);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("does not replace a newer save that landed while the lock was held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "f5-atomic-lock-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedOnce: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      };

      const stale = yield* writeFileStringAtomically({
        filePath,
        contents: "stale",
        platform: "win32",
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedOnce),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);
      // Another process saves once the lock clears, before the waiting write retries.
      yield* writeFileStringAtomically({ filePath, contents: "newer!" });

      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(stale)));
      assert.strictEqual(yield* fs.readFileString(filePath), "newer!");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("fails at once on a read-only target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "f5-atomic-lock-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      yield* Effect.acquireRelease(fs.chmod(filePath, 0o444), () =>
        fs.chmod(filePath, 0o644).pipe(Effect.ignore),
      );
      let attempts = 0;
      const denied: FileSystem.FileSystem = {
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(renameError("EPERM", to));
          }),
      };

      const writing = yield* writeFileStringAtomically({
        filePath,
        contents: "after",
        platform: "win32",
      }).pipe(Effect.provideService(FileSystem.FileSystem, denied), Effect.exit, Effect.forkChild);
      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(writing)));
      assert.strictEqual(attempts, 1);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
    }),
  );

  it.effect("fails at once on other platforms", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "f5-atomic-lock-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      let attempts = 0;
      const locked: FileSystem.FileSystem = {
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(renameError("EBUSY", to));
          }),
      };

      const result = yield* writeFileStringAtomically({
        filePath,
        contents: "after",
        platform: "darwin",
      }).pipe(Effect.provideService(FileSystem.FileSystem, locked), Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(attempts, 1);
    }),
  );
});

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
