import { parseTurnDiffFilesFromUnifiedDiff } from "../../../src/checkpointing/Diffs.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { CheckpointStoreLive } from "../../../src/checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../../src/checkpointing/Services/CheckpointStore.ts";

const layer = CheckpointStoreLive.pipe(Layer.provide(NodeServices.layer));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function init(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "Checkpoint Test");
  git(cwd, "config", "user.email", "checkpoint@example.test");
}
const capture = (cwd: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* CheckpointStore;
      yield* store.captureCheckpoint({
        cwd,
        checkpointRef: CheckpointRef.makeUnsafe("refs/t3/test-checkpoint"),
      });
    }).pipe(Effect.provide(layer)),
  );

it.each([false, true])(
  "captures around empty nested repositories (parent has HEAD: %s)",
  async (hasHead) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f5-checkpoint-nested-"));
    try {
      init(cwd);
      fs.writeFileSync(path.join(cwd, "tracked.txt"), "initial\n");
      git(cwd, "add", "tracked.txt");
      if (hasHead) git(cwd, "commit", "-m", "initial");
      const index = fs.readFileSync(path.join(cwd, ".git", "index"));
      fs.writeFileSync(path.join(cwd, "tracked.txt"), "completed turn\n");
      fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
      for (const name of ["empty", "nested [literal]"]) {
        const child = path.join(cwd, name);
        init(child);
        fs.writeFileSync(path.join(child, "private.txt"), "not part of parent checkpoint\n");
      }
      const committed = path.join(cwd, "committed-child");
      init(committed);
      fs.writeFileSync(path.join(committed, "child.txt"), "child\n");
      git(committed, "add", "child.txt");
      git(committed, "commit", "-m", "child");
      await capture(cwd);
      expect(git(cwd, "show", "refs/t3/test-checkpoint:tracked.txt")).toBe("completed turn");
      expect(git(cwd, "show", "refs/t3/test-checkpoint:new.txt")).toBe("new");
      const tree = git(cwd, "ls-tree", "refs/t3/test-checkpoint");
      expect(tree).not.toContain("empty");
      expect(tree).not.toContain("nested [literal]");
      expect(tree).toContain(
        `160000 commit ${git(committed, "rev-parse", "HEAD")}\tcommitted-child`,
      );
      expect(fs.readFileSync(path.join(cwd, ".git", "index"))).toEqual(index);
      expect(fs.readFileSync(path.join(cwd, "empty", "private.txt"), "utf8")).toContain("not part");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

it("captures 5,000 new files around an empty nested repository within the Git deadline", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f5-checkpoint-large-"));
  try {
    init(cwd);
    for (let index = 0; index < 5_000; index++) {
      fs.writeFileSync(path.join(cwd, `file-${index}.txt`), `unique checkpoint content ${index}\n`);
    }
    init(path.join(cwd, "empty-child"));
    const start = performance.now();
    await capture(cwd);
    expect(performance.now() - start).toBeLessThan(30_000);
    expect(git(cwd, "ls-tree", "--name-only", "refs/t3/test-checkpoint").split("\n")).toHaveLength(
      5_000,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 45_000);

it.each(["assume-unchanged", "skip-worktree"])(
  "captures edits hidden by %s without modifying the user index",
  async (flag) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f5-checkpoint-index-"));
    try {
      init(cwd);
      fs.writeFileSync(path.join(cwd, "tracked.txt"), "before");
      git(cwd, "add", ".");
      git(cwd, "commit", "-m", "baseline");
      git(cwd, "update-index", `--${flag}`, "tracked.txt");
      const index = fs.readFileSync(path.join(cwd, ".git", "index"));
      fs.writeFileSync(path.join(cwd, "tracked.txt"), "after!");
      await capture(cwd);
      expect(git(cwd, "show", "refs/t3/test-checkpoint:tracked.txt")).toBe("after!");
      expect(fs.readFileSync(path.join(cwd, ".git", "index"))).toEqual(index);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

it("preserves sparse exclusions and captures present files outside the cone", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f5-checkpoint-sparse-"));
  try {
    init(cwd);
    for (const dir of ["included", "excluded"]) {
      fs.mkdirSync(path.join(cwd, dir));
      fs.writeFileSync(path.join(cwd, dir, "file.txt"), dir);
    }
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "baseline");
    git(cwd, "sparse-checkout", "set", "--cone", "--sparse-index", "included");
    const index = fs.readFileSync(path.join(cwd, ".git", "index"));
    fs.mkdirSync(path.join(cwd, "outside"));
    fs.writeFileSync(path.join(cwd, "outside", "new.txt"), "new");
    fs.writeFileSync(path.join(cwd, "included", "file.txt"), "edited");
    await capture(cwd);
    expect(git(cwd, "show", "refs/t3/test-checkpoint:excluded/file.txt")).toBe("excluded");
    expect(git(cwd, "show", "refs/t3/test-checkpoint:included/file.txt")).toBe("edited");
    expect(git(cwd, "show", "refs/t3/test-checkpoint:outside/new.txt")).toBe("new");
    expect(fs.readFileSync(path.join(cwd, ".git", "index"))).toEqual(index);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

it("captures from a nested project directory in its parent Git repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f5-nested-project-"));
  try {
    init(root);
    const nested = path.join(root, "packages", "project");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "file.txt"), "nested change");
    expect(
      await Effect.runPromise(
        Effect.flatMap(Effect.service(CheckpointStore), (store) =>
          store.isGitRepository(nested),
        ).pipe(Effect.provide(layer)),
      ),
    ).toBe(true);
    await capture(nested);
    expect(git(root, "show", "refs/t3/test-checkpoint:packages/project/file.txt")).toBe(
      "nested change",
    );
    git(root, "update-ref", "refs/t3/baseline", "refs/t3/test-checkpoint");
    fs.writeFileSync(path.join(nested, "file.txt"), "final change");
    fs.writeFileSync(path.join(root, "outside.txt"), "not in this project");
    await capture(nested);
    const diff = await Effect.runPromise(
      Effect.flatMap(Effect.service(CheckpointStore), (store) =>
        store.diffCheckpoints({
          cwd: nested,
          fromCheckpointRef: CheckpointRef.makeUnsafe("refs/t3/baseline"),
          toCheckpointRef: CheckpointRef.makeUnsafe("refs/t3/test-checkpoint"),
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(diff).toContain("diff --git a/file.txt b/file.txt");
    expect(diff).not.toContain("packages/project/");
    expect(diff).not.toContain("outside.txt");
    const files = parseTurnDiffFilesFromUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("file.txt");
    // The editor resolves the projected path against the active project cwd.
    expect(fs.readFileSync(path.resolve(nested, files[0]!.path), "utf8")).toBe("final change");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
