/**
 * Bounded, noninteractive Git primitives for upstream tracking. Every call
 * goes through `GitService` (which forces noninteractive auth and SSH batch
 * mode for network commands and kills the process at the deadline); arguments
 * are argv or stdin, never shell text.
 *
 * Ledger publication uses plumbing on a temporary index so it never touches
 * the user's working tree, index, or HEAD.
 *
 * @module upstreamPorts/git
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Schema } from "effect";

import { GitCommandError } from "../git/Errors.ts";
import type { GitServiceShape } from "../git/Services/GitService.ts";

export const NETWORK_TIMEOUT_MS = 120_000;
export const STREAM_CHUNK_TIMEOUT_MS = 120_000;
export const METADATA_TIMEOUT_MS = 30_000;
export const MAX_FILES_PER_COMMIT = 15;
export const MAX_EXCERPT_CHARS = 1_200;
export const MAX_TOPIC_PATHS = 60;

export const PATCH_EXCLUDES = [
  ":(exclude).repos",
  ":(exclude,glob)**/*.lock",
  ":(exclude)bun.lock",
  ":(exclude)pnpm-lock.yaml",
  ":(exclude,glob)**/*.test.*",
] as const;

const SAFE_DIFF_FLAGS = [
  "--diff-merges=first-parent",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
] as const;

export type CommitSource =
  | { readonly kind: "range"; readonly from: string; readonly to: string }
  | { readonly kind: "shas"; readonly shas: ReadonlyArray<string> };

export interface FirstParentCommit {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  readonly committedAt: number;
  readonly subject: string;
  readonly body: string;
}

export interface NumstatFile {
  readonly path: string;
  readonly added: number | null;
  readonly deleted: number | null;
}

export interface CommitNumstat {
  readonly files: ReadonlyArray<NumstatFile>;
  /** Every changed path (uncapped; used for revert and rule matching). */
  readonly paths: ReadonlyArray<string>;
  readonly totalFiles: number;
}

export interface TrailerCommit {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
}

export interface CommitFilesInput {
  readonly cwd: string;
  readonly branch: string;
  /** Parent of the new commit. */
  readonly parent: string;
  /** Current branch tip for the compare-and-swap, or null when the branch must not exist. */
  readonly expectedTip: string | null;
  /** Path to new contents; null deletes the path. */
  readonly files: ReadonlyMap<string, string | null>;
  readonly message: string;
  readonly sign: boolean;
}

export class UpstreamSigningError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "UpstreamSigningError";
  }
}

