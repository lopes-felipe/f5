import { Effect } from "effect";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  canonicalManagedWorktreesDirectories,
  managedWorktreesDirectories,
  resolveWorktreesDirectory,
} from "./worktreesDirectory.ts";

describe("worktree locations", () => {
  it("accepts default, absolute and home paths, rejecting relative and drive roots", () => {
    const fallback = Path.join(tmpdir(), "f5-worktrees");
    expect(resolveWorktreesDirectory("", fallback)).toBe(fallback);
    expect(resolveWorktreesDirectory("~/worktrees", fallback)).toBe(
      Path.join(homedir(), "worktrees"),
    );
    expect(resolveWorktreesDirectory("relative/worktrees", fallback)).toBeNull();
    expect(resolveWorktreesDirectory(Path.parse(fallback).root, fallback)).toBeNull();
    expect(
      managedWorktreesDirectories(
        {
          worktreesDirectory: fallback + "-new",
          previousWorktreesDirectories: [fallback + "-old", fallback, "relative"],
        },
        fallback,
      ),
    ).toEqual([fallback, fallback + "-new", fallback + "-old"]);
  });
  it("retains old and unavailable locations but rejects symlinks to filesystem roots", async () => {
    const temp = await FS.mkdtemp(Path.join(tmpdir(), "f5-worktrees-directories-"));
    try {
      const canonical = await FS.realpath(temp);
      const rootLink = Path.join(temp, "root-link");
      const oldLink = Path.join(temp, "old-link");
      await FS.symlink(Path.parse(temp).root, rootLink, "dir");
      await FS.symlink(temp, oldLink, "dir");
      const roots = await Effect.runPromise(
        canonicalManagedWorktreesDirectories(
          {
            worktreesDirectory: rootLink,
            previousWorktreesDirectories: [oldLink, Path.join(temp, "unmounted", "worktrees")],
          },
          Path.join(temp, "default"),
        ),
      );
      expect(roots).toEqual([
        Path.join(canonical, "default"),
        canonical,
        Path.join(canonical, "unmounted", "worktrees"),
      ]);
    } finally {
      await FS.rm(temp, { recursive: true, force: true });
    }
  });
});
