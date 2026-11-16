import { constants } from "node:fs";
import fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { GitCommandError } from "./Errors.ts";

export const MoveUntrackedFile = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  mode: Schema.Number,
  size: Schema.Number,
  symlink: Schema.Boolean,
});
export const MoveSnapshot = Schema.Struct({
  baseSha: Schema.String,
  trackedStashSha: Schema.NullOr(Schema.String),
  trackedTree: Schema.NullOr(Schema.String),
  indexTree: Schema.NullOr(Schema.String),
  untracked: Schema.Array(MoveUntrackedFile),
  copiedFileCount: Schema.Number,
});
export type MoveSnapshot = typeof MoveSnapshot.Type;
type UntrackedFile = typeof MoveUntrackedFile.Type;
type Run = (cwd: string, args: readonly string[]) => Effect.Effect<string, GitCommandError>;
class MoveSnapshotError extends Error {
  readonly _tag = "MoveSnapshotError";
}
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MoveSnapshotError(cause instanceof Error ? cause.message : String(cause)),
  });
const MAX_FILES = 5_000;
const MAX_BYTES = 500 * 1024 * 1024;

/** Never follow parent symlinks, including paths supplied by an untrusted Git index. */
async function safePath(root: string, relative: string, createParents = false) {
  const pieces = relative.split("/");
  if (
    !relative ||
    path.isAbsolute(relative) ||
    pieces.some(
      (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || p.includes("\\"),
    )
  )
    throw new Error(`Unsafe copy path: ${JSON.stringify(relative)}`);
  let parent = root;
  for (const piece of pieces.slice(0, -1)) {
    parent = path.join(parent, piece);
    if (createParents)
      await fs.mkdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("A copy parent is not a directory.");
  }
  return path.join(parent, pieces.at(-1)!);
}
async function inspectFile(root: string, relative: string): Promise<UntrackedFile> {
  const file = await safePath(root, relative);
  const stat = await fs.lstat(file);
  if (!stat.isFile() && !stat.isSymbolicLink())
    throw new Error(`Cannot copy special file ${JSON.stringify(relative)}.`);
  if (stat.size > MAX_BYTES) throw new Error("Untracked files exceed the 500 MB move limit.");
  const hash = createHash("sha256");
  if (stat.isSymbolicLink()) hash.update(await fs.readlink(file, { encoding: "buffer" }));
  else {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(Math.max(1, Math.min(stat.size, 1024 * 1024)));
      let offset = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > MAX_BYTES) throw new Error("Untracked files exceed the 500 MB move limit.");
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (
        stat.ino !== after.ino ||
        stat.size !== after.size ||
        stat.mtimeMs !== after.mtimeMs ||
        stat.ctimeMs !== after.ctimeMs
      )
        throw new Error("The project checkout changed while copying. Try again.");
    } finally {
      await handle.close();
    }
  }
  return {
    path: relative,
    sha256: hash.digest("hex"),
    mode: stat.mode & 0o777,
    size: stat.size,
    symlink: stat.isSymbolicLink(),
  };
}
export const sameMoveFile = (a: UntrackedFile, b: UntrackedFile | undefined) =>
  b !== undefined &&
  a.path === b.path &&
  a.sha256 === b.sha256 &&
  (a.symlink || a.mode === b.mode) &&
  a.size === b.size &&
  a.symlink === b.symlink;
const filesEqual = (a: readonly UntrackedFile[], b: readonly UntrackedFile[]) =>
  a.length === b.length && a.every((file, i) => sameMoveFile(file, b[i]));
export function sameMoveSnapshot(a: MoveSnapshot, b: MoveSnapshot) {
  return (
    a.baseSha === b.baseSha &&
    a.trackedTree === b.trackedTree &&
    a.indexTree === b.indexTree &&
    filesEqual(a.untracked, b.untracked)
  );
}

/** A failed copy may contain none or a prefix of the untracked manifest. */
export function isMoveCopySnapshot(copy: MoveSnapshot, original: MoveSnapshot) {
  const expectedFiles = new Map(original.untracked.map((file) => [file.path, file]));
  return (
    copy.baseSha === original.baseSha &&
    (!copy.trackedTree ||
      (copy.trackedTree === original.trackedTree && copy.indexTree === original.indexTree)) &&
    copy.untracked.every((file) => sameMoveFile(file, expectedFiles.get(file.path)))
  );
}

