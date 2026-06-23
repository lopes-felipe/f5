import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./logger";
import { runProcess } from "./processRunner";

import {
  type FilesystemBrowseInput,
  type FilesystemBrowseResult,
  ProjectEntry,
  PROJECT_LIST_ENTRIES_DEFAULT_LIMIT,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";

const workspaceEntriesLogger = createLogger("workspaceEntries");

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_SEARCH_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const WORKSPACE_FFF_SEARCH_PAGE_SIZE_MULTIPLIER = 4;
const WORKSPACE_FFF_CACHE_IDLE_TTL_MS = 15 * 60_000;
const WORKSPACE_FFF_CACHE_MAX_KEYS = 4;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

interface WorkspaceIndex {
  scannedAt: number;
  maxEntries: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

interface SearchableWorkspaceEntry extends ProjectEntry {
  normalizedPath: string;
  normalizedName: string;
}

interface RankedWorkspaceEntry {
  entry: SearchableWorkspaceEntry;
  score: number;
}

const workspaceIndexCache = new Map<string, WorkspaceIndex>();
const inFlightWorkspaceIndexBuilds = new Map<string, Promise<WorkspaceIndex>>();

type FffItemType = "file" | "directory";

interface FffMixedItem {
  type: FffItemType;
  item: {
    relativePath: string;
  };
}

interface FffMixedSearchResult {
  items: FffMixedItem[];
  totalMatched: number;
}

type FffResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface FffFileFinder {
  mixedSearch: (query: string, options: { pageSize: number }) => FffResult<FffMixedSearchResult>;
  isScanning: () => boolean;
  destroy: () => void;
}

interface FffModule {
  FileFinder: {
    create: (options: {
      basePath: string;
      disableMmapCache: boolean;
      disableContentIndexing: boolean;
      aiMode: boolean;
      enableFsRootScanning: boolean;
      enableHomeDirScanning: boolean;
    }) => FffResult<FffFileFinder>;
  };
}

interface WorkspaceFffIndex {
  finder: FffFileFinder;
  lastAccessedAt: number;
}

let fffModuleLoadFailed = false;
let fffModulePromise: Promise<FffModule | null> | null = null;
let fffModuleLoader: () => Promise<FffModule> = () =>
  import("@ff-labs/fff-node") as Promise<FffModule>;

const workspaceFffIndexCache = new Map<string, Promise<WorkspaceFffIndex>>();

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function workspaceIndexBuildKey(cwd: string, maxEntries: number): string {
  return `${cwd}\u0000${maxEntries}`;
}

function clearInFlightWorkspaceIndexBuilds(cwd: string): void {
  for (const key of inFlightWorkspaceIndexBuilds.keys()) {
    if (key.startsWith(`${cwd}\u0000`)) {
      inFlightWorkspaceIndexBuilds.delete(key);
    }
  }
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return input;
  }
  return input.slice(separatorIndex + 1);
}

function toSearchableWorkspaceEntry(entry: ProjectEntry): SearchableWorkspaceEntry {
  const normalizedPath = entry.path.toLowerCase();
  return {
    ...entry,
    normalizedPath,
    normalizedName: basenameOf(normalizedPath),
  };
}

function trimTrailingDirectorySeparator(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function mapFffItemToProjectEntry(item: FffMixedItem): ProjectEntry | null {
  const normalizedPath = trimTrailingDirectorySeparator(toPosixPath(item.item.relativePath));
  if (!normalizedPath) {
    return null;
  }
  return {
    path: normalizedPath,
    kind: item.type,
    parentPath: parentPathOf(normalizedPath),
  };
}

async function loadFffModule(): Promise<FffModule | null> {
  if (!fffModulePromise) {
    fffModulePromise = fffModuleLoader().catch((cause) => {
      if (!fffModuleLoadFailed) {
        fffModuleLoadFailed = true;
        workspaceEntriesLogger.warn("Workspace typo-tolerant search is unavailable", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      return null;
    });
  }
  return fffModulePromise;
}

async function createWorkspaceFffIndex(cwd: string): Promise<WorkspaceFffIndex> {
  const fffModule = await loadFffModule();
  if (!fffModule) {
    throw new Error("Workspace typo-tolerant search module is unavailable.");
  }

  const created = fffModule.FileFinder.create({
    basePath: cwd,
    disableMmapCache: true,
    disableContentIndexing: true,
    aiMode: false,
    enableFsRootScanning: false,
    enableHomeDirScanning: false,
  });
  if (!created.ok) {
    throw new Error(created.error);
  }

  return {
    finder: created.value,
    lastAccessedAt: Date.now(),
  };
}

function destroyWorkspaceFffIndex(cwd: string): void {
  const cached = workspaceFffIndexCache.get(cwd);
  if (!cached) {
    return;
  }
  workspaceFffIndexCache.delete(cwd);
  void cached.then(
    (index) => {
      index.finder.destroy();
    },
    () => undefined,
  );
}

function pruneWorkspaceFffIndexCache(): void {
  const now = Date.now();
  for (const [cwd, cached] of workspaceFffIndexCache) {
    void cached.then(
      (index) => {
        if (now - index.lastAccessedAt > WORKSPACE_FFF_CACHE_IDLE_TTL_MS) {
          destroyWorkspaceFffIndex(cwd);
        }
      },
      () => {
        workspaceFffIndexCache.delete(cwd);
      },
    );
  }

  while (workspaceFffIndexCache.size > WORKSPACE_FFF_CACHE_MAX_KEYS) {
    const oldestKey = workspaceFffIndexCache.keys().next().value;
    if (!oldestKey) break;
    destroyWorkspaceFffIndex(oldestKey);
  }
}

async function getWorkspaceFffIndex(cwd: string): Promise<WorkspaceFffIndex> {
  pruneWorkspaceFffIndexCache();

  const cached = workspaceFffIndexCache.get(cwd);
  if (cached) {
    const index = await cached;
    index.lastAccessedAt = Date.now();
    return index;
  }

  const next = createWorkspaceFffIndex(cwd).catch((cause) => {
    workspaceFffIndexCache.delete(cwd);
    throw cause;
  });
  workspaceFffIndexCache.set(cwd, next);
  return next;
}

function normalizeQuery(input: string): string {
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function scoreEntry(entry: SearchableWorkspaceEntry, query: string): number | null {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const { normalizedPath, normalizedName } = entry;

  if (normalizedName === query) return 0;
  if (normalizedPath === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedPath.startsWith(query)) return 3;
  if (normalizedPath.includes(`/${query}`)) return 4;
  if (normalizedName.includes(query)) return 5;
  if (normalizedPath.includes(query)) return 6;

  const nameFuzzyScore = scoreSubsequenceMatch(normalizedName, query);
  if (nameFuzzyScore !== null) {
    return 100 + nameFuzzyScore;
  }

  const pathFuzzyScore = scoreSubsequenceMatch(normalizedPath, query);
  if (pathFuzzyScore !== null) {
    return 200 + pathFuzzyScore;
  }

  return null;
}

function compareRankedWorkspaceEntries(
  left: RankedWorkspaceEntry,
  right: RankedWorkspaceEntry,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.entry.path.localeCompare(right.entry.path);
}

function findInsertionIndex(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
): number {
  let low = 0;
  let high = rankedEntries.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) {
      break;
    }

    if (compareRankedWorkspaceEntries(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

function insertRankedEntry(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }

  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }

  if (insertionIndex >= limit) {
    return;
  }

  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  // If output was truncated, the final token can be partial.
  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];
  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as TOutput[];
  let nextIndex = 0;

  const workers = Array.from({ length: boundedConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  const insideWorkTree = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    allowNonZeroExit: true,
    timeoutMs: 5_000,
    maxBufferBytes: 4_096,
  }).catch(() => null);
  return Boolean(
    insideWorkTree && insideWorkTree.code === 0 && insideWorkTree.stdout.trim() === "true",
  );
}

async function filterGitIgnoredPaths(cwd: string, relativePaths: string[]): Promise<string[]> {
  if (relativePaths.length === 0) {
    return relativePaths;
  }

  const ignoredPaths = new Set<string>();
  let chunk: string[] = [];
  let chunkBytes = 0;

  const flushChunk = async (): Promise<boolean> => {
    if (chunk.length === 0) {
      return true;
    }

    const checkIgnore = await runProcess("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
      stdin: `${chunk.join("\0")}\0`,
    }).catch(() => null);
    chunk = [];
    chunkBytes = 0;

    if (!checkIgnore) {
      return false;
    }

    // git-check-ignore exits with 1 when no paths match.
    if (checkIgnore.code !== 0 && checkIgnore.code !== 1) {
      return false;
    }

    const matchedIgnoredPaths = splitNullSeparatedPaths(
      checkIgnore.stdout,
      Boolean(checkIgnore.stdoutTruncated),
    );
    for (const ignoredPath of matchedIgnoredPaths) {
      ignoredPaths.add(ignoredPath);
    }
    return true;
  };

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (
      chunk.length > 0 &&
      chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES &&
      !(await flushChunk())
    ) {
      return relativePaths;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES && !(await flushChunk())) {
      return relativePaths;
    }
  }

  if (!(await flushChunk())) {
    return relativePaths;
  }

  if (ignoredPaths.size === 0) {
    return relativePaths;
  }

  return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
}

async function buildWorkspaceIndexFromGit(
  cwd: string,
  maxEntries: number,
): Promise<WorkspaceIndex | null> {
  if (!(await isInsideGitWorkTree(cwd))) {
    return null;
  }

  const listedFiles = await runProcess(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
    },
  ).catch(() => null);
  if (!listedFiles || listedFiles.code !== 0) {
    return null;
  }

  const listedPaths = splitNullSeparatedPaths(
    listedFiles.stdout,
    Boolean(listedFiles.stdoutTruncated),
  )
    .map((entry) => toPosixPath(entry))
    .filter((entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry));
  const filePaths = await filterGitIgnoredPaths(cwd, listedPaths);

  const directorySet = new Set<string>();
  for (const filePath of filePaths) {
    for (const directoryPath of directoryAncestorsOf(filePath)) {
      if (!isPathInIgnoredDirectory(directoryPath)) {
        directorySet.add(directoryPath);
      }
    }
  }

  const directoryEntries = [...directorySet]
    .toSorted((left, right) => left.localeCompare(right))
    .map(
      (directoryPath): ProjectEntry => ({
        path: directoryPath,
        kind: "directory",
        parentPath: parentPathOf(directoryPath),
      }),
    )
    .map(toSearchableWorkspaceEntry);
  const fileEntries = [...new Set(filePaths)]
    .toSorted((left, right) => left.localeCompare(right))
    .map(
      (filePath): ProjectEntry => ({
        path: filePath,
        kind: "file",
        parentPath: parentPathOf(filePath),
      }),
    )
    .map(toSearchableWorkspaceEntry);

  const entries = [...directoryEntries, ...fileEntries];
  return {
    scannedAt: Date.now(),
    maxEntries,
    entries: entries.slice(0, maxEntries),
    truncated: Boolean(listedFiles.stdoutTruncated) || entries.length > maxEntries,
  };
}

async function buildWorkspaceIndex(cwd: string, maxEntries: number): Promise<WorkspaceIndex> {
  const gitIndexed = await buildWorkspaceIndexFromGit(cwd, maxEntries);
  if (gitIndexed) {
    return gitIndexed;
  }
  const shouldFilterWithGitIgnore = await isInsideGitWorkTree(cwd);

  let pendingDirectories: string[] = [""];
  const entries: SearchableWorkspaceEntry[] = [];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];
    const directoryEntries = await mapWithConcurrency(
      currentDirectories,
      WORKSPACE_SCAN_READDIR_CONCURRENCY,
      async (relativeDir) => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        try {
          const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
          return { relativeDir, dirents };
        } catch (error) {
          if (!relativeDir) {
            throw new Error(
              `Unable to scan workspace entries at '${cwd}': ${error instanceof Error ? error.message : "unknown error"}`,
              { cause: error },
            );
          }
          return { relativeDir, dirents: null };
        }
      },
    );

    const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
      const { relativeDir, dirents } = directoryEntry;
      if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

      dirents.sort((left, right) => left.name.localeCompare(right.name));
      const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
      for (const dirent of dirents) {
        if (!dirent.name || dirent.name === "." || dirent.name === "..") {
          continue;
        }
        if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
          continue;
        }
        if (!dirent.isDirectory() && !dirent.isFile()) {
          continue;
        }

        const relativePath = toPosixPath(
          relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
        );
        if (isPathInIgnoredDirectory(relativePath)) {
          continue;
        }
        candidates.push({ dirent, relativePath });
      }
      return candidates;
    });

    const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
      candidateEntries.map((entry) => entry.relativePath),
    );
    const allowedPathSet = shouldFilterWithGitIgnore
      ? new Set(await filterGitIgnoredPaths(cwd, candidatePaths))
      : null;

    for (const candidateEntries of candidateEntriesByDirectory) {
      for (const candidate of candidateEntries) {
        if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) {
          continue;
        }

        const entry = toSearchableWorkspaceEntry({
          path: candidate.relativePath,
          kind: candidate.dirent.isDirectory() ? "directory" : "file",
          parentPath: parentPathOf(candidate.relativePath),
        });
        entries.push(entry);

        if (candidate.dirent.isDirectory()) {
          pendingDirectories.push(candidate.relativePath);
        }

        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
      }

      if (truncated) {
        break;
      }
    }
  }

  return {
    scannedAt: Date.now(),
    maxEntries,
    entries,
    truncated,
  };
}

