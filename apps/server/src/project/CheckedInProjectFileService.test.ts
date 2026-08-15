import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { makeWorkspaceAssetAuthorizer } from "../WorkspaceAssetAuthorizer";
import { makeCheckedInProjectFileService } from "./CheckedInProjectFileService";

const tempDirs: string[] = [];

async function makeHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "f5-project-file-"));
  tempDirs.push(root);
  const projectId = ProjectId.makeUnsafe("project-config-test");
  const authorizer = makeWorkspaceAssetAuthorizer({
    resolveProjectWorkspaceRoot: async (candidate) => (candidate === projectId ? root : null),
  });
  return { root, projectId, service: makeCheckedInProjectFileService(authorizer) };
}

describe("CheckedInProjectFileService", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("prefers f5.json and preserves valid fields alongside diagnostics", async () => {
    const { root, projectId, service } = await makeHarness();
    await writeFile(
      path.join(root, "icon.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
    );
    await writeFile(
      path.join(root, "f5.json"),
      JSON.stringify({ defaultThreadEnvMode: "worktree", iconPath: "icon.png", scripts: [] }),
    );
    await writeFile(path.join(root, "t3.json"), JSON.stringify({ defaultThreadEnvMode: "local" }));

    const result = await service.load(projectId);
    expect(result.sourceFile).toBe("f5.json");
    expect(result.defaultThreadEnvMode).toBe("worktree");
    expect(result.iconPath).toBe("icon.png");
    expect(result.diagnostics.map((diagnostic) => diagnostic.field)).toEqual(["scripts"]);
  });

  it("reads t3.json only when f5.json is absent", async () => {
    const { root, projectId, service } = await makeHarness();
    await writeFile(path.join(root, "t3.json"), JSON.stringify({ defaultThreadEnvMode: "local" }));

    expect(await service.load(projectId)).toMatchObject({
      sourceFile: "t3.json",
      defaultThreadEnvMode: "local",
    });
  });

  it("rejects symbolic-link configuration files", async () => {
    const { root, projectId, service } = await makeHarness();
    await writeFile(
      path.join(root, "actual.json"),
      JSON.stringify({ defaultThreadEnvMode: "local" }),
    );
    await symlink(path.join(root, "actual.json"), path.join(root, "f5.json"));

    const result = await service.load(projectId);
    expect(result.sourceFile).toBe("f5.json");
    expect(result.defaultThreadEnvMode).toBeNull();
    expect(result.diagnostics[0]?.message).toMatch(/symbolic link/iu);
  });
});