export function makeMoveSnapshotOperations(run: Run): MoveSnapshotOperations {
  const stashCreate = (cwd: string) =>
    run(cwd, ["stash", "create"]).pipe(Effect.map((out) => out.trim() || null));
  const readMoveSnapshot = (cwd: string) =>
    Effect.gen(function* () {
      const status = yield* run(cwd, [
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "-z",
        "--ignore-submodules=none",
        "--untracked-files=normal",
      ]);
      if (
        status
          .split("\0")
          .some((entry) => /^[12] /.test(entry) && !["N...", "S..."].includes(entry.split(" ")[2]!))
      )
        return yield* Effect.fail(new Error("Commit or stash submodule changes first."));
      const baseSha = (yield* run(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      const paths = (yield* run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
        .split("\0")
        .filter(Boolean)
        .sort();
      if (paths.length > MAX_FILES)
        return yield* Effect.fail(new Error("Move supports at most 5,000 untracked files."));
      const nestedRepository = paths.find((file) => file.endsWith("/"));
      if (nestedRepository)
        return yield* Effect.fail(
          new Error(
            `Untracked nested repository ${JSON.stringify(nestedRepository)} cannot be copied. Commit, ignore, or remove it before moving this conversation.`,
          ),
        );
      const untracked = yield* io(async () => {
        const files: UntrackedFile[] = [];
        let bytes = 0;
        for (const relative of paths) {
          const file = await inspectFile(cwd, relative);
          bytes += file.size;
          if (bytes > MAX_BYTES) throw new Error("Untracked files exceed the 500 MB move limit.");
          files.push(file);
        }
        return files;
      });
      const trackedStashSha = yield* stashCreate(cwd);
      if (
        trackedStashSha &&
        (yield* run(cwd, ["rev-parse", `${trackedStashSha}^1`])).trim() !== baseSha
      )
        return yield* Effect.fail(
          new Error("The project HEAD changed while taking the move snapshot. Try again."),
        );
      const trackedTree = trackedStashSha
        ? (yield* run(cwd, ["rev-parse", `${trackedStashSha}^{tree}`])).trim()
        : null;
      const indexTree = trackedStashSha
        ? (yield* run(cwd, ["rev-parse", `${trackedStashSha}^2^{tree}`])).trim()
        : null;
      const changed = new Set<string>();
      for (const args of [
        ["diff", "--name-only", "-z", "HEAD", "--"],
        ["diff", "--cached", "--name-only", "-z", "HEAD", "--"],
      ]) {
        for (const file of (yield* run(cwd, args)).split("\0").filter(Boolean)) changed.add(file);
      }
      for (const file of paths) changed.add(file);
      return {
        baseSha,
        trackedStashSha,
        trackedTree,
        indexTree,
        untracked,
        copiedFileCount: changed.size,
      } satisfies MoveSnapshot;
    });
  const copyMoveUntracked = (source: string, target: string, files: readonly UntrackedFile[]) =>
    io(async () => {
      for (const file of files) {
        if (!filesEqual([file], [await inspectFile(source, file.path)]))
          throw new Error("The project checkout changed while copying. Try again.");
        const from = await safePath(source, file.path);
        const to = await safePath(target, file.path, true);
        if (file.symlink) await fs.symlink(await fs.readlink(from), to);
        else {
          // EXCL prevents overwriting anything generated in the destination.
          await fs.copyFile(from, to, constants.COPYFILE_EXCL);
          await fs.chmod(to, file.mode);
        }
        if (!filesEqual([file], [await inspectFile(target, file.path)]))
          throw new Error("A copied file changed during the move.");
      }
    }).pipe(Effect.uninterruptible); // Settle every filesystem write before cancellation releases ownership.
  return {
    readMoveSnapshot,
    copyMoveUntracked,
    stashCreate,
    stashApplySha: (cwd: string, sha: string) =>
      run(cwd, ["stash", "apply", "--index", sha]).pipe(Effect.asVoid),
    stashPushAll: (cwd: string, message: string) =>
      run(cwd, ["stash", "push", "--include-untracked", "-m", message]).pipe(Effect.asVoid),
    setMoveRef: (cwd: string, ref: string, sha: string) =>
      run(cwd, ["update-ref", ref, sha, ""]).pipe(Effect.asVoid),
    deleteMoveRef: (cwd: string, ref: string, sha: string) =>
      run(cwd, ["update-ref", "-d", ref, sha]).pipe(Effect.asVoid),
    /** Only called after a full snapshot match and the owned removal gate (excluding copied dirt). */
    cleanMoveCopies: (cwd: string, snapshot: MoveSnapshot) =>
      Effect.gen(function* () {
        yield* run(cwd, ["read-tree", "--reset", "-u", snapshot.baseSha]);
        yield* io(async () => {
          for (const file of snapshot.untracked) {
            if (!filesEqual([file], [await inspectFile(cwd, file.path)]))
              throw new Error("A rollback copy changed; checkout retained.");
            await fs.unlink(await safePath(cwd, file.path));
          }
        });
      }),
  };
}
export interface MoveSnapshotOperations {
  readMoveSnapshot: (cwd: string) => Effect.Effect<MoveSnapshot, Error>;
  copyMoveUntracked: (
    source: string,
    target: string,
    files: readonly UntrackedFile[],
  ) => Effect.Effect<void, Error>;
  stashCreate: (cwd: string) => Effect.Effect<string | null, Error>;
  stashApplySha: (cwd: string, sha: string) => Effect.Effect<void, Error>;
  stashPushAll: (cwd: string, message: string) => Effect.Effect<void, Error>;
  setMoveRef: (cwd: string, ref: string, sha: string) => Effect.Effect<void, Error>;
  deleteMoveRef: (cwd: string, ref: string, sha: string) => Effect.Effect<void, Error>;
  cleanMoveCopies: (cwd: string, snapshot: MoveSnapshot) => Effect.Effect<void, Error>;
}
