import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { expect, it } from "vitest";
import { canonicalGitCommonDirectory } from "./RepositorySharing";

it("recognizes linked worktrees without treating separate clones as shared", async () => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-common-dir-"));
  try {
    const main = Path.join(root, "main");
    const linked = Path.join(root, "linked");
    const clone = Path.join(root, "clone");
    const metadata = Path.join(main, ".git", "worktrees", "linked");
    await FS.mkdir(metadata, { recursive: true });
    await FS.mkdir(linked);
    await FS.mkdir(Path.join(clone, ".git"), { recursive: true });
    await FS.writeFile(Path.join(linked, ".git"), `gitdir: ${metadata}\n`);
    await FS.writeFile(Path.join(metadata, "commondir"), "../..\n");
    expect(await canonicalGitCommonDirectory(linked)).toBe(await canonicalGitCommonDirectory(main));
    expect(await canonicalGitCommonDirectory(clone)).not.toBe(
      await canonicalGitCommonDirectory(main),
    );
    expect(await canonicalGitCommonDirectory(Path.join(root, "missing"))).toBeNull();
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});