export interface UpstreamGit {
  readonly remoteUrl: (
    cwd: string,
    remote: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly addRemote: (
    cwd: string,
    remote: string,
    url: string,
  ) => Effect.Effect<void, GitCommandError>;
  readonly fetchBranch: (
    cwd: string,
    remote: string,
    branch: string,
  ) => Effect.Effect<void, GitCommandError>;
  readonly revParse: (cwd: string, ref: string) => Effect.Effect<string | null, GitCommandError>;
  readonly readFilesAtRef: (input: {
    readonly cwd: string;
    readonly ref: string;
    readonly pathPrefixes: ReadonlyArray<string>;
  }) => Effect.Effect<Map<string, string>, GitCommandError>;
  readonly listPathsAtRef: (
    cwd: string,
    ref: string,
  ) => Effect.Effect<Set<string>, GitCommandError>;
  readonly firstParentCommits: (input: {
    readonly cwd: string;
    readonly from: string;
    readonly to: string;
  }) => Effect.Effect<ReadonlyArray<FirstParentCommit>, GitCommandError>;
  readonly commitsBySha: (
    cwd: string,
    shas: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<FirstParentCommit>, GitCommandError>;
  readonly firstParentAncestry: (
    cwd: string,
    head: string,
  ) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
  readonly reachableSet: (cwd: string, ref: string) => Effect.Effect<Set<string>, GitCommandError>;
  readonly countFirstParent: (
    cwd: string,
    from: string,
    to: string,
  ) => Effect.Effect<number, GitCommandError>;
  readonly streamNumstat: (
    cwd: string,
    source: CommitSource,
  ) => Effect.Effect<Map<string, CommitNumstat>, GitCommandError>;
  readonly streamPatches: (
    cwd: string,
    source: CommitSource,
  ) => Effect.Effect<Map<string, string>, GitCommandError>;
  readonly topicPaths: (
    cwd: string,
    shas: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
  readonly trailerCommits: (
    cwd: string,
    ref: string,
  ) => Effect.Effect<ReadonlyArray<TrailerCommit>, GitCommandError>;
  readonly signingEnabled: (cwd: string) => Effect.Effect<boolean, GitCommandError>;
  readonly commitFilesToBranch: (
    input: CommitFilesInput,
  ) => Effect.Effect<string, GitCommandError | UpstreamSigningError>;
  readonly push: (
    cwd: string,
    remote: string,
    branch: string,
  ) => Effect.Effect<void, GitCommandError>;
  /** Deletes a local branch only while it still points at `expectedTip`. */
  readonly deleteBranch: (
    cwd: string,
    branch: string,
    expectedTip: string,
  ) => Effect.Effect<void, GitCommandError>;
}

// ── Streaming parsers (pure; exported for tests) ────────────────────────

const RECORD_SEPARATOR = "\x1e";

/** Incremental `log -z --format=%x1e%H%x00 --numstat` parser with per-commit caps. */
export class NumstatParser {
  private buffer = "";
  readonly result = new Map<string, CommitNumstat>();

  push(text: string): void {
    this.buffer += text;
    let index = this.buffer.indexOf(RECORD_SEPARATOR, 1);
    while (index > 0) {
      this.consume(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index);
      index = this.buffer.indexOf(RECORD_SEPARATOR, 1);
    }
  }

  finish(): Map<string, CommitNumstat> {
    if (this.buffer.length) this.consume(this.buffer);
    this.buffer = "";
    return this.result;
  }

  private consume(record: string): void {
    if (!record.startsWith(RECORD_SEPARATOR)) return;
    const sha = record.slice(1, 41);
    if (!/^[0-9a-f]{40}$/u.test(sha)) return;
    const tokens = record.slice(41).split("\0");
    const files: NumstatFile[] = [];
    const paths: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!.replace(/^\n+/u, "");
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(token);
      if (!match) continue;
      let file = match[3]!;
      if (file === "") {
        // Rename or copy: the next two tokens are the old and new paths.
        file = tokens[i + 2] ?? tokens[i + 1] ?? "";
        i += 2;
      }
      if (!file) continue;
      paths.push(file);
      if (files.length < MAX_FILES_PER_COMMIT)
        files.push({
          path: file,
          added: match[1] === "-" ? null : Number(match[1]),
          deleted: match[2] === "-" ? null : Number(match[2]),
        });
    }
    this.result.set(sha, { files, paths, totalFiles: paths.length });
  }
}

/** Incremental `log --format=%x1e%H -p` parser that keeps at most `cap` characters per commit. */
export class PatchExcerptParser {
  /** Null before the first record separator. */
  private sha: string | null = null;
  private excerpt = "";
  readonly result = new Map<string, string>();

  constructor(private readonly cap = MAX_EXCERPT_CHARS) {}

  push(text: string): void {
    const pieces = text.split(RECORD_SEPARATOR);
    this.append(pieces[0]!);
    for (const piece of pieces.slice(1)) {
      this.flush();
      this.sha = "";
      this.excerpt = "";
      this.append(piece);
    }
  }

  finish(): Map<string, string> {
    this.flush();
    this.sha = null;
    return this.result;
  }

  private append(segment: string): void {
    if (this.sha === null || segment.length === 0) return;
    if (this.sha.length < 40) {
      const needed = 40 - this.sha.length;
      this.sha += segment.slice(0, needed);
      segment = segment.slice(needed);
    }
    if (this.excerpt.length < this.cap)
      this.excerpt += segment.slice(0, this.cap - this.excerpt.length);
  }

  private flush(): void {
    if (this.sha && /^[0-9a-f]{40}$/u.test(this.sha))
      this.result.set(this.sha, this.excerpt.replace(/^\n+/u, "").trimEnd());
  }
}

/** Parses `%H%x1f%P%x1f%ct%x1f%s%x1f%B%x1e` records. */
export function parseCommitRecords(text: string): FirstParentCommit[] {
  return text
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n+/u, ""))
    .filter((record) => record.length >= 40)
    .map((record) => {
      const [sha, parents, committedAt, subject, ...body] = record.split("\x1f");
      return {
        sha: sha!,
        parents: (parents ?? "").split(" ").filter(Boolean),
        committedAt: Number(committedAt ?? 0),
        subject: subject ?? "",
        body: body.join("\x1f"),
      };
    });
}

