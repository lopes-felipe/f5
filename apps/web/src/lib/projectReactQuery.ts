import type {
  FilesystemBrowseResult,
  ProjectId,
  ProjectListEntriesResult,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
  ThreadId,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { ComposerPathSearchTarget } from "../composer-logic";
import { ensureNativeApi } from "~/nativeApi";
import { randomUUID } from "./utils";

import { projectQueryKeys } from "./projectQueryKeys";

export { projectQueryKeys } from "./projectQueryKeys";

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const DEFAULT_LIST_ENTRIES_STALE_TIME = 15_000;
const EMPTY_LIST_ENTRIES_RESULT: ProjectListEntriesResult = {
  entries: [],
  truncated: false,
  totalEntries: 0,
};
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectListDirectoryQueryOptions(input: {
  cwd: string | null;
  relativePath: string;
  includeIgnored: boolean;
  limit?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.listDirectory(
      input.cwd,
      input.relativePath,
      input.includeIgnored,
      input.limit,
    ),
    queryFn: () => {
      if (!input.cwd) throw new Error("Workspace directory is unavailable.");
      return ensureNativeApi().projects.listDirectory({
        cwd: input.cwd,
        relativePath: input.relativePath,
        includeIgnored: input.includeIgnored,
        ...(input.limit ? { limit: input.limit } : {}),
      });
    },
    enabled: input.cwd !== null,
    staleTime: DEFAULT_LIST_ENTRIES_STALE_TIME,
  });
}

export function projectListEntriesQueryOptions(input: {
  cwd: string | null;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.listEntries(input.cwd, input.limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entries are unavailable.");
      }
      return api.projects.listEntries({
        cwd: input.cwd,
        ...(input.limit ? { limit: input.limit } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_LIST_ENTRIES_STALE_TIME,
    placeholderData: EMPTY_LIST_ENTRIES_RESULT,
  });
}

/** Keep each result's search identity when TanStack reuses it as placeholder data. */
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
    queryFn: async (): Promise<
      ProjectSearchEntriesResult & { searchedTarget: ComposerPathSearchTarget }
    > => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      const result = await api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
      return { ...result, searchedTarget: { cwd: input.cwd, query: input.query } };
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) =>
      previous ?? {
        ...EMPTY_SEARCH_ENTRIES_RESULT,
        searchedTarget: { cwd: input.cwd, query: input.query },
      },
  });
}

const EMPTY_SEARCH_CONTENTS_RESULT: ProjectSearchContentsResult = {
  requestId: "empty",
  matches: [],
  truncated: false,
  indexedPathCount: 0,
  indexTruncated: false,
};

export function projectSearchContentsQueryOptions(input: {
  projectId: ProjectId | null;
  threadId: ThreadId | null;
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
  limit?: number;
  enabled?: boolean;
}) {
  const caseSensitive = input.caseSensitive ?? false;
  const wholeWord = input.wholeWord ?? false;
  const useRegex = input.useRegex ?? false;
  const limit = input.limit ?? 500;
  return queryOptions({
    queryKey: projectQueryKeys.searchContents({
      projectId: input.projectId,
      threadId: input.threadId,
      query: input.query,
      caseSensitive,
      wholeWord,
      useRegex,
      limit,
    }),
    queryFn: async ({ signal }) => {
      if (!input.projectId) throw new Error("Project content search is unavailable.");
      const api = ensureNativeApi();
      const requestId = randomUUID();
      const cancel = () => {
        void api.projects.cancelContentSearch({ requestId }).catch(() => undefined);
      };
      if (signal.aborted) {
        cancel();
        throw new DOMException("Project content search was cancelled.", "AbortError");
      }
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await api.projects.searchContents({
          requestId,
          projectId: input.projectId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          query: input.query,
          limit,
          caseSensitive,
          wholeWord,
          useRegex,
        });
        if (result.requestId !== requestId) {
          throw new Error("Project content search returned a stale response.");
        }
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    enabled: (input.enabled ?? true) && input.projectId !== null && input.query.trim().length > 0,
    staleTime: 5_000,
    placeholderData: EMPTY_SEARCH_CONTENTS_RESULT,
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
