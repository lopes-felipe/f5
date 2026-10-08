/**
 * Read-only Git inspection for workflow stages. Every invocation goes through
 * the hardened runner: no shell, no helpers, no fetches, no optional locks.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { ProcessRunResult } from "../processRunner.ts";
import { isSafeRevision, READ_ONLY_GIT_DIFF_ARGS, runReadOnlyGit } from "../git/readOnlyGit.ts";
import {
  InspectionError,
  type InspectionRoots,
  looksBinary,
  paginateLines,
  resolveInspectionPath,
} from "./fileInspection.ts";

export const TEXT_PAGE_DEFAULT_CHARS = 60_000;
export const TEXT_PAGE_MAX_CHARS = 200_000;
const GIT_TEXT_SOURCE_LIMIT_BYTES = 16 * 1024 * 1024;
const SEARCH_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const SEARCH_MAX_MATCHES = 500;
const FIND_MAX_RESULTS = 2_000;
const MATCH_TEXT_MAX_CHARS = 400;

type GitRunner = typeof runReadOnlyGit;

export interface GitInspectionOptions {
  readonly runGit?: GitRunner;
  readonly timeoutMs?: number;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export interface TextPage {
  readonly text: string;
  readonly offset: number;
  readonly totalChars: number;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
  /** The source itself was cut off before pagination; content beyond it is unavailable. */
  readonly sourceIncomplete: boolean;
}

/** Character pagination that prefers to break on a line boundary. */
export function paginateText(
  text: string,
  input: { readonly offset?: unknown; readonly maxChars?: unknown },
  sourceIncomplete = false,
): TextPage {
  const offset = clampInteger(input.offset, 0, 0, text.length);
  const maxChars = clampInteger(
    input.maxChars,
    TEXT_PAGE_DEFAULT_CHARS,
    1_000,
    TEXT_PAGE_MAX_CHARS,
  );
  let end = Math.min(text.length, offset + maxChars);
  if (end < text.length) {
    const lineBreak = text.lastIndexOf("\n", end);
    if (lineBreak > offset) end = lineBreak + 1;
  }
  return {
    text: text.slice(offset, end),
    offset,
    totalChars: text.length,
    truncated: end < text.length,
    nextOffset: end < text.length ? end : null,
    sourceIncomplete,
  };
}

function gitFailure(operation: string, result: ProcessRunResult): InspectionError {
  if (result.timedOut) return new InspectionError("timeout", `git ${operation} timed out.`);
  if (result.aborted) return new InspectionError("failed", `git ${operation} was cancelled.`);
  return new InspectionError(
    "failed",
    `git ${operation} failed: ${result.stderr.trim().slice(0, 2_000) || `exit code ${result.code}`}`,
  );
}

function requireRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || !isSafeRevision(value)) {
    throw new InspectionError("invalid_argument", `Invalid ${label} revision.`);
  }
  return value;
}

