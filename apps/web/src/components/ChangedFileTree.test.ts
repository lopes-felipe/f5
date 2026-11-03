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

it.each([false, true])(
  "keeps colliding files and folders separate regardless of input order (reversed: %s)",
  (reversed) => {
    const files = [
      { path: "office", previousPath: "old-office" },
      { path: "office/config.ts" },
      { path: "office/config.ts/note.txt" },
      { path: "office\u200b" },
    ];
    if (reversed) files.reverse();

    const rows = changedFileTreeRows(files, new Set(), false);
    expect(rows.filter((row) => row.path !== "office\u200b")).toEqual([
      { path: "office", depth: 0 },
      { path: "office/config.ts", depth: 1 },
      {
        path: "office/config.ts/note.txt",
        depth: 2,
        file: files.find((file) => file.path.endsWith("note.txt")),
      },
      {
        path: "office/config.ts",
        depth: 1,
        file: files.find((file) => file.path === "office/config.ts"),
      },
      { path: "office", depth: 0, file: files.find((file) => file.path === "office") },
    ]);
    expect(rows.find((row) => row.path === "office\u200b")?.file?.path).toBe("office\u200b");
    const collapsed = changedFileTreeRows(files, new Set(["office"]), false).filter(
      (row) => row.path !== "office\u200b",
    );
    expect(collapsed.map((row) => [row.path, Boolean(row.file)])).toEqual([
      ["office", false],
      ["office", true],
    ]);
    expect(collapsed[1]?.file?.previousPath).toBe("old-office");
    const flat = changedFileTreeRows(files, new Set(["office"]), true);
    expect(flat).toHaveLength(files.length);
    expect(flat.every((row) => row.depth === 0 && row.file)).toBe(true);
  },
);
