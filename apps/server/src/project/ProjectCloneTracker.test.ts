import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Deferred, Effect } from "effect";
import { GitCommandError } from "../git/Errors.ts";
import {
  makeProjectCloneTracker,
  normalizeCloneUrl,
  validateCloneDirectory,
} from "./ProjectCloneTracker.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const parentPath = await realpath(await mkdtemp(path.join(os.tmpdir(), "f5-clone-test-")));
  directories.push(parentPath);
  return {
    parentPath,
    stateDir: path.join(parentPath, "state"),
    operationId: randomUUID(),
    url: "owner/repo",
    directoryName: "repo",
  };
}
it("defaults shorthand to HTTPS and refuses credential URLs, local protocols and unsafe destinations", () => {
  expect(normalizeCloneUrl("owner/repo")).toBe("https://github.com/owner/repo.git");
  expect(normalizeCloneUrl("git@example.com:owner/repo.git")).toBe(
    "git@example.com:owner/repo.git",
  );
  for (const url of [
    "file:///tmp/repo",
    "ext::sh -c example",
    "https://token@example.com/repo",
    "https://example.com/repo?token=secret",
  ])
    expect(() => normalizeCloneUrl(url)).toThrow();
  for (const name of ["..", "../other", "a/b", "a\\b", "NUL", "COM1.txt", "x "])
    expect(() => validateCloneDirectory(name)).toThrow();
});
it("returns before completion, deduplicates retries, and registers a successful project once", async () => {
  const input = await fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        const clone = vi.fn(() => Deferred.await(done));
        const register = vi.fn(() => Effect.void);
        const tracker = yield* makeProjectCloneTracker({
          ...input,
          scope: yield* Effect.scope,
          git: { cloneRepository: clone },
          onComplete: register,
        });
        const first = yield* tracker.start(input);
        const retry = yield* tracker.start(input);
        expect(first.destination).toBe(path.join(input.parentPath, "repo"));
        expect(retry.operationId).toBe(first.operationId);
        yield* Effect.promise(() => expect.poll(() => clone.mock.calls.length).toBe(1));
        expect(register).not.toHaveBeenCalled();
        yield* Deferred.succeed(done, undefined);
        yield* Effect.promise(() => expect.poll(() => tracker.list()[0]?.status).toBe("complete"));
        expect(register).toHaveBeenCalledTimes(1);
        const conflict = yield* tracker.start({ ...input, url: "other/repo" }).pipe(Effect.result);
        expect(conflict._tag).toBe("Failure");
      }),
    ),
  );
});
it("cancels the owned process and preserves partial files without creating a project", async () => {
  const input = await fixture();
  let interrupted = false;
  const register = vi.fn(() => Effect.void);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tracker = yield* makeProjectCloneTracker({
          ...input,
          scope: yield* Effect.scope,
          onComplete: register,
          git: {
            cloneRepository: ({ cwd }) =>
              Effect.promise(() => writeFile(path.join(cwd, "partial"), "kept")).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
          },
        });
        yield* tracker.start(input);
        yield* Effect.promise(() =>
          expect
            .poll(async () => readFile(path.join(input.parentPath, "repo/partial"), "utf8"))
            .toBe("kept"),
        );
        yield* tracker.cancel(input.operationId);
        expect(interrupted).toBe(true);
        expect(tracker.list()[0]?.status).toBe("cancelled");
        expect(register).not.toHaveBeenCalled();
        expect(
          yield* Effect.promise(() =>
            readFile(path.join(input.parentPath, "repo/partial"), "utf8"),
          ),
        ).toBe("kept");
      }),
    ),
  );
});
it("refuses an existing destination and restores interrupted jobs without restarting Git", async () => {
  const input = await fixture();
  await mkdir(path.join(input.parentPath, "repo"));
  await mkdir(input.stateDir);
  await writeFile(
    path.join(input.stateDir, "project-clones.json"),
    JSON.stringify([
      {
        ...input,
        projectId: input.operationId,
        destination: path.join(input.parentPath, "repo"),
        status: "cloning",
        progress: "Receiving objects: 30%",
        error: null,
        createdAt: new Date().toISOString(),
      },
    ]),
  );
  const clone = vi.fn(() => Effect.void);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tracker = yield* makeProjectCloneTracker({
          ...input,
          scope: yield* Effect.scope,
          git: { cloneRepository: clone },
          onComplete: () => Effect.void,
        });
        expect(tracker.list()[0]?.status).toBe("failed");
        const result = yield* tracker
          .start({ ...input, operationId: randomUUID() })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(clone).not.toHaveBeenCalled();
      }),
    ),
  );
});
it("limits running clones to two and keeps the queue moving after a failure", async () => {
  const input = await fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        let active = 0;
        let peak = 0;
        const tracker = yield* makeProjectCloneTracker({
          ...input,
          scope: yield* Effect.scope,
          onComplete: () => Effect.void,
          git: {
            cloneRepository: ({ cwd }) =>
              Effect.gen(function* () {
                active += 1;
                peak = Math.max(peak, active);
                yield* Deferred.await(release);
                if (cwd.endsWith("repo-0"))
                  return yield* Effect.fail(
                    new GitCommandError({
                      operation: "clone",
                      command: "git clone",
                      cwd,
                      detail: "network unavailable",
                    }),
                  );
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active -= 1;
                  }),
                ),
              ),
          },
        });
        for (let index = 0; index < 4; index++)
          yield* tracker.start({
            ...input,
            operationId: randomUUID(),
            directoryName: `repo-${index}`,
          });
        yield* Effect.promise(() => expect.poll(() => active).toBe(2));
        expect(tracker.list().filter((job) => job.status === "queued")).toHaveLength(2);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.promise(() =>
          expect
            .poll(() => tracker.list().filter((job) => job.status === "complete").length)
            .toBe(3),
        );
        expect(tracker.list().filter((job) => job.status === "failed")).toHaveLength(1);
        expect(peak).toBe(2);
      }),
    ),
  );
});
