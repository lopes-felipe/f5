/**
 * Bounded, read-only file access confined to a session's project roots.
 * Every path is resolved lexically and then by realpath, so symlinks cannot
 * reach outside the roots.
 */
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { Data } from "effect";

export type InspectionErrorCode =
  | "invalid_argument"
  | "outside_roots"
  | "not_found"
  | "not_a_file"
  | "not_a_directory"
  | "unauthenticated"
  | "forbidden"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "failed";

/** Thrown from async helpers and yielded from Effects alike. */
export class InspectionError extends Data.TaggedError("InspectionError")<{
  readonly code: InspectionErrorCode;
  readonly message: string;
}> {
  constructor(code: InspectionErrorCode, message: string) {
    super({ code, message });
  }
}

/** Failures that mean the stage cannot obtain evidence, not that the model asked badly. */
export function isStageBlockingInspectionError(error: InspectionError): boolean {
  return (
    error.code === "unauthenticated" ||
    error.code === "forbidden" ||
    error.code === "rate_limited" ||
    error.code === "timeout" ||
    error.code === "unavailable"
  );
}

export interface InspectionRoots {
  /** Canonical (realpath) roots; the first is the default for relative paths. */
  readonly roots: ReadonlyArray<string>;
}

export const FILE_READ_DEFAULT_LINES = 400;
export const FILE_READ_MAX_LINES = 2_000;
export const FILE_READ_MAX_BYTES = 256 * 1024;
const FILE_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
export const DIRECTORY_LIST_MAX_ENTRIES = 500;
const BINARY_PROBE_BYTES = 8 * 1024;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export async function canonicalRoots(candidates: ReadonlyArray<string>): Promise<InspectionRoots> {
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(path.resolve(candidate));
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch {
      // A missing worktree simply contributes no root.
    }
  }
  return { roots };
}

export interface ResolvedInspectionPath {
  readonly root: string;
  readonly absolute: string;
  /** POSIX-style path relative to `root`; "" for the root itself. */
  readonly relative: string;
}

/**
 * Resolve a model-supplied path. Relative paths resolve against the primary
 * root. The canonical target must stay inside some root.
 */
export async function resolveInspectionPath(
  roots: InspectionRoots,
  requested: string,
): Promise<ResolvedInspectionPath> {
  if (roots.roots.length === 0) {
    throw new InspectionError("unavailable", "No project workspace is available to inspect.");
  }
  if (requested.includes("\0") || requested.length > 4096) {
    throw new InspectionError("invalid_argument", "Invalid path.");
  }
  const primary = roots.roots[0]!;
  const lexical = path.resolve(primary, requested.trim() === "" ? "." : requested);
  const lexicalRoot = roots.roots.find((root) => isWithin(root, lexical));
  if (!lexicalRoot) {
    throw new InspectionError(
      "outside_roots",
      `Path is outside the project workspace: ${requested}`,
    );
  }
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch {
    throw new InspectionError("not_found", `Path not found: ${requested}`);
  }
  const root = roots.roots.find((candidate) => isWithin(candidate, canonical));
  if (!root) {
    throw new InspectionError(
      "outside_roots",
      `Path resolves outside the project workspace through a symbolic link: ${requested}`,
    );
  }
  return {
    root,
    absolute: canonical,
    relative: path.relative(root, canonical).split(path.sep).join("/"),
  };
}

export interface FileReadResult {
  readonly path: string;
  readonly binary: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly nextStartLine: number | null;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** Slice text into a numbered line window with byte and line limits. */
export function paginateLines(
  text: string,
  options: { readonly startLine?: unknown; readonly maxLines?: unknown },
): Omit<FileReadResult, "path" | "binary"> {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const totalLines = lines.length;
  const startLine = clampInteger(options.startLine, 1, 1, Math.max(1, totalLines));
  const maxLines = clampInteger(options.maxLines, FILE_READ_DEFAULT_LINES, 1, FILE_READ_MAX_LINES);
  const selected: string[] = [];
  let bytes = 0;
  let index = startLine - 1;
  for (; index < totalLines && selected.length < maxLines; index += 1) {
    const line = `${index + 1}\t${lines[index]}`;
    const lineBytes = Buffer.byteLength(line) + 1;
    if (selected.length > 0 && bytes + lineBytes > FILE_READ_MAX_BYTES) break;
    selected.push(line.length > FILE_READ_MAX_BYTES ? line.slice(0, FILE_READ_MAX_BYTES) : line);
    bytes += lineBytes;
  }
  const endLine = startLine + selected.length - 1;
  const truncated = index < totalLines;
  return {
    startLine,
    endLine,
    totalLines,
    content: selected.join("\n"),
    truncated,
    nextStartLine: truncated ? endLine + 1 : null,
  };
}

export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

export async function readInspectionFile(
  roots: InspectionRoots,
  input: { readonly path: string; readonly startLine?: unknown; readonly maxLines?: unknown },
): Promise<FileReadResult> {
  const resolved = await resolveInspectionPath(roots, input.path);
  const info = await stat(resolved.absolute);
  if (!info.isFile()) {
    throw new InspectionError("not_a_file", `Not a regular file: ${input.path}`);
  }
  const handle = await open(resolved.absolute, "r");
  try {
    const length = Math.min(info.size, FILE_SOURCE_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    if (looksBinary(buffer)) {
      return {
        path: resolved.relative,
        binary: true,
        startLine: 0,
        endLine: 0,
        totalLines: 0,
        content: "",
        truncated: false,
        nextStartLine: null,
      };
    }
    const page = paginateLines(buffer.toString("utf8"), input);
    return {
      path: resolved.relative,
      binary: false,
      ...page,
      truncated: page.truncated || info.size > FILE_SOURCE_MAX_BYTES,
    };
  } finally {
    await handle.close();
  }
}

export interface DirectoryEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
}

export interface DirectoryListResult {
  readonly path: string;
  readonly entries: ReadonlyArray<DirectoryEntry>;
  readonly total: number;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
}

export async function listInspectionDirectory(
  roots: InspectionRoots,
  input: { readonly path?: string; readonly offset?: unknown; readonly limit?: unknown },
): Promise<DirectoryListResult> {
  const resolved = await resolveInspectionPath(roots, input.path ?? ".");
  const info = await lstat(resolved.absolute);
  if (!info.isDirectory()) {
    throw new InspectionError("not_a_directory", `Not a directory: ${input.path ?? "."}`);
  }
  const dirents = (await readdir(resolved.absolute, { withFileTypes: true })).toSorted(
    (left, right) => left.name.localeCompare(right.name),
  );
  const offset = clampInteger(input.offset, 0, 0, dirents.length);
  const limit = clampInteger(input.limit, 200, 1, DIRECTORY_LIST_MAX_ENTRIES);
  const page = dirents.slice(offset, offset + limit);
  const nextOffset = offset + page.length < dirents.length ? offset + page.length : null;
  return {
    path: resolved.relative,
    entries: page.map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other",
    })),
    total: dirents.length,
    truncated: nextOffset !== null,
    nextOffset,
  };
}
