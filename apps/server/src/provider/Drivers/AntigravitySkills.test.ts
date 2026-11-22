import * as fs from "node:fs/promises";
import os from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAntigravitySkills, parseAntigravitySkillsConfig } from "./AntigravitySkills.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function layout() {
  const base = await fs.realpath(await fs.mkdtemp(NodePath.join(os.tmpdir(), "f5-agy-skills-")));
  roots.push(base);
  const userHome = NodePath.join(base, "home");
  const profileDirectory = NodePath.join(base, "profile");
  const cwd = NodePath.join(base, "project");
  const outside = NodePath.join(base, "outside");
  for (const directory of [userHome, profileDirectory, cwd, outside])
    await fs.mkdir(directory, { recursive: true });
  return { base, userHome, profileDirectory, cwd, outside };
}

/** Directory links as junctions on Windows, which need no symlink privilege. */
const linkDirectory = (target: string, link: string) =>
  fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
const onWindows = process.platform === "win32";

async function skill(directory: string, name: string, description = `${name} skill`) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    NodePath.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody that is never read.\n`,
  );
}

describe("Antigravity skill discovery", () => {
  it("reads user, project, configured and plugin skills with native precedence", async () => {
    const { userHome, profileDirectory, cwd } = await layout();
    await skill(NodePath.join(userHome, ".gemini", "config", "skills", "review"), "review", "user");
    await skill(NodePath.join(cwd, ".gemini", "skills", "review"), "review", "project");
    await skill(NodePath.join(cwd, ".agents", "skills", "lint"), "lint");
    await skill(NodePath.join(cwd, "shared", "keep"), "keep");
    await skill(NodePath.join(cwd, "shared", "drop"), "drop");
    await fs.writeFile(
      NodePath.join(cwd, ".agents", "skills.json"),
      JSON.stringify({ entries: [{ path: "shared", exclude: ["drop"] }] }),
    );
    await skill(
      NodePath.join(profileDirectory, "config", "plugins", "on", "skills", "plug"),
      "plug",
    );
    await skill(
      NodePath.join(profileDirectory, "config", "plugins", "off", "skills", "hidden"),
      "hidden",
    );
    await fs.writeFile(
      NodePath.join(profileDirectory, "config", "config.json"),
      JSON.stringify({ plugins: { off: { enabled: false } } }),
    );

    const skills = await discoverAntigravitySkills({ cwd, userHome, profileDirectory });
    expect(skills.map(({ name, scope, description }) => ({ name, scope, description }))).toEqual([
      { name: "keep", scope: "project", description: "keep skill" },
      { name: "lint", scope: "project", description: "lint skill" },
      { name: "plug", scope: "user", description: "plug skill" },
      { name: "review", scope: "user", description: "user" },
    ]);
  });

  it("omits project roots for instance-level discovery", async () => {
    const { userHome, profileDirectory, cwd } = await layout();
    await skill(NodePath.join(cwd, ".agents", "skills", "lint"), "lint");
    expect(await discoverAntigravitySkills({ userHome, profileDirectory })).toEqual([]);
  });

  it("ignores configured paths outside the home, profile and project", async () => {
    const { userHome, profileDirectory, cwd, outside } = await layout();
    await skill(NodePath.join(outside, "escape"), "escape");
    await linkDirectory(outside, NodePath.join(cwd, "linked"));
    await fs.mkdir(NodePath.join(cwd, ".agents"), { recursive: true });
    await fs.writeFile(
      NodePath.join(cwd, ".agents", "skills.json"),
      JSON.stringify({ entries: [{ path: outside }, { path: "linked" }] }),
    );
    expect(await discoverAntigravitySkills({ cwd, userHome, profileDirectory })).toEqual([]);
  });

  // A file link needs the symlink privilege on Windows, and a junction can't point at a file.
  it.skipIf(onWindows)(
    "rechecks containment for symlinked skill folders and SKILL.md files",
    async () => {
      const { userHome, profileDirectory, cwd, outside } = await layout();
      await skill(NodePath.join(outside, "escape"), "escape");
      await skill(NodePath.join(cwd, "shared", "inside"), "inside");
      // A configured entry inside the project whose children link out of every root.
      await fs.symlink(
        NodePath.join(outside, "escape"),
        NodePath.join(cwd, "shared", "linked-dir"),
      );
      await fs.mkdir(NodePath.join(cwd, "shared", "linked-file"), { recursive: true });
      await fs.symlink(
        NodePath.join(outside, "escape", "SKILL.md"),
        NodePath.join(cwd, "shared", "linked-file", "SKILL.md"),
      );
      await fs.mkdir(NodePath.join(cwd, ".agents"), { recursive: true });
      await fs.writeFile(
        NodePath.join(cwd, ".agents", "skills.json"),
        JSON.stringify({ entries: [{ path: "shared" }] }),
      );
      const skills = await discoverAntigravitySkills({ cwd, userHome, profileDirectory });
      expect(skills.map((entry) => entry.name)).toEqual(["inside"]);
    },
  );

  it("skips one oversized or unterminated skill instead of dropping the whole scan", async () => {
    const { userHome, profileDirectory, cwd } = await layout();
    const root = NodePath.join(cwd, ".agents", "skills");
    await skill(NodePath.join(root, "a-good"), "good");
    await fs.mkdir(NodePath.join(root, "b-huge"), { recursive: true });
    await fs.writeFile(
      NodePath.join(root, "b-huge", "SKILL.md"),
      `---\nname: huge\n${"x".repeat(1_100_000)}`,
    );
    await skill(NodePath.join(root, "c-after"), "after");
    const skills = await discoverAntigravitySkills({ cwd, userHome, profileDirectory });
    expect(skills.map((entry) => entry.name)).toEqual(["after", "good"]);
  });

  it("reads only delimiter lines, so dashes inside a value do not end the frontmatter", async () => {
    const { userHome, profileDirectory, cwd } = await layout();
    const directory = NodePath.join(cwd, ".agents", "skills", "dashes");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      NodePath.join(directory, "SKILL.md"),
      `---\nname: dashes\ndescription: "Fast --- safe"\n---\nbody\n`,
    );
    const skills = await discoverAntigravitySkills({ cwd, userHome, profileDirectory });
    expect(skills).toEqual([
      expect.objectContaining({ name: "dashes", description: "Fast --- safe" }),
    ]);
  });

  it("allows names starting with two dots and filters a configured skill directory by name", async () => {
    const { userHome, profileDirectory, cwd } = await layout();
    await skill(NodePath.join(cwd, "..local", "kept"), "kept");
    await skill(NodePath.join(cwd, "shared", "skip"), "skip");
    await fs.mkdir(NodePath.join(cwd, ".agents"), { recursive: true });
    await fs.writeFile(
      NodePath.join(cwd, ".agents", "skills.json"),
      JSON.stringify({
        entries: [{ path: "..local" }, { path: "shared/skip/", exclude: ["skip"] }],
      }),
    );
    const skills = await discoverAntigravitySkills({ cwd, userHome, profileDirectory });
    expect(skills.map((entry) => entry.name)).toEqual(["kept"]);
  });

  it("does not read plugin metadata outside the allowed roots", async () => {
    const { userHome, profileDirectory, cwd, outside } = await layout();
    await skill(NodePath.join(outside, "plugins", "evil", "skills", "leak"), "leak");
    await fs.mkdir(NodePath.join(profileDirectory, "config"), { recursive: true });
    await linkDirectory(
      NodePath.join(outside, "plugins"),
      NodePath.join(profileDirectory, "config", "plugins"),
    );
    const skills = await discoverAntigravitySkills({ cwd, userHome, profileDirectory });
    expect(skills).toEqual([]);
  });

  it("stops at a closing delimiter with long padding even when the body is over the limit", async () => {
    const { userHome, profileDirectory, cwd } = await layout();
    const directory = NodePath.join(cwd, ".agents", "skills", "padded");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      NodePath.join(directory, "SKILL.md"),
      `---\nname: padded\ndescription: ok\n---${" ".repeat(40)}\t\r\n${"x".repeat(1_100_000)}`,
    );
    const skills = await discoverAntigravitySkills({ cwd, userHome, profileDirectory });
    expect(skills.map((entry) => entry.name)).toEqual(["padded"]);
  });

  it("reads SKILL.md even when an ineligible SKILL.MD sits next to it", async () => {
    const { userHome, profileDirectory, cwd } = await layout();
    const directory = NodePath.join(cwd, ".agents", "skills", "cased");
    await skill(directory, "cased");
    await fs.writeFile(NodePath.join(directory, "SKILL.MD"), "---\nname: wrong\n---\n");
    // On a case-insensitive filesystem the second write keeps the `SKILL.md` name and replaces
    // its contents, so only one file exists to read.
    const caseSensitive = (await fs.readdir(directory)).length === 2;
    const skills = await discoverAntigravitySkills({ cwd, userHome, profileDirectory });
    expect(skills.map((entry) => entry.name)).toEqual([caseSensitive ? "cased" : "wrong"]);
  });

  it("charges configured paths to the scan budget before touching the filesystem", async () => {
    const { userHome, profileDirectory, cwd } = await layout();
    await skill(NodePath.join(cwd, "shared", "late"), "late");
    await fs.mkdir(NodePath.join(cwd, ".agents"), { recursive: true });
    const missing = Array.from({ length: 10_001 }, (_, index) => ({ path: `missing-${index}` }));
    await fs.writeFile(
      NodePath.join(cwd, ".agents", "skills.json"),
      JSON.stringify({ inherits: missing, entries: [{ path: "shared" }] }),
    );
    const started = performance.now();
    const skills = await discoverAntigravitySkills({ cwd, userHome, profileDirectory });
    // The budget ran out on the inherited paths, so the entry after them is never reached.
    expect(skills).toEqual([]);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("decodes skills.json entries and filters and rejects malformed files", () => {
    expect(
      parseAntigravitySkillsConfig(
        JSON.stringify({
          inherits: [{ path: "../base.json", include_only: ["a"] }, { path: 3 }],
          entries: [{ path: "skills", exclude: ["b"], include_only: "bad" }],
        }),
      ),
    ).toEqual({
      inherits: [{ path: "../base.json", include_only: ["a"] }],
      entries: [{ path: "skills", exclude: ["b"] }],
    });
    expect(parseAntigravitySkillsConfig("{not json")).toBeUndefined();
  });
});
