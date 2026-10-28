import { expect, it } from "vitest";
import { findWorkspaceBasenameFile, workspaceBasenameMatch } from "./workspaceBasename";
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
it("looks up bare file names in the workspace index only", async () => {
  const queries: string[] = [];
  const api = {
    projects: {
      searchEntries: async (input: { query: string }) => {
        queries.push(input.query);
        return { entries: [{ path: "src/main.ts", kind: "file" as const }], truncated: false };
      },
    },
  } as unknown as Parameters<typeof findWorkspaceBasenameFile>[0];

  await expect(findWorkspaceBasenameFile(api, "/repo", "main.ts")).resolves.toBe("src/main.ts");
  await expect(findWorkspaceBasenameFile(api, "/repo", "src/main.ts")).resolves.toBeNull();
  await expect(findWorkspaceBasenameFile(api, "/repo", ".")).resolves.toBeNull();
  expect(queries).toEqual(["main.ts"]);
});
