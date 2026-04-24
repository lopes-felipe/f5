import type { FilesystemBrowseResult, ProjectSearchEntriesResult } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (cwd: string | null, query: string, limit: number) =>
    ["projects", "search-entries", cwd, query, limit] as const,
  filesystemBrowse: (partialPath: string, cwd: string | null) =>
    ["filesystem", "browse", partialPath, cwd] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectSearchEntriesQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.cwd, input.query, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

const DEFAULT_FILESYSTEM_BROWSE_STALE_TIME = 15_000;
const EMPTY_FILESYSTEM_BROWSE_RESULT: FilesystemBrowseResult = {
  parentPath: "",
  entries: [],
};

export function filesystemBrowseQueryOptions(input: {
  partialPath: string;
  cwd: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.filesystemBrowse(input.partialPath, input.cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.filesystem.browse({
        partialPath: input.partialPath,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.partialPath.length > 0,
    staleTime: input.staleTime ?? DEFAULT_FILESYSTEM_BROWSE_STALE_TIME,
    // Don't persist the previous directory's entries across `partialPath`
    // changes — if we did, the palette would briefly render entries from a
    // different directory, feeding both filterBrowseEntries and
    // resolvedAddProjectPath with stale data.
    placeholderData: EMPTY_FILESYSTEM_BROWSE_RESULT,
  });
}
