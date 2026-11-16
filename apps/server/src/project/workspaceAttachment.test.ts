import { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
import { profileRegistryPath } from "@t3tools/shared/profilePaths";
import { Effect } from "effect";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { expect, it } from "vitest";
import type { ServerConfigShape } from "../config.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { inspectAttachableWorkspace } from "./workspaceAttachment.ts";

it("surfaces the profile guard's own failure instead of a generic tryPromise error", async () => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-attach-guard-"));
  try {
    const state = Path.join(root, "userdata");
    const checkout = Path.join(root, "repo");
    await FS.mkdir(checkout);
    const registryPath = profileRegistryPath(state);
    await FS.mkdir(Path.dirname(registryPath), { recursive: true });
    await FS.writeFile(registryPath, "unreadable registry");
    const config = {
      defaultStateDir: state,
      profile: fallbackDefaultProfile(state),
      baseDir: root,
      worktreesDir: Path.join(root, "worktrees"),
    } as unknown as ServerConfigShape;
    const git = {
      resolveCommonDir: (cwd: string) => Effect.succeed(Path.join(cwd, ".git")),
    } as unknown as GitCoreShape;

    const error = await Effect.runPromise(
      Effect.flip(inspectAttachableWorkspace(git, config, checkout, checkout)),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Managed workspace ownership could not be established.");
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});
