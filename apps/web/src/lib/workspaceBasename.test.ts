import { expect, it } from "vitest";
import { workspaceBasenameMatch } from "./workspaceBasename";
it("opens the named nested file without choosing an ambiguous neighbour", () => {
  const files = ["app/Readme.md", "app/Readme.test.md"].map((path) => ({ path, kind: "file" }));
  expect(workspaceBasenameMatch("Readme.md", files)).toBe("app/Readme.md");
  expect(workspaceBasenameMatch("README.md", files)).toBe("app/Readme.md");
  expect(
    workspaceBasenameMatch("Readme.md", [...files, { path: "other/Readme.md", kind: "file" }]),
  ).toBeNull();
  expect(workspaceBasenameMatch("Readme.md", [...files, { path: "Readme.md", kind: "file" }])).toBe(
    "Readme.md",
  );
  expect(
    workspaceBasenameMatch("directory.md", [{ path: "directory.md", kind: "directory" }]),
  ).toBeNull();
});