/** Repository-relative paths only; no absolute paths, parent segments, or pathspec magic. */
export function requireRelativeGitPath(value: unknown, label = "path"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new InspectionError("invalid_argument", `Invalid ${label}.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.startsWith(":") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new InspectionError("invalid_argument", `Invalid ${label}: ${value}`);
  }
  return normalized;
}

function optionalPaths(value: unknown): ReadonlyArray<string> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new InspectionError("invalid_argument", "paths must be an array of at most 64 entries.");
  }
  return value.map((entry) => requireRelativeGitPath(entry));
}

interface Repository {
  readonly cwd: string;
  readonly topLevel: string;
}

async function resolveRepository(
  roots: InspectionRoots,
  repository: unknown,
  runGit: GitRunner,
  timeoutMs: number | undefined,
): Promise<Repository> {
  const resolved = await resolveInspectionPath(
    roots,
    typeof repository === "string" && repository.length > 0 ? repository : ".",
  );
  const probe = await runGit(["rev-parse", "--show-toplevel"], {
    cwd: resolved.absolute,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (probe.code !== 0) {
    throw new InspectionError(
      "not_found",
      "The requested directory is not inside a Git repository.",
    );
  }
  const topLevel = probe.stdout.trim();
  // The repository itself must also be inside the roots (no escaping via a parent repo).
  await resolveInspectionPath(roots, topLevel);
  return { cwd: resolved.absolute, topLevel };
}

export function makeGitInspection(roots: InspectionRoots, options: GitInspectionOptions = {}) {
  const runGit: GitRunner = options.runGit ?? runReadOnlyGit;
  const timeoutMs = options.timeoutMs;
  const run = (cwd: string, args: ReadonlyArray<string>, maxStdoutBytes?: number) =>
    runGit(args, {
      cwd,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(maxStdoutBytes ? { maxStdoutBytes } : {}),
    });

  return {
    status: async (input: { readonly repository?: unknown }) => {
      const repo = await resolveRepository(roots, input.repository, runGit, timeoutMs);
      const result = await run(repo.topLevel, [
        "status",
        "--porcelain=v1",
        "--branch",
        "--untracked-files=normal",
      ]);
      if (result.code !== 0) throw gitFailure("status", result);
      return {
        repository: repo.topLevel,
        ...paginateText(result.stdout, {}, result.stdoutTruncated === true),
      };
    },

    log: async (input: {
      readonly repository?: unknown;
      readonly revision?: unknown;
      readonly path?: unknown;
      readonly offset?: unknown;
      readonly limit?: unknown;
    }) => {
      const repo = await resolveRepository(roots, input.repository, runGit, timeoutMs);
      const offset = clampInteger(input.offset, 0, 0, 1_000_000);
      const limit = clampInteger(input.limit, 30, 1, 200);
      const revision =
        input.revision === undefined ? undefined : requireRevision(input.revision, "log");
      const pathFilter = input.path === undefined ? undefined : requireRelativeGitPath(input.path);
      const result = await run(repo.topLevel, [
        "log",
        "--no-color",
        "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s",
        `--skip=${offset}`,
        `-n${limit + 1}`,
        "--end-of-options",
        ...(revision ? [revision] : []),
        "--",
        ...(pathFilter ? [pathFilter] : []),
      ]);
      if (result.code !== 0) throw gitFailure("log", result);
      const rows = result.stdout.split("\n").filter(Boolean);
      const commits = rows.slice(0, limit).map((row) => {
        const [sha, parents, author, date, subject] = row.split("\u001f");
        return {
          sha: sha ?? "",
          parents: (parents ?? "").split(" ").filter(Boolean),
          author: author ?? "",
          date: date ?? "",
          subject: subject ?? "",
        };
      });
      return {
        repository: repo.topLevel,
        commits,
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    },

    /**
     * Patch for the working tree (`staged` selects the index), a single
     * commit (`commit`), or two revisions (`base`, optional `head`).
     */
    diff: async (input: {
      readonly repository?: unknown;
      readonly commit?: unknown;
      readonly base?: unknown;
      readonly head?: unknown;
      readonly staged?: unknown;
      readonly paths?: unknown;
      readonly statOnly?: unknown;
      readonly offset?: unknown;
      readonly maxChars?: unknown;
    }) => {
      const repo = await resolveRepository(roots, input.repository, runGit, timeoutMs);
      const paths = optionalPaths(input.paths);
      const shape = input.statOnly === true ? ["--stat=200"] : ["--patch"];
      let args: string[];
      if (input.commit !== undefined) {
        const commit = requireRevision(input.commit, "commit");
        args = [
          "show",
          ...READ_ONLY_GIT_DIFF_ARGS,
          "--format=commit %H%nAuthor: %an <%ae>%nDate: %aI%n%n%B",
          ...shape,
          "--end-of-options",
          commit,
          "--",
          ...paths,
        ];
      } else {
        const base = input.base === undefined ? undefined : requireRevision(input.base, "base");
        const head = input.head === undefined ? undefined : requireRevision(input.head, "head");
        if (head && !base) {
          throw new InspectionError("invalid_argument", "head requires base.");
        }
        args = [
          "diff",
          ...READ_ONLY_GIT_DIFF_ARGS,
          ...shape,
          ...(input.staged === true ? ["--cached"] : []),
          "--end-of-options",
          ...(base ? [base] : []),
          ...(head ? [head] : []),
          "--",
          ...paths,
        ];
      }
      const result = await run(repo.topLevel, args, GIT_TEXT_SOURCE_LIMIT_BYTES);
      if (result.code !== 0) throw gitFailure(args[0]!, result);
      return {
        repository: repo.topLevel,
        ...paginateText(result.stdout, input, result.stdoutTruncated === true),
      };
    },

    /** Immutable file contents at a revision; never touches the working tree. */
    fileAtRevision: async (input: {
      readonly repository?: unknown;
      readonly revision: unknown;
      readonly path: unknown;
      readonly startLine?: unknown;
      readonly maxLines?: unknown;
    }) => {
      const repo = await resolveRepository(roots, input.repository, runGit, timeoutMs);
      const revision = requireRevision(input.revision, "file");
      const filePath = requireRelativeGitPath(input.path);
      const result = await run(
        repo.topLevel,
        ["cat-file", "blob", `${revision}:${filePath}`],
        GIT_TEXT_SOURCE_LIMIT_BYTES,
      );
      if (result.code !== 0) {
        throw new InspectionError("not_found", `No file '${filePath}' at revision '${revision}'.`);
      }
      if (looksBinary(Buffer.from(result.stdout.slice(0, 8_192)))) {
        return { repository: repo.topLevel, revision, path: filePath, binary: true };
      }
      return {
        repository: repo.topLevel,
        revision,
        path: filePath,
        binary: false,
        ...paginateLines(result.stdout, input),
        sourceIncomplete: result.stdoutTruncated === true,
      };
    },

    findFiles: async (input: {
      readonly pattern: unknown;
      readonly repository?: unknown;
      readonly offset?: unknown;
      readonly limit?: unknown;
    }) => {
      if (typeof input.pattern !== "string" || input.pattern.length === 0) {
        throw new InspectionError("invalid_argument", "pattern is required.");
      }
      const pattern = requireRelativeGitPath(input.pattern, "pattern");
      const resolved = await resolveInspectionPath(
        roots,
        typeof input.repository === "string" ? input.repository : ".",
      );
      const probe = await run(resolved.absolute, ["rev-parse", "--is-inside-work-tree"]);
      let files: string[];
      let incomplete = false;
      if (probe.code === 0 && probe.stdout.trim() === "true") {
        const result = await run(
          resolved.absolute,
          [
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            `:(glob)${pattern}`,
          ],
          SEARCH_OUTPUT_LIMIT_BYTES,
        );
        if (result.code !== 0) throw gitFailure("ls-files", result);
        incomplete = result.stdoutTruncated === true;
        files = [...new Set(result.stdout.split("\0").filter(Boolean))];
      } else {
        const walked = await walkFiles(resolved.absolute, globToRegExp(pattern), FIND_MAX_RESULTS);
        files = walked.files;
        incomplete = walked.incomplete;
      }
      files.sort();
      const offset = clampInteger(input.offset, 0, 0, files.length);
      const limit = clampInteger(input.limit, 200, 1, 1_000);
      const page = files.slice(offset, offset + limit);
      return {
        root: resolved.relative,
        files: page,
        total: files.length,
        nextOffset: offset + page.length < files.length ? offset + page.length : null,
        sourceIncomplete: incomplete,
      };
    },

    searchText: async (input: {
      readonly query: unknown;
      readonly regex?: unknown;
      readonly caseSensitive?: unknown;
      readonly paths?: unknown;
      readonly repository?: unknown;
      readonly offset?: unknown;
      readonly limit?: unknown;
    }) => {
      if (
        typeof input.query !== "string" ||
        input.query.length === 0 ||
        input.query.length > 1_000
      ) {
        throw new InspectionError("invalid_argument", "query must be 1-1000 characters.");
      }
      const resolved = await resolveInspectionPath(
        roots,
        typeof input.repository === "string" ? input.repository : ".",
      );
      const paths = optionalPaths(input.paths);
      const probe = await run(resolved.absolute, ["rev-parse", "--is-inside-work-tree"]);
      const inRepository = probe.code === 0 && probe.stdout.trim() === "true";
      const result = await run(
        resolved.absolute,
        [
          "grep",
          ...(inRepository ? ["--untracked", "--exclude-standard"] : ["--no-index"]),
          "-n",
          "-I",
          "--no-color",
          "--full-name",
          ...(input.caseSensitive === false ? ["-i"] : []),
          input.regex === true ? "-E" : "-F",
          "-e",
          input.query,
          "--",
          ...paths,
        ],
        SEARCH_OUTPUT_LIMIT_BYTES,
      );
      // `git grep` exits 1 when nothing matches.
      if (result.code !== 0 && result.code !== 1) throw gitFailure("grep", result);
      const lines = result.stdout.split("\n").filter(Boolean);
      const matches = lines.flatMap((line) => {
        const match = /^(.*?):(\d+):(.*)$/.exec(line);
        if (!match) return [];
        return [
          {
            path: match[1]!,
            line: Number(match[2]),
            text: match[3]!.slice(0, MATCH_TEXT_MAX_CHARS),
          },
        ];
      });
      const offset = clampInteger(input.offset, 0, 0, matches.length);
      const limit = clampInteger(input.limit, 100, 1, SEARCH_MAX_MATCHES);
      const page = matches.slice(offset, offset + limit);
      return {
        root: resolved.relative,
        matches: page,
        total: matches.length,
        nextOffset: offset + page.length < matches.length ? offset + page.length : null,
        sourceIncomplete: result.stdoutTruncated === true,
      };
    },
  };
}

export type GitInspection = ReturnType<typeof makeGitInspection>;

/** Minimal glob: `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const followedBySlash = pattern[index + 2] === "/";
        source += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

async function walkFiles(
  root: string,
  matcher: RegExp,
  limit: number,
): Promise<{ files: string[]; incomplete: boolean }> {
  const files: string[] = [];
  const queue = [""];
  let visited = 0;
  while (queue.length > 0) {
    const relativeDir = queue.shift()!;
    const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      visited += 1;
      if (visited > 50_000 || files.length >= limit) return { files, incomplete: true };
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      // Symlinks are not followed, so the walk cannot leave the root.
      if (entry.isDirectory()) queue.push(relative);
      else if (entry.isFile() && matcher.test(relative)) files.push(relative);
    }
  }
  return { files, incomplete: false };
}