async function getWorkspaceIndex(cwd: string, maxEntries: number): Promise<WorkspaceIndex> {
  const cached = workspaceIndexCache.get(cwd);
  if (
    cached &&
    Date.now() - cached.scannedAt < WORKSPACE_CACHE_TTL_MS &&
    (!cached.truncated || cached.maxEntries >= maxEntries)
  ) {
    return cached;
  }

  const buildKey = workspaceIndexBuildKey(cwd, maxEntries);
  const inFlight = inFlightWorkspaceIndexBuilds.get(buildKey);
  if (inFlight) {
    return inFlight;
  }

  const nextPromise = buildWorkspaceIndex(cwd, maxEntries)
    .then((next) => {
      const current = workspaceIndexCache.get(cwd);
      if (!current || current.maxEntries <= next.maxEntries || !next.truncated) {
        workspaceIndexCache.set(cwd, next);
      }
      while (workspaceIndexCache.size > WORKSPACE_CACHE_MAX_KEYS) {
        const oldestKey = workspaceIndexCache.keys().next().value;
        if (!oldestKey) break;
        workspaceIndexCache.delete(oldestKey);
      }
      return next;
    })
    .finally(() => {
      inFlightWorkspaceIndexBuilds.delete(buildKey);
    });
  inFlightWorkspaceIndexBuilds.set(buildKey, nextPromise);
  return nextPromise;
}