/** Parses `cat-file --batch` output bytes for the requested object ids. */
export function parseCatFileBatch(
  bytes: Buffer,
  order: ReadonlyArray<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  let offset = 0;
  for (const objectId of order) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = bytes.subarray(offset, newline).toString("utf8");
    const match = /^([0-9a-f]{40}) \S+ (\d+)$/u.exec(header);
    if (!match) {
      offset = newline + 1;
      continue;
    }
    const size = Number(match[2]);
    const start = newline + 1;
    out.set(objectId, bytes.subarray(start, start + size).toString("utf8"));
    offset = start + size + 1;
  }
  return out;
}

// ── Live implementation ─────────────────────────────────────────────────

function collector() {
  const chunks: Buffer[] = [];
  return {
    onStdoutChunk: (chunk: Uint8Array) => void chunks.push(Buffer.from(chunk)),
    bytes: () => Buffer.concat(chunks),
  };
}

function textStream(push: (text: string) => void) {
  const decoder = new TextDecoder();
  return {
    onStdoutChunk: (chunk: Uint8Array) => push(decoder.decode(chunk, { stream: true })),
    end: () => push(decoder.decode()),
  };
}

const sourceArgs = (source: CommitSource) =>
  source.kind === "range"
    ? { args: ["--first-parent", `${source.from}..${source.to}`], stdin: undefined }
    : { args: ["--no-walk=unsorted", "--stdin"], stdin: `${source.shas.join("\n")}\n` };

export interface UpstreamGitTimeouts {
  readonly network: number;
  readonly stream: number;
  readonly metadata: number;
  /** `commit-tree -S`; the signing program runs inside this deadline. */
  readonly signing: number;
}

