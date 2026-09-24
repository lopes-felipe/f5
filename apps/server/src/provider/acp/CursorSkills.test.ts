import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { cursorSkillCommands, discoverCursorSkills } from "./CursorSkills.ts";

it("follows linked skill packages once, preserves the link name and prefers project skills", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f5-cursor-skills-"));
  try {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const library = path.join(root, "library");
    const skillsRoot = path.join(project, ".cursor", "skills");
    const writeSkill = async (directory: string, description: string) => {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), `---\ndescription: ${description}\n---\n`);
    };
    await writeSkill(path.join(home, ".cursor", "skills", "3d-review"), "user description");
    await writeSkill(library, "project description");
    await writeSkill(path.join(library, "hidden-child"), "do not recurse here");
    await mkdir(skillsRoot, { recursive: true });
    await symlink(library, path.join(skillsRoot, "3d-review"), "junction");
    await symlink(skillsRoot, path.join(skillsRoot, "cycle"), "junction");
    const skills = await Effect.runPromise(
      discoverCursorSkills(project, { HOME: home }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(skills).toEqual([
      {
        name: "3d-review",
        description: "project description",
        path: path.join(skillsRoot, "3d-review", "SKILL.md"),
        scope: "project",
        enabled: true,
      },
    ]);
    expect(cursorSkillCommands(skills)).toEqual([
      { name: "3d-review", description: "project description" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