export function clearWorkspaceIndexCache(
  cwd: string,
  options: { destroySearchIndex?: boolean } = {},
): void {
  workspaceIndexCache.delete(cwd);
  clearInFlightWorkspaceIndexBuilds(cwd);
  if (options.destroySearchIndex ?? true) {
    destroyWorkspaceFffIndex(cwd);
  }
}

export function setWorkspaceFffModuleLoaderForTests(
  loader: (() => Promise<FffModule>) | null,
): void {
  fffModuleLoader = loader ?? (() => import("@ff-labs/fff-node") as Promise<FffModule>);
  fffModulePromise = null;
  fffModuleLoadFailed = false;
  for (const cwd of workspaceFffIndexCache.keys()) {
    destroyWorkspaceFffIndex(cwd);
  }
}

function rankWorkspaceEntriesFromIndex(
  index: WorkspaceIndex,
  normalizedQuery: string,
  limit: number,
): ProjectSearchEntriesResult {
  const rankedEntries: RankedWorkspaceEntry[] = [];
  let matchedEntryCount = 0;

  for (const entry of index.entries) {
    const score = scoreEntry(entry, normalizedQuery);
    if (score === null) {
      continue;
    }

    matchedEntryCount += 1;
    insertRankedEntry(rankedEntries, { entry, score }, limit);
  }

  return {
    entries: rankedEntries.map((candidate) => candidate.entry),
    truncated: index.truncated || matchedEntryCount > limit,
  };
}