export function makeUpstreamGit(
  execute: GitServiceShape["execute"],
  overrides: Partial<UpstreamGitTimeouts> = {},
): UpstreamGit {
  const timeouts: UpstreamGitTimeouts = {
    network: NETWORK_TIMEOUT_MS,
    stream: STREAM_CHUNK_TIMEOUT_MS,
    metadata: METADATA_TIMEOUT_MS,
    signing: METADATA_TIMEOUT_MS,
    ...overrides,
  };
  const run = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options: {
      readonly timeoutMs?: number;
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly onStdoutChunk?: (chunk: Uint8Array) => void;
      readonly maxOutputBytes?: number;
    } = {},
  ) =>
    execute({
      operation: `upstreamPorts.${operation}`,
      cwd,
      args,
      timeoutMs: options.timeoutMs ?? timeouts.metadata,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
      ...(options.onStdoutChunk ? { onStdoutChunk: options.onStdoutChunk } : {}),
      ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
    });

  const remoteUrl: UpstreamGit["remoteUrl"] = (cwd, remote) =>
    run("remoteUrl", cwd, ["remote", "get-url", remote], { allowNonZeroExit: true }).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.trim() || null : null)),
    );

  const addRemote: UpstreamGit["addRemote"] = (cwd, remote, url) =>
    run("addRemote", cwd, ["remote", "add", remote, url]).pipe(
      Effect.andThen(run("addRemote", cwd, ["remote", "set-url", "--push", remote, "DISABLED"])),
      Effect.asVoid,
    );

  const fetchBranch: UpstreamGit["fetchBranch"] = (cwd, remote, branch) =>
    run(
      "fetch",
      cwd,
      [
        "fetch",
        "--no-prune",
        "--no-tags",
        remote,
        `refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
      ],
      { timeoutMs: timeouts.network },
    ).pipe(Effect.asVoid);

  const revParse: UpstreamGit["revParse"] = (cwd, ref) =>
    run("revParse", cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => (result.code === 0 ? result.stdout.trim() || null : null)));

  const listTree = (cwd: string, ref: string, prefixes: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const out = collector();
      yield* run("lsTree", cwd, ["ls-tree", "-r", "-z", "--full-tree", ref, "--", ...prefixes], {
        onStdoutChunk: out.onStdoutChunk,
      });
      return out
        .bytes()
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const tab = entry.indexOf("\t");
          const [mode, type, objectId] = entry.slice(0, tab).split(" ");
          return { mode: mode!, type: type!, objectId: objectId!, path: entry.slice(tab + 1) };
        });
    });

  const readFilesAtRef: UpstreamGit["readFilesAtRef"] = ({ cwd, ref, pathPrefixes }) =>
    Effect.gen(function* () {
      const entries = (yield* listTree(cwd, ref, pathPrefixes)).filter(
        (entry) => entry.type === "blob",
      );
      if (entries.length === 0) return new Map<string, string>();
      const out = collector();
      yield* run("catFile", cwd, ["cat-file", "--batch"], {
        stdin: `${entries.map((entry) => entry.objectId).join("\n")}\n`,
        onStdoutChunk: out.onStdoutChunk,
      });
      const blobs = parseCatFileBatch(
        out.bytes(),
        entries.map((entry) => entry.objectId),
      );
      return new Map(entries.map((entry) => [entry.path, blobs.get(entry.objectId) ?? ""]));
    });

  const listPathsAtRef: UpstreamGit["listPathsAtRef"] = (cwd, ref) =>
    Effect.gen(function* () {
      const out = collector();
      yield* run("lsTreeNames", cwd, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", ref], {
        onStdoutChunk: out.onStdoutChunk,
      });
      return new Set(out.bytes().toString("utf8").split("\0").filter(Boolean));
    });

  const COMMIT_FORMAT = "--format=%H%x1f%P%x1f%ct%x1f%s%x1f%B%x1e";

  const firstParentCommits: UpstreamGit["firstParentCommits"] = ({ cwd, from, to }) =>
    Effect.gen(function* () {
      const out = collector();
      yield* run(
        "firstParentCommits",
        cwd,
        ["log", "--first-parent", COMMIT_FORMAT, `${from}..${to}`],
        {
          timeoutMs: timeouts.stream,
          onStdoutChunk: out.onStdoutChunk,
        },
      );
      return parseCommitRecords(out.bytes().toString("utf8"));
    });

  const commitsBySha: UpstreamGit["commitsBySha"] = (cwd, shas) =>
    shas.length === 0
      ? Effect.succeed([])
      : Effect.gen(function* () {
          const out = collector();
          yield* run("commitsBySha", cwd, ["log", "--no-walk=unsorted", "--stdin", COMMIT_FORMAT], {
            timeoutMs: timeouts.stream,
            stdin: `${shas.join("\n")}\n`,
            onStdoutChunk: out.onStdoutChunk,
          });
          return parseCommitRecords(out.bytes().toString("utf8"));
        });

  const lines = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const out = collector();
      yield* run(operation, cwd, args, {
        timeoutMs: timeouts.stream,
        onStdoutChunk: out.onStdoutChunk,
      });
      return out.bytes().toString("utf8").split("\n").filter(Boolean);
    });

  const firstParentAncestry: UpstreamGit["firstParentAncestry"] = (cwd, head) =>
    lines("firstParentAncestry", cwd, ["rev-list", "--first-parent", head]);

  const reachableSet: UpstreamGit["reachableSet"] = (cwd, ref) =>
    lines("reachableSet", cwd, ["rev-list", ref]).pipe(Effect.map((shas) => new Set(shas)));

  const countFirstParent: UpstreamGit["countFirstParent"] = (cwd, from, to) =>
    run("countFirstParent", cwd, ["rev-list", "--count", "--first-parent", `${from}..${to}`], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => (result.code === 0 ? Number(result.stdout.trim()) || 0 : 0)));

  const streamNumstat: UpstreamGit["streamNumstat"] = (cwd, source) =>
    Effect.gen(function* () {
      const parser = new NumstatParser();
      const stream = textStream((text) => parser.push(text));
      const { args, stdin } = sourceArgs(source);
      yield* run(
        "numstat",
        cwd,
        ["log", ...args, ...SAFE_DIFF_FLAGS, "-z", "--format=%x1e%H%x00", "--numstat"],
        {
          timeoutMs: timeouts.stream,
          onStdoutChunk: stream.onStdoutChunk,
          ...(stdin !== undefined ? { stdin } : {}),
        },
      );
      stream.end();
      return parser.finish();
    });

  const streamPatches: UpstreamGit["streamPatches"] = (cwd, source) =>
    Effect.gen(function* () {
      const parser = new PatchExcerptParser();
      const stream = textStream((text) => parser.push(text));
      const { args, stdin } = sourceArgs(source);
      yield* run(
        "patches",
        cwd,
        [
          "log",
          ...args,
          ...SAFE_DIFF_FLAGS,
          "--format=%x1e%H",
          "-p",
          "--unified=1",
          "--",
          ".",
          ...PATCH_EXCLUDES,
        ],
        {
          timeoutMs: timeouts.stream,
          onStdoutChunk: stream.onStdoutChunk,
          ...(stdin !== undefined ? { stdin } : {}),
        },
      );
      stream.end();
      return parser.finish();
    });

  const topicPaths: UpstreamGit["topicPaths"] = (cwd, shas) =>
    shas.length === 0
      ? Effect.succeed([])
      : Effect.gen(function* () {
          const out = collector();
          yield* run(
            "topicPaths",
            cwd,
            [
              "log",
              "--no-walk=unsorted",
              "--stdin",
              "--name-only",
              "--diff-merges=first-parent",
              "--format=",
            ],
            { stdin: `${shas.join("\n")}\n`, onStdoutChunk: out.onStdoutChunk },
          );
          const unique = [...new Set(out.bytes().toString("utf8").split("\n").filter(Boolean))];
          return unique.slice(0, MAX_TOPIC_PATHS);
        });

  const trailerCommits: UpstreamGit["trailerCommits"] = (cwd, ref) =>
    Effect.gen(function* () {
      const out = collector();
      yield* run(
        "trailerCommits",
        cwd,
        ["log", ref, "--format=%H%x1f%s%x1f%B%x1e", "-E", "--grep=^Upstream-Topic: "],
        { timeoutMs: timeouts.stream, onStdoutChunk: out.onStdoutChunk },
      );
      return out
        .bytes()
        .toString("utf8")
        .split(RECORD_SEPARATOR)
        .map((record) => record.replace(/^\n+/u, ""))
        .filter((record) => record.length >= 40)
        .map((record) => {
          const [sha, subject, ...body] = record.split("\x1f");
          return { sha: sha!, subject: subject ?? "", body: body.join("\x1f") };
        });
    });

  const signingEnabled: UpstreamGit["signingEnabled"] = (cwd) =>
    run("signingConfig", cwd, ["config", "--bool", "--get", "commit.gpgsign"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"));

  const commitFilesToBranch: UpstreamGit["commitFilesToBranch"] = (input) =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "f5-upstream-index-"))),
      (directory) =>
        Effect.gen(function* () {
          const env = { GIT_INDEX_FILE: path.join(directory, "index") };
          yield* run("readTree", input.cwd, ["read-tree", input.parent], { env });
          for (const [file, contents] of [...input.files.entries()].toSorted(([a], [b]) =>
            a < b ? -1 : 1,
          )) {
            if (contents === null) {
              yield* run("updateIndex", input.cwd, ["update-index", "--force-remove", "--", file], {
                env,
              });
              continue;
            }
            const blob = (yield* run("hashObject", input.cwd, ["hash-object", "-w", "--stdin"], {
              stdin: contents,
            })).stdout.trim();
            yield* run(
              "updateIndex",
              input.cwd,
              ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`],
              { env },
            );
          }
          const tree = (yield* run("writeTree", input.cwd, ["write-tree"], { env })).stdout.trim();
          const commit = yield* run(
            "commitTree",
            input.cwd,
            [
              "commit-tree",
              tree,
              "-p",
              input.parent,
              ...(input.sign ? ["-S"] : ["--no-gpg-sign"]),
              "-F",
              "-",
            ],
            { stdin: input.message, timeoutMs: input.sign ? timeouts.signing : timeouts.metadata },
          ).pipe(
            Effect.mapError((error) =>
              input.sign || /gpg|sign/iu.test(error.detail)
                ? new UpstreamSigningError(error.detail)
                : error,
            ),
          );
          const sha = commit.stdout.trim();
          yield* run("updateRef", input.cwd, [
            "update-ref",
            `refs/heads/${input.branch}`,
            sha,
            input.expectedTip ?? "0".repeat(40),
          ]);
          return sha;
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );

  const push: UpstreamGit["push"] = (cwd, remote, branch) =>
    run("push", cwd, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`], {
      timeoutMs: timeouts.network,
    }).pipe(Effect.asVoid);

  const deleteBranch: UpstreamGit["deleteBranch"] = (cwd, branch, expectedTip) =>
    run("deleteBranch", cwd, ["update-ref", "-d", `refs/heads/${branch}`, expectedTip]).pipe(
      Effect.asVoid,
    );

  return {
    remoteUrl,
    addRemote,
    fetchBranch,
    revParse,
    readFilesAtRef,
    listPathsAtRef,
    firstParentCommits,
    commitsBySha,
    firstParentAncestry,
    reachableSet,
    countFirstParent,
    streamNumstat,
    streamPatches,
    topicPaths,
    trailerCommits,
    signingEnabled,
    commitFilesToBranch,
    push,
    deleteBranch,
  };
}

export const isGitTimeout = (error: unknown): boolean =>
  Schema.is(GitCommandError)(error) && /timed out/u.test(error.detail);
