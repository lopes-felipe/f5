import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vitest";
import { readProjectSettings } from "./projectSettings";
it("reads bounded checked-in settings, prefers f5.json and refuses symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f5-project-settings-"));
  const project = { id: ProjectId.makeUnsafe("project"), workspaceRoot: root };
  const read = () => Effect.runPromise(readProjectSettings(DEFAULT_SERVER_SETTINGS, project));
  try {
    await writeFile(path.join(root, "t3.json"), JSON.stringify({ worktreeSubmodules: "none" }));
    expect((await read()).settings.worktreeSubmodules).toBe("none");
    await writeFile(path.join(root, "f5.json"), JSON.stringify({ worktreeSubmodules: "shallow" }));
    expect((await read()).sources.worktreeSubmodules).toBe("f5.json");
    expect((await read()).settings.worktreeSubmodules).toBe("shallow");
    await writeFile(path.join(root, "f5.json"), " ".repeat(65537));
    expect((await read()).settings.worktreeSubmodules).toBe("recursive");
    await rm(path.join(root, "f5.json"));
    await mkdir(path.join(root, "external"));
    await writeFile(
      path.join(root, "external", "settings.json"),
      JSON.stringify({ worktreeSubmodules: "none" }),
    );
    await symlink(path.join(root, "external", "settings.json"), path.join(root, "f5.json"));
    expect((await read()).settings.worktreeSubmodules).toBe("recursive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
