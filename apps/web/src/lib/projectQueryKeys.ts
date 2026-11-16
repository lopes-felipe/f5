import type { ProjectId, ThreadId } from "@t3tools/contracts";

// Keep startup invalidation independent of the filesystem query implementations.
export const projectQueryKeys = {
  all: ["projects"] as const,
  listDirectories: (cwd: string | null) => ["projects", "list-directory", cwd] as const,
  listDirectory: (
    cwd: string | null,
    relativePath: string,
    includeIgnored: boolean,
    limit: number | undefined,
  ) => ["projects", "list-directory", cwd, relativePath, includeIgnored, limit ?? null] as const,
  listEntries: (cwd: string | null, limit: number | undefined) =>
    ["projects", "list-entries", cwd, limit ?? null] as const,
  searchEntries: (cwd: string | null, query: string, limit: number) =>
    ["projects", "search-entries", cwd, query, limit] as const,
  searchContents: (input: {
    projectId: ProjectId | null;
    threadId: ThreadId | null;
    query: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    useRegex: boolean;
    limit: number;
  }) =>
    [
      "projects",
      "search-contents",
      input.projectId,
      input.threadId,
      input.query,
      input.caseSensitive,
      input.wholeWord,
      input.useRegex,
      input.limit,
    ] as const,
  filesystemBrowse: (partialPath: string, cwd: string | null) =>
    ["filesystem", "browse", partialPath, cwd] as const,
};
