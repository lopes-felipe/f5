import * as processRunner from "../processRunner.ts";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectId } from "@t3tools/contracts";
import { runProcess } from "../processRunner.ts";
import { resolveLocalCheckout } from "./localCheckout.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function base() {
  const root = await mkdtemp(path.join(tmpdir(), "f5-local-checkout-"));
  roots.push(root);
  return root;
}
async function repo(
  base: string,
  name: string,
  remote = "https://github.com/pingdotgg/t3code.git",
) {
  const cwd = path.join(base, name);
  await mkdir(cwd, { recursive: true });
  await runProcess("git", ["init", cwd]);
  await runProcess("git", ["remote", "add", "origin", remote], { cwd });
  return cwd;
}
const input = {
  repository: { owner: "pingdotgg", repo: "t3code", nameWithOwner: "pingdotgg/t3code" },
  host: "github.com",
  projects: [],
};
it("prefers an exact verified folder without registering or changing repositories", async () => {
  const directory = await base();
  const exact = await repo(directory, "t3code");
  await repo(directory, "other");
  const result = await resolveLocalCheckout({ ...input, baseDirectory: directory });
  expect(result).toHaveLength(1);
  expect(result[0]?.cwd).toBe(exact);
  expect(result[0]?.projectId).toBeNull();
  expect((await runProcess("git", ["status", "--porcelain"], { cwd: exact })).stdout).toBe("");
});
it("finds renamed clones and supports SSH and multiple remotes", async () => {
  const directory = await base();
  await repo(directory, "t3code", "https://github.com/wrong/repo.git");
  const first = await repo(directory, "renamed", "git@github.com:pingdotgg/t3code.git");
  const second = await repo(directory, "fork", "https://github.com/other/fork.git");
  await runProcess(
    "git",
    ["remote", "add", "upstream", "https://github.com/pingdotgg/t3code.git"],
    { cwd: second },
  );
  expect(
    (await resolveLocalCheckout({ ...input, baseDirectory: directory }))
      .map((item) => item.cwd)
      .sort(),
  ).toEqual([first, second].sort());
});
it("does not recurse, follow directory links, or accept a wrong host", async () => {
  const directory = await base();
  const outside = await base();
  await repo(outside, "repo");
  await symlink(
    outside,
    path.join(directory, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await repo(directory, "nested/t3code");
  await repo(directory, "t3code", "https://example.com/pingdotgg/t3code.git");
  expect(await resolveLocalCheckout({ ...input, baseDirectory: directory })).toEqual([]);
});
it("reuses a registered project and validates manually selected subdirectories", async () => {
  const directory = await base();
  const cwd = await repo(directory, "renamed");
  const sub = path.join(cwd, "src");
  await mkdir(sub);
  const projectId = ProjectId.makeUnsafe("existing");
  const projects = [{ projectId, title: "My project", workspaceRoot: cwd }];
  const result = await resolveLocalCheckout({ ...input, projects, selectedPath: sub });
  expect(result[0]?.cwd).toBe(cwd);
  expect(result[0]?.projectId).toBe(projectId);
  expect(
    (await resolveLocalCheckout({ ...input, projects, baseDirectory: "missing" }))[0]?.projectId,
  ).toBe(projectId);
});
it("handles blank roots and reports invalid selections or inaccessible roots", async () => {
  const directory = await base();
  expect(await resolveLocalCheckout(input)).toEqual([]);
  await expect(resolveLocalCheckout({ ...input, selectedPath: directory })).rejects.toThrow(
    "not a Git checkout",
  );
  await expect(
    resolveLocalCheckout({ ...input, baseDirectory: path.join(directory, "absent") }),
  ).rejects.toThrow();
});
it("resolves linked worktrees and deduplicates canonical project roots", async () => {
  const directory = await base();
  const cwd = await repo(directory, "main");
  await runProcess(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd },
  );
  const linked = path.join(directory, "t3code");
  await runProcess("git", ["worktree", "add", "-b", "linked", linked], { cwd });
  expect((await resolveLocalCheckout({ ...input, baseDirectory: directory }))[0]?.cwd).toBe(linked);
  const projectId = ProjectId.makeUnsafe("existing");
  expect(
    await resolveLocalCheckout({
      ...input,
      projects: [
        { projectId, title: "First", workspaceRoot: linked },
        { projectId, title: "Second", workspaceRoot: linked + path.sep },
      ],
    }),
  ).toHaveLength(1);
});

it("limits concurrent inspections to four", async () => {
  const directory = await base();
  for (let index = 0; index < 12; index++) await mkdir(path.join(directory, `folder${index}`));
  const original = processRunner.runProcess;
  let active = 0;
  let maximum = 0;
  const spy = vi.spyOn(processRunner, "runProcess").mockImplementation(async (...args) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await original(...args);
    } finally {
      active--;
    }
  });
  try {
    expect(await resolveLocalCheckout({ ...input, baseDirectory: directory })).toEqual([]);
    expect(maximum).toBe(4);
  } finally {
    spy.mockRestore();
  }
});
it("rechecks registered remotes rather than keeping a stale negative result", async () => {
  const directory = await base();
  const cwd = await repo(directory, "registered", "https://github.com/other/repo.git");
  const projects = [
    { projectId: ProjectId.makeUnsafe("registered"), title: "Existing", workspaceRoot: cwd },
  ];
  expect(await resolveLocalCheckout({ ...input, projects })).toEqual([]);
  await runProcess(
    "git",
    ["remote", "set-url", "origin", "https://github.com/pingdotgg/t3code.git"],
    { cwd },
  );
  expect((await resolveLocalCheckout({ ...input, projects }))[0]?.projectId).toBe("registered");
});
