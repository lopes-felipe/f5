import { DatabaseSync } from "node:sqlite";
import { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
import { profileRegistryPath, profileStateDir } from "@t3tools/shared/profilePaths";
import { ProfileId } from "@t3tools/contracts";
import {
  assertExclusiveProfileCheckout,
  assertNotOtherProfileManagedCheckout,
} from "./RepositorySharing";
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

it("blocks shared-root changes for another profile's archived effective workspace and unreadable registration", async () => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-transition-profiles-"));
  try {
    const state = Path.join(root, "userdata"),
      checkout = Path.join(root, "repo");
    await FS.mkdir(checkout);
    const current = fallbackDefaultProfile(state);
    const other = {
      ...current,
      id: ProfileId.makeUnsafe("a".repeat(32)),
      slug: "other",
      name: "Other",
      port: current.port + 1,
      isDefault: false,
    };
    const registryPath = profileRegistryPath(state);
    await FS.mkdir(Path.dirname(registryPath), { recursive: true });
    await FS.writeFile(
      registryPath,
      JSON.stringify({ version: 1, retiredPorts: [], profiles: [current, other] }),
    );
    const otherState = profileStateDir(state, other);
    await FS.mkdir(otherState, { recursive: true });
    const siblingManaged = Path.join(otherState, "worktrees", "topic");
    await FS.mkdir(siblingManaged, { recursive: true });
    await expect(
      assertNotOtherProfileManagedCheckout(
        { defaultStateDir: state, profile: current, baseDir: root },
        siblingManaged,
      ),
    ).rejects.toThrow(/Another profile owns/);
    const custom = Path.join(root, "other-custom");
    const previous = Path.join(root, "other-previous");
    await FS.mkdir(custom);
    await FS.mkdir(previous);
    await FS.writeFile(
      Path.join(otherState, "settings.json"),
      JSON.stringify({
        worktreesDirectory: custom,
        previousWorktreesDirectories: [previous],
      }),
    );
    for (const managed of [custom, previous]) {
      await expect(
        assertNotOtherProfileManagedCheckout(
          { defaultStateDir: state, profile: current, baseDir: root },
          Path.join(managed, "repo", "topic"),
        ),
      ).rejects.toThrow(/Another profile owns/);
    }
    await FS.writeFile(Path.join(otherState, "settings.json"), '{"credential":"private-value",');
    await expect(
      assertNotOtherProfileManagedCheckout(
        { defaultStateDir: state, profile: current, baseDir: root },
        siblingManaged,
      ),
    ).rejects.toThrow("Managed workspace ownership could not be established.");
    await FS.writeFile(Path.join(otherState, "settings.json"), "{}");
    const db = new DatabaseSync(Path.join(otherState, "state.sqlite"));
    try {
      db.exec(
        "CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT); CREATE TABLE projection_threads(project_id TEXT,worktree_path TEXT,deleted_at TEXT,archived_at TEXT)",
      );
      db.prepare("INSERT INTO projection_projects VALUES ('project',?,NULL)").run(checkout);
      db.exec("INSERT INTO projection_threads VALUES ('project',NULL,NULL,'archived')");
      await expect(
        assertExclusiveProfileCheckout({ defaultStateDir: state, profile: current }, checkout),
      ).rejects.toThrow(/Another profile/);
      db.prepare("UPDATE projection_projects SET workspace_root=?").run(
        Path.join(root, "unrelated"),
      );
      await expect(
        assertExclusiveProfileCheckout({ defaultStateDir: state, profile: current }, checkout),
      ).resolves.toBeUndefined();
    } finally {
      db.close();
    }
    await FS.writeFile(registryPath, "unreadable registry");
    await expect(
      assertExclusiveProfileCheckout({ defaultStateDir: state, profile: current }, checkout),
    ).rejects.toThrow(/could not be established/);
    await expect(
      assertNotOtherProfileManagedCheckout(
        { defaultStateDir: state, profile: current, baseDir: root },
        checkout,
      ),
    ).rejects.toThrow("Managed workspace ownership could not be established.");
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});
