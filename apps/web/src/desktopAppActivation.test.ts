import { expect, it } from "vitest";
import { findActivationProject } from "./desktopAppActivation";
it("reuses canonical projects and Windows checkout spellings", () => {
  const project = { cwd: "C:\\Work\\Repo", name: "repo" };
  expect(findActivationProject([project], "c:/work/repo/")).toBe(project);
  const symlink = { cwd: "/linked/repo" };
  expect(
    findActivationProject([symlink], "/real/repo", (path) => path.replace("/linked/", "/real/")),
  ).toBe(symlink);
});
it("does not confuse sibling paths or project names", () => {
  expect(findActivationProject([{ cwd: "/a/repo" }], "/a/repository")).toBeUndefined();
});
