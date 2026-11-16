import { expect, it } from "vitest";
import { nonDisposablePaths } from "./worktreeDisposablePaths.ts";

it("discards nothing without patterns", () => {
  expect(nonDisposablePaths(["a.js"], [])).toEqual(["a.js"]);
});

it("matches exact files and single-segment wildcards", () => {
  const patterns = ["apps/web/public/mockServiceWorker.js", "*.log", "src/?.tmp"];
  expect(
    nonDisposablePaths(
      [
        "apps/web/public/mockServiceWorker.js",
        "debug.log",
        "logs/debug.log",
        "src/a.tmp",
        "src/ab.tmp",
      ],
      patterns,
    ),
  ).toEqual(["logs/debug.log", "src/ab.tmp"]);
});

it("crosses directories with ** and matches zero directories", () => {
  expect(
    nonDisposablePaths(
      [
        "__screenshots__/a.png",
        "apps/web/src/components/settings/__screenshots__/GithubAccountPanel.browser.tsx/",
        "apps/web/src/screens.png",
      ],
      ["**/__screenshots__/"],
    ),
  ).toEqual(["apps/web/src/screens.png"]);
  expect(nonDisposablePaths(["a/b/c.snap", "c.snap", "c.snapx"], ["**/*.snap"])).toEqual([
    "c.snapx",
  ]);
});

it("treats a trailing slash as the directory and everything under it", () => {
  expect(nonDisposablePaths(["tmp/", "tmp/a/b.txt", "tmpfile", "x/tmp/a"], ["tmp/"])).toEqual([
    "tmpfile",
    "x/tmp/a",
  ]);
});

it("discards a collapsed untracked directory only with a subtree pattern", () => {
  // `git status --untracked-files=normal` reports `src/new/` for `src/new/file.txt`.
  expect(nonDisposablePaths(["src/new/", "src/a.js"], ["src/*"])).toEqual(["src/new/"]);
  expect(nonDisposablePaths(["x.log/"], ["*.log"])).toEqual(["x.log/"]);
  expect(nonDisposablePaths(["src/new/"], ["src/**"])).toEqual([]);
  expect(nonDisposablePaths(["src/"], ["src/**"])).toEqual([]);
  expect(nonDisposablePaths(["srcx/"], ["src/**"])).toEqual(["srcx/"]);
  expect(nonDisposablePaths(["src/new/"], ["src/new/"])).toEqual([]);
});

it("escapes regular-expression characters in patterns", () => {
  expect(nonDisposablePaths(["a+b.js", "aab.js"], ["a+b.js"])).toEqual(["aab.js"]);
});
