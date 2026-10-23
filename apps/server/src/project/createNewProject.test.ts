import { execFileSync } from "node:child_process";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  initializeNewProject,
  projectFolderSlug,
  reserveProjectFolder,
  resolveProjectsRoot,
} from "./createNewProject.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});
async function tempDir() {
  const root = await FS.realpath(await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-new-project-")));
  roots.push(root);
  return root;
}

describe("new project from a name", () => {
  it("names the folder from the project name", () => {
    expect(projectFolderSlug("My Great App!")).toBe("my-great-app");
    expect(projectFolderSlug("  Café  Déjà vu ")).toBe("cafe-deja-vu");
    expect(projectFolderSlug("../../etc")).toBe("etc");
    expect(projectFolderSlug("日本語")).toBe("project");
    expect(projectFolderSlug(`${"a".repeat(63)} b`).length).toBeLessThanOrEqual(64);
  });

  it("keeps each profile's projects in its own folder unless one is configured", () => {
    expect(
      resolveProjectsRoot({
        setting: "",
        profileId: "default",
        isDefaultProfile: true,
        homeDir: "/h",
      }),
    ).toBe(Path.join("/h", "f5-projects"));
    expect(
      resolveProjectsRoot({
        setting: "",
        profileId: "Work",
        isDefaultProfile: false,
        homeDir: "/h",
      }),
    ).toBe(Path.join("/h", "f5-projects-work"));
    expect(
      resolveProjectsRoot({
        setting: " /srv/code ",
        profileId: "Work",
        isDefaultProfile: false,
        homeDir: "/h",
      }),
    ).toBe(Path.resolve("/srv/code"));
  });

  it("refuses a relative projects folder instead of resolving it against the backend's cwd", () => {
    expect(() =>
      resolveProjectsRoot({ setting: "projects", profileId: "default", isDefaultProfile: true }),
    ).toThrow("must be an absolute path or start with ~");
    expect(
      resolveProjectsRoot({ setting: "~/code", profileId: "default", isDefaultProfile: true }),
    ).toBe(Path.join(OS.homedir(), "code"));
  });

  it("gives a taken name the next free suffix", async () => {
    const root = Path.join(await tempDir(), "projects");
    const first = await reserveProjectFolder(root, "app");
    const [second, third] = await Promise.all([
      reserveProjectFolder(root, "app"),
      reserveProjectFolder(root, "app"),
    ]);
    expect(first).toBe(Path.join(root, "app"));
    expect([second, third].toSorted()).toEqual([
      Path.join(root, "app-2"),
      Path.join(root, "app-3"),
    ]);
  });

  it("commits the starter files", async () => {
    const folder = await reserveProjectFolder(await tempDir(), "app");
    const result = await initializeNewProject({
      folder,
      name: "App",
      authorName: "F5 Test",
      authorEmail: "f5@example.com",
    });
    expect(result.warning).toBeNull();
    expect(await FS.readFile(Path.join(folder, "README.md"), "utf8")).toBe("# App\n");
    const log = execFileSync("git", ["log", "--format=%an <%ae> %s"], { cwd: folder }).toString();
    expect(log.trim()).toBe("F5 Test <f5@example.com> Initial commit");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: folder }).toString()).toBe("");
  });

  it("removes the folder it reserved when the starter files cannot be written", async () => {
    const root = await tempDir();
    const folder = await reserveProjectFolder(root, "app");
    // An existing README fails the exclusive write, as a full disk would.
    await FS.writeFile(Path.join(folder, "README.md"), "taken");
    await expect(
      initializeNewProject({ folder, name: "App", authorName: "", authorEmail: "" }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await FS.readdir(root)).toEqual([]);
    // So the next attempt reuses the name instead of moving on to app-2.
    expect(await reserveProjectFolder(root, "app")).toBe(folder);
  });

  it("keeps the folder and warns when the first commit fails", async () => {
    const folder = await reserveProjectFolder(await tempDir(), "app");
    // A held index lock fails `git add` on any machine, whatever its Git identity.
    execFileSync("git", ["init", "-q"], { cwd: folder });
    await FS.writeFile(Path.join(folder, ".git", "index.lock"), "");
    const result = await initializeNewProject({
      folder,
      name: "App",
      authorName: "F5 Test",
      authorEmail: "f5@example.com",
    });
    expect(result.warning).toContain("first commit failed");
    expect(await FS.readFile(Path.join(folder, "README.md"), "utf8")).toBe("# App\n");
  });
});