async function searchWorkspaceEntriesWithFff(params: {
  cwd: string;
  index: WorkspaceIndex;
  normalizedQuery: string;
  limit: number;
  existingPaths: ReadonlySet<string>;
}): Promise<ProjectSearchEntriesResult | null> {
  if (!params.normalizedQuery || params.limit <= 0) {
    return null;
  }

  const entryByPath = new Map(params.index.entries.map((entry) => [entry.path, entry]));
  const pageSize = Math.min(
    params.index.maxEntries,
    Math.max(params.limit + 1, params.limit * WORKSPACE_FFF_SEARCH_PAGE_SIZE_MULTIPLIER),
  );

  try {
    const fffIndex = await getWorkspaceFffIndex(params.cwd);
    if (fffIndex.finder.isScanning()) {
      return null;
    }
    const result = fffIndex.finder.mixedSearch(params.normalizedQuery, { pageSize });
    if (!result.ok) {
      workspaceEntriesLogger.warn("Workspace typo-tolerant search failed", {
        cwd: params.cwd,
        reason: result.error,
      });
      return null;
    }

    const entries: ProjectEntry[] = [];
    const seenPaths = new Set<string>(params.existingPaths);
    for (const item of result.value.items) {
      const fffEntry = mapFffItemToProjectEntry(item);
      if (!fffEntry || seenPaths.has(fffEntry.path)) {
        continue;
      }

      const indexedEntry = entryByPath.get(fffEntry.path);
      if (!indexedEntry || indexedEntry.kind !== fffEntry.kind) {
        continue;
      }

      seenPaths.add(indexedEntry.path);
      entries.push(indexedEntry);
      if (entries.length >= params.limit) {
        break;
      }
    }

    return {
      entries,
      truncated: params.index.truncated || result.value.totalMatched > pageSize,
    };
  } catch (cause) {
    workspaceEntriesLogger.warn("Workspace typo-tolerant search unavailable for workspace", {
      cwd: params.cwd,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

export async function listWorkspaceEntries(
  input: ProjectListEntriesInput,
): Promise<ProjectListEntriesResult> {
  const limit = input.limit ?? PROJECT_LIST_ENTRIES_DEFAULT_LIMIT;
  const index = await getWorkspaceIndex(
    input.cwd,
    Math.max(PROJECT_LIST_ENTRIES_DEFAULT_LIMIT, limit),
  );
  const sortedEntries = index.entries
    .map(
      (entry): ProjectEntry => ({
        path: entry.path,
        kind: entry.kind,
        ...(entry.parentPath ? { parentPath: entry.parentPath } : {}),
      }),
    )
    .toSorted((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.path.localeCompare(right.path);
    });

  return {
    entries: sortedEntries.slice(0, limit),
    truncated: index.truncated || sortedEntries.length > limit,
    totalEntries: sortedEntries.length,
  };
}

export async function searchWorkspaceEntries(
  input: ProjectSearchEntriesInput,
): Promise<ProjectSearchEntriesResult> {
  const index = await getWorkspaceIndex(input.cwd, WORKSPACE_SEARCH_INDEX_MAX_ENTRIES);
  const normalizedQuery = normalizeQuery(input.query);
  const limit = Math.max(0, Math.floor(input.limit));
  const rankedResult = rankWorkspaceEntriesFromIndex(index, normalizedQuery, limit);
  if (!normalizedQuery || rankedResult.entries.length > 0) {
    return rankedResult;
  }

  const fffResult = await searchWorkspaceEntriesWithFff({
    cwd: input.cwd,
    index,
    normalizedQuery,
    limit,
    existingPaths: new Set(),
  });
  if (!fffResult || fffResult.entries.length === 0) {
    return rankedResult;
  }

  return {
    entries: [...rankedResult.entries, ...fffResult.entries].slice(0, limit),
    truncated: rankedResult.truncated || fffResult.truncated,
  };
}

const FILESYSTEM_BROWSE_MAX_ENTRIES = 200;

function expandHomePath(input: string): string {
  // The palette's `isFilesystemBrowseQuery` only triggers filesystem browsing
  // when the query starts with `~/` (never just `~`), so in practice the
  // exact-`~` branch below is unreachable via the UI. It's kept as
  // defense-in-depth for direct RPC callers / future entry points that might
  // send a bare `~`, and so that this helper's behavior matches the intuition
  // of everyone reading it.
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveBrowseTarget(input: FilesystemBrowseInput): string {
  if (process.platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    throw new Error("Windows-style paths are only supported on Windows.");
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath));
  }

  if (!input.cwd) {
    throw new Error("Relative filesystem browse paths require a current project.");
  }

  return path.resolve(expandHomePath(input.cwd), input.partialPath);
}

export async function browseWorkspaceEntries(
  input: FilesystemBrowseInput,
): Promise<FilesystemBrowseResult> {
  const resolvedInputPath = resolveBrowseTarget(input);
  const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
  const endsWithSeparatorDot = /[\\/]\.$/.test(input.partialPath);
  const parentPath =
    endsWithSeparator || endsWithSeparatorDot ? resolvedInputPath : path.dirname(resolvedInputPath);
  const prefix = endsWithSeparator
    ? ""
    : endsWithSeparatorDot
      ? "."
      : path.basename(resolvedInputPath);

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(parentPath, { withFileTypes: true });
  } catch (cause) {
    // Log the detailed error server-side (includes the absolute path and errno)
    // but surface only a generic message to the client so the endpoint cannot be
    // used as a filesystem-enumeration oracle via error messages.
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    workspaceEntriesLogger.warn("Failed to browse directory", {
      parentPath,
      cause: causeMessage,
    });
    throw new Error("Unable to browse directory.", { cause });
  }

  const showHidden = prefix.startsWith(".");
  // Match the filesystem's case-sensitivity: Linux filesystems are typically
  // case-sensitive (typing `./Src` should not list `src`), while darwin and
  // win32 are typically case-insensitive at the default filesystem. This
  // heuristic isn't perfect (APFS/ext4 can be configured either way) but it
  // matches the shell behavior most users of the platform expect.
  const caseInsensitive = process.platform !== "linux";
  const normalizedPrefix = caseInsensitive ? prefix.toLowerCase() : prefix;

  const entries = dirents
    .filter(
      (dirent) =>
        dirent.isDirectory() &&
        !IGNORED_DIRECTORY_NAMES.has(dirent.name) &&
        (caseInsensitive
          ? dirent.name.toLowerCase().startsWith(normalizedPrefix)
          : dirent.name.startsWith(normalizedPrefix)) &&
        (showHidden || !dirent.name.startsWith(".")),
    )
    .map((dirent) => ({
      name: dirent.name,
      fullPath: path.join(parentPath, dirent.name),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .slice(0, FILESYSTEM_BROWSE_MAX_ENTRIES);

  return { parentPath, entries };
}
