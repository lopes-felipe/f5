import { expect, it } from "vitest";
import { changedFileTreeRows } from "./ChangedFileTree";
it("keeps directories, renames, and unusual literal file names navigable", () => {
  const files = [
    { path: "src/new.ts", previousPath: "old.ts" },
    { path: "README.md" },
    { path: "src/[x].ts" },
  ];
  expect(changedFileTreeRows(files, new Set(["src"]), false).map((row) => row.path)).toEqual([
    "src",
    "README.md",
  ]);
  const rows = changedFileTreeRows(files, new Set(), false);
  expect(rows.find((row) => row.path === "src/new.ts")?.file?.previousPath).toBe("old.ts");
  expect(rows.filter((row) => row.file)).toHaveLength(3);
  expect(
    changedFileTreeRows(files, new Set(["src"]), true).every((row) => row.depth === 0 && row.file),
  ).toBe(true);
});
