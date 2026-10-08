/**
 * Host inspection tools for read-only workflow stages, served to provider
 * sessions as a session-scoped MCP server over authenticated loopback HTTP.
 *
 * Every tool is read-only by construction: files are read through
 * root-confined paths, Git runs through the hardened runner, and GitHub is
 * reached only through fixed GET endpoints. There is no shell, no free-form
 * HTTP or GraphQL, and no write operation.
 */
import type { ProjectId, ThreadId, WorkflowTurnExecutionProfile } from "@t3tools/contracts";
import { Data, Effect, Exit, Layer, Option, ServiceMap } from "effect";

import { GitHubCli, type GitHubCliShape } from "../git/Services/GitHubCli.ts";
import type { CodeReviewTargetSnapshot } from "../persistence/Services/CodeReviewTargetSnapshots.ts";
import {
  asObject,
  chooseLocalMcpServerName,
  type LocalMcpToolDefinition,
  nextLocalMcpEnvVarName,
  nextLocalMcpToken,
  startLocalMcpHttpServer,
  toolResult,
} from "../mcp/localMcpHttp.ts";
import { WorkflowEvidenceLedger, type WorkflowEvidenceLedgerShape } from "./evidenceLedger.ts";
import {
  canonicalRoots,
  InspectionError,
  type InspectionRoots,
  isStageBlockingInspectionError,
  listInspectionDirectory,
  readInspectionFile,
} from "./fileInspection.ts";
import { makeGitInspection, paginateText } from "./gitInspection.ts";
import {
  makeGitHubInspection,
  parsePullRequestReference,
  pullRequestFilePatch,
} from "./githubInspection.ts";
import { ReviewTargetService, type ReviewTargetServiceShape } from "./reviewTarget.ts";

const MCP_ENDPOINT_PATH = "/mcp/inspect";
export const INSPECTION_MCP_SERVER_NAME = "f5_inspect";
const INSPECTION_MCP_ENV_PREFIX = "F5_INSPECT_MCP_TOKEN_";

export interface InspectionSessionScope {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly profile: WorkflowTurnExecutionProfile;
  readonly roots: InspectionRoots;
  readonly issuedAt: string;
}

/** Everything an adapter needs to attach the facade in its native configuration format. */
export interface InspectionMcpSession {
  readonly serverName: string;
  readonly url: string;
  readonly token: string;
  readonly envVarName: string;
}

export interface InspectionMcpHttpServerShape {
  readonly createSession: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | null;
    readonly profile: WorkflowTurnExecutionProfile;
    readonly roots: ReadonlyArray<string>;
    readonly existingServerNames?: ReadonlySet<string>;
  }) => Effect.Effect<InspectionMcpSession>;
  /** Revoke the thread's credential; later calls with it are rejected. */
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
}

export class InspectionMcpHttpServer extends ServiceMap.Service<
  InspectionMcpHttpServer,
  InspectionMcpHttpServerShape
>()("t3/workflowInspection/InspectionMcpHttpServer") {}

export class InspectionMcpHttpServerError extends Data.TaggedError("InspectionMcpHttpServerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const readOnlyAnnotations = (title: string) => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  title,
});

const pageProperties = {
  offset: { type: "integer", minimum: 0, description: "Item offset from a previous nextOffset." },
  limit: { type: "integer", minimum: 1, maximum: 1000 },
};
const lineWindowProperties = {
  start_line: { type: "integer", minimum: 1, description: "1-based first line. Default 1." },
  max_lines: { type: "integer", minimum: 1, maximum: 2000, description: "Default 400." },
};
const textWindowProperties = {
  offset: { type: "integer", minimum: 0, description: "Character offset from nextOffset." },
  max_chars: { type: "integer", minimum: 1000, maximum: 200000, description: "Default 60000." },
};
const repositoryProperty = {
  repository: {
    type: "string",
    description:
      "Directory inside the project that selects the Git repository. Default: workspace root.",
  },
};
const pullRequestProperties = {
  url: { type: "string", description: "Pull request URL, e.g. https://github.com/o/r/pull/1." },
  repository: { type: "string", description: "owner/name, when url is not given." },
  number: { type: "integer", minimum: 1 },
  host: { type: "string", description: "GitHub host. Default github.com." },
};

export const INSPECTION_MCP_TOOLS: ReadonlyArray<LocalMcpToolDefinition> = [
  {
    name: "read_file",
    title: "Read a project file",
    description:
      "Read a text file inside the project workspace as numbered lines. Paginate with start_line/max_lines; follow nextStartLine.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" }, ...lineWindowProperties },
    },
    annotations: readOnlyAnnotations("Read a project file"),
  },
  {
    name: "list_directory",
    title: "List a project directory",
    description: "List entries of a directory inside the project workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" }, ...pageProperties },
    },
    annotations: readOnlyAnnotations("List a project directory"),
  },
  {
    name: "find_files",
    title: "Find project files",
    description:
      "Find files by glob ('**' crosses directories), honoring .gitignore inside Git repositories.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Glob such as 'src/**/*.ts'." },
        directory: { type: "string" },
        ...pageProperties,
      },
    },
    annotations: readOnlyAnnotations("Find project files"),
  },
  {
    name: "search_text",
    title: "Search project text",
    description:
      "Search file contents (literal by default, extended regex with regex=true). Returns path, line, and text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        regex: { type: "boolean" },
        case_sensitive: { type: "boolean", description: "Default true." },
        paths: { type: "array", items: { type: "string" }, maxItems: 64 },
        directory: { type: "string" },
        ...pageProperties,
      },
    },
    annotations: readOnlyAnnotations("Search project text"),
  },
  {
    name: "git_status",
    title: "Git status",
    description: "Branch and changed-file status of a repository in the project.",
    inputSchema: { type: "object", additionalProperties: false, properties: repositoryProperty },
    annotations: readOnlyAnnotations("Git status"),
  },
  {
    name: "git_log",
    title: "Git history",
    description: "Commit history, optionally from a revision and limited to a path.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...repositoryProperty,
        revision: { type: "string" },
        path: { type: "string" },
        ...pageProperties,
      },
    },
    annotations: readOnlyAnnotations("Git history"),
  },
  {
    name: "git_diff",
    title: "Git diff",
    description:
      "Patch of the working tree (staged=true for the index), one commit (commit), or a revision range (base, optional head). stat_only returns a summary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...repositoryProperty,
        commit: { type: "string" },
        base: { type: "string" },
        head: { type: "string" },
        staged: { type: "boolean" },
        paths: { type: "array", items: { type: "string" }, maxItems: 64 },
        stat_only: { type: "boolean" },
        ...textWindowProperties,
      },
    },
    annotations: readOnlyAnnotations("Git diff"),
  },
  {
    name: "git_file_at_revision",
    title: "File at a Git revision",
    description: "Contents of a file at a commit, branch, or tag, without checking anything out.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["revision", "path"],
      properties: {
        ...repositoryProperty,
        revision: { type: "string" },
        path: { type: "string" },
        ...lineWindowProperties,
      },
    },
    annotations: readOnlyAnnotations("File at a Git revision"),
  },
  {
    name: "github_pull_request",
    title: "GitHub pull request",
    description:
      "Pull request metadata: title, state, author, description, base/head refs and SHAs, merge base, and size.",
    inputSchema: { type: "object", additionalProperties: false, properties: pullRequestProperties },
    annotations: { ...readOnlyAnnotations("GitHub pull request"), openWorldHint: true },
  },
  {
    name: "github_pull_request_files",
    title: "GitHub pull request diff",
    description:
      "One page (100 files) of a pull request's changed files with their patches. Follow nextPage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...pullRequestProperties, page: { type: "integer", minimum: 1, maximum: 30 } },
    },
    annotations: { ...readOnlyAnnotations("GitHub pull request diff"), openWorldHint: true },
  },
  {
    name: "github_file_at_revision",
    title: "GitHub file at a commit",
    description: "Contents of a file in a GitHub repository at a full commit SHA.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "revision", "path"],
      properties: {
        host: { type: "string" },
        repository: { type: "string" },
        revision: { type: "string", description: "Full 40-character commit SHA." },
        path: { type: "string" },
        ...lineWindowProperties,
      },
    },
    annotations: { ...readOnlyAnnotations("GitHub file at a commit"), openWorldHint: true },
  },
  {
    name: "review_target",
    title: "Pinned review target",
    description:
      "The review target pinned for this code review: repository, revisions, provenance, and a page of changed files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshot_id"],
      properties: { snapshot_id: { type: "string" }, ...pageProperties },
    },
    annotations: readOnlyAnnotations("Pinned review target"),
  },
  {
    name: "review_target_diff",
    title: "Pinned review diff",
    description:
      "The pinned review diff, whole or for one path, paginated by characters. Follow nextOffset until it is null.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshot_id"],
      properties: {
        snapshot_id: { type: "string" },
        path: { type: "string" },
        ...textWindowProperties,
      },
    },
    annotations: readOnlyAnnotations("Pinned review diff"),
  },
  {
    name: "review_target_file",
    title: "Pinned review file",
    description:
      "A changed file's contents on the base (merge base) or head side of the pinned review target.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshot_id", "path", "side"],
      properties: {
        snapshot_id: { type: "string" },
        path: { type: "string" },
        side: { enum: ["base", "head"] },
        ...lineWindowProperties,
      },
    },
    annotations: readOnlyAnnotations("Pinned review file"),
  },
];

const toolNames = new Set(INSPECTION_MCP_TOOLS.map((tool) => tool.name));

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key);
  if (value === undefined || value.length === 0) {
    throw new InspectionError("invalid_argument", `${key} is required.`);
  }
  return value;
}

function inspectionErrorResult(error: InspectionError): Record<string, unknown> {
  const blocking = isStageBlockingInspectionError(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: blocking
          ? `${error.message} This is an access failure, not missing data: report it instead of guessing.`
          : error.message,
      },
    ],
    structuredContent: { error: { code: error.code, message: error.message, blocking } },
  };
}

async function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const error = Exit.findErrorOption(exit);
  if (Option.isSome(error)) throw error.value;
  throw new InspectionError("failed", "Inspection failed unexpectedly.");
}

function toInspectionError(cause: unknown): InspectionError {
  if (cause instanceof InspectionError) return cause;
  if (cause && typeof cause === "object" && "_tag" in cause && "message" in cause) {
    return new InspectionError("failed", String((cause as { message: unknown }).message));
  }
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new InspectionError("not_found", cause.message);
    return new InspectionError("failed", cause.message);
  }
  return new InspectionError("failed", String(cause));
}

export function makeInspectionToolHandler(dependencies: {
  readonly github: GitHubCliShape;
  readonly reviewTargets: ReviewTargetServiceShape | null;
  readonly evidence: WorkflowEvidenceLedgerShape | null;
}) {
  const snapshotFor = async (scope: InspectionSessionScope, snapshotId: string) => {
    if (!dependencies.reviewTargets || !scope.projectId) {
      throw new InspectionError("unavailable", "No pinned review target is available here.");
    }
    return runEffect(
      dependencies.reviewTargets
        .getForProject({ snapshotId, projectId: scope.projectId })
        .pipe(Effect.mapError((error) => new InspectionError("not_found", error.message))),
    );
  };

  const reviewFileAtSide = async (
    scope: InspectionSessionScope,
    snapshot: CodeReviewTargetSnapshot,
    args: Record<string, unknown>,
  ) => {
    const path = requireString(args, "path");
    const side = args.side === "base" ? "base" : args.side === "head" ? "head" : null;
    if (!side) throw new InspectionError("invalid_argument", "side must be 'base' or 'head'.");
    const file = snapshot.files.find(
      (entry) => entry.path === path || (side === "base" && entry.previousPath === path),
    );
    if (!file) {
      throw new InspectionError(
        "not_found",
        `'${path}' is not changed by the pinned review target.`,
      );
    }
    const sidePath = side === "base" ? (file.previousPath ?? file.path) : file.path;
    if (
      (side === "base" && file.status === "added") ||
      (side === "head" && file.status === "removed")
    ) {
      throw new InspectionError("not_found", `'${path}' does not exist on the ${side} side.`);
    }
    const window = { startLine: args.start_line, maxLines: args.max_lines };
    if (snapshot.pullRequest) {
      const github = makeGitHubInspection({
        github: dependencies.github,
        cwd: scope.roots.roots[0] ?? process.cwd(),
      });
      return runEffect(
        github.fileAtRevision({
          host: snapshot.pullRequest.host,
          repository: snapshot.pullRequest.repository,
          revision: side === "base" ? snapshot.mergeBaseSha : snapshot.headSha,
          path: sidePath,
          blobSha: side === "head" ? file.headBlobSha : null,
          ...window,
        }),
      );
    }
    const workspaceRoot = snapshot.workspaceRoot;
    if (!workspaceRoot)
      throw new InspectionError("unavailable", "The pinned workspace is unknown.");
    if (side === "base") {
      const git = makeGitInspection(await canonicalRoots([workspaceRoot]));
      return git.fileAtRevision({ revision: snapshot.mergeBaseSha, path: sidePath, ...window });
    }
    // Workspace targets pin the diff; the head side is the live working tree.
    const result = await readInspectionFile(await canonicalRoots([workspaceRoot]), {
      path: sidePath,
      ...window,
    });
    return { ...result, note: "Head side of a workspace review is the current working tree." };
  };

  const handle = async (
    scope: InspectionSessionScope,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const git = makeGitInspection(scope.roots);
    const github = () =>
      makeGitHubInspection({
        github: dependencies.github,
        cwd: scope.roots.roots[0] ?? process.cwd(),
      });
    switch (name) {
      case "read_file":
        return readInspectionFile(scope.roots, {
          path: requireString(args, "path"),
          startLine: args.start_line,
          maxLines: args.max_lines,
        });
      case "list_directory":
        return listInspectionDirectory(scope.roots, {
          ...(stringArg(args, "path") !== undefined ? { path: stringArg(args, "path")! } : {}),
          offset: args.offset,
          limit: args.limit,
        });
      case "find_files":
        return git.findFiles({
          pattern: args.pattern,
          repository: args.directory,
          offset: args.offset,
          limit: args.limit,
        });
      case "search_text":
        return git.searchText({
          query: args.query,
          regex: args.regex,
          caseSensitive: args.case_sensitive,
          paths: args.paths,
          repository: args.directory,
          offset: args.offset,
          limit: args.limit,
        });
      case "git_status":
        return git.status({ repository: args.repository });
      case "git_log":
        return git.log({
          repository: args.repository,
          revision: args.revision,
          path: args.path,
          offset: args.offset,
          limit: args.limit,
        });
      case "git_diff":
        return git.diff({
          repository: args.repository,
          commit: args.commit,
          base: args.base,
          head: args.head,
          staged: args.staged,
          paths: args.paths,
          statOnly: args.stat_only,
          offset: args.offset,
          maxChars: args.max_chars,
        });
      case "git_file_at_revision":
        return git.fileAtRevision({
          repository: args.repository,
          revision: args.revision,
          path: args.path,
          startLine: args.start_line,
          maxLines: args.max_lines,
        });
      case "github_pull_request":
        return runEffect(github().pullRequest(parsePullRequestReference(args)));
      case "github_pull_request_files": {
        const reference = parsePullRequestReference(args);
        const page =
          typeof args.page === "number" && Number.isInteger(args.page) && args.page >= 1
            ? Math.min(30, args.page)
            : 1;
        const files = await runEffect(github().pullRequestFilesPage(reference, page));
        return {
          repository: reference.repository,
          number: reference.number,
          page,
          nextPage: files.length === 100 && page < 30 ? page + 1 : null,
          files: files.map((file) => ({
            path: file.path,
            previousPath: file.previousPath,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: pullRequestFilePatch(file),
          })),
        };
      }
      case "github_file_at_revision":
        return runEffect(
          github().fileAtRevision({
            host: stringArg(args, "host")?.toLowerCase() ?? "github.com",
            repository: parsePullRequestReference({
              repository: args.repository,
              number: 1,
              host: args.host,
            }).repository,
            revision: requireString(args, "revision"),
            path: requireString(args, "path"),
            startLine: args.start_line,
            maxLines: args.max_lines,
          }),
        );
      case "review_target": {
        const snapshot = await snapshotFor(scope, requireString(args, "snapshot_id"));
        const offset = typeof args.offset === "number" ? Math.max(0, Math.floor(args.offset)) : 0;
        const limit =
          typeof args.limit === "number"
            ? Math.min(1000, Math.max(1, Math.floor(args.limit)))
            : 300;
        const files = snapshot.files.slice(offset, offset + limit);
        return {
          snapshotId: snapshot.id,
          kind: snapshot.kind,
          capturedAt: snapshot.capturedAt,
          pullRequest: snapshot.pullRequest,
          workspaceRoot: snapshot.workspaceRoot,
          comparisonRef: snapshot.comparisonRef,
          baseSha: snapshot.baseSha,
          headSha: snapshot.headSha,
          mergeBaseSha: snapshot.mergeBaseSha,
          provenance: snapshot.provenance,
          totalFiles: snapshot.files.length,
          patchChars: snapshot.patch.length,
          files,
          nextOffset: offset + files.length < snapshot.files.length ? offset + files.length : null,
        };
      }
      case "review_target_diff": {
        const snapshot = await snapshotFor(scope, requireString(args, "snapshot_id"));
        const path = stringArg(args, "path");
        const patch =
          path === undefined
            ? snapshot.patch
            : (extractFilePatch(snapshot.patch, path) ??
              (() => {
                throw new InspectionError(
                  "not_found",
                  `'${path}' is not changed by the pinned review target.`,
                );
              })());
        return {
          snapshotId: snapshot.id,
          ...(path !== undefined ? { path } : {}),
          ...paginateText(patch, { offset: args.offset, maxChars: args.max_chars }),
        };
      }
      case "review_target_file": {
        const snapshot = await snapshotFor(scope, requireString(args, "snapshot_id"));
        return reviewFileAtSide(scope, snapshot, args);
      }
      default:
        throw new InspectionError("invalid_argument", `Unknown inspection tool: ${name}`);
    }
  };

  return async (
    scope: InspectionSessionScope,
    name: string,
    rawArguments: unknown,
  ): Promise<Record<string, unknown>> => {
    if (!toolNames.has(name)) {
      return inspectionErrorResult(
        new InspectionError("invalid_argument", `Unknown inspection tool: ${name}`),
      );
    }
    const args = asObject(rawArguments);
    const evidenceKey = name.startsWith("review_target")
      ? `${name}:${String(args.snapshot_id)}:${String(args.path ?? "")}:${String(args.side ?? "")}`
      : null;
    try {
      const result = await handle(scope, name, args);
      if (evidenceKey && dependencies.evidence) {
        await Effect.runPromise(
          dependencies.evidence.recordSuccess({ threadId: scope.threadId, key: evidenceKey }),
        );
      }
      return toolResult(result);
    } catch (cause) {
      const error = toInspectionError(cause);
      if (evidenceKey && dependencies.evidence && isStageBlockingInspectionError(error)) {
        await Effect.runPromise(
          dependencies.evidence.recordFailure({
            threadId: scope.threadId,
            key: evidenceKey,
            message: error.message,
          }),
        );
      }
      return inspectionErrorResult(error);
    }
  };
}

/** The section of a unified diff for one path (new or previous name). */
export function extractFilePatch(patch: string, filePath: string): string | null {
  const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
  for (let index = 0; index < starts.length; index += 1) {
    const section = patch.slice(starts[index], starts[index + 1] ?? patch.length);
    const header = section.slice(0, section.indexOf("\n"));
    if (
      header.includes(`a/${filePath} `) ||
      header.endsWith(` b/${filePath}`) ||
      header.includes(JSON.stringify(`a/${filePath}`)) ||
      header.includes(JSON.stringify(`b/${filePath}`))
    ) {
      return section;
    }
  }
  return null;
}

export const makeInspectionMcpHttpServer = Effect.gen(function* () {
  const github = yield* GitHubCli;
  const reviewTargets = yield* Effect.serviceOption(ReviewTargetService);
  const evidence = yield* Effect.serviceOption(WorkflowEvidenceLedger);
  const sessionsByToken = new Map<string, InspectionSessionScope>();
  const tokenByThread = new Map<ThreadId, string>();
  const callTool = makeInspectionToolHandler({
    github,
    reviewTargets: Option.getOrNull(reviewTargets),
    evidence: Option.getOrNull(evidence),
  });

  const handle = yield* Effect.tryPromise({
    try: () =>
      startLocalMcpHttpServer({
        endpointPath: MCP_ENDPOINT_PATH,
        serverInfo: { name: "F5 Inspection", version: "1.0.0" },
        tools: INSPECTION_MCP_TOOLS,
        isValidToken: (token) => sessionsByToken.has(token),
        callTool: async (token, name, rawArguments) => {
          const scope = sessionsByToken.get(token);
          return scope
            ? callTool(scope, name, rawArguments)
            : inspectionErrorResult(
                new InspectionError("unauthenticated", "MCP credential is no longer valid."),
              );
        },
      }),
    catch: (cause) =>
      new InspectionMcpHttpServerError({
        message: cause instanceof Error ? cause.message : "Failed to start inspection MCP server.",
        cause,
      }),
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => handle.close()));

  const revoke = (threadId: ThreadId) => {
    const token = tokenByThread.get(threadId);
    if (token) sessionsByToken.delete(token);
    tokenByThread.delete(threadId);
  };

  return {
    createSession: (input) =>
      Effect.promise(() => canonicalRoots(input.roots)).pipe(
        Effect.map((roots) => {
          revoke(input.threadId);
          const token = nextLocalMcpToken();
          sessionsByToken.set(token, {
            threadId: input.threadId,
            projectId: input.projectId,
            profile: input.profile,
            roots,
            issuedAt: new Date().toISOString(),
          });
          tokenByThread.set(input.threadId, token);
          return {
            serverName: chooseLocalMcpServerName(
              INSPECTION_MCP_SERVER_NAME,
              input.existingServerNames,
            ),
            url: handle.url,
            token,
            envVarName: nextLocalMcpEnvVarName(INSPECTION_MCP_ENV_PREFIX),
          } satisfies InspectionMcpSession;
        }),
      ),
    revokeThread: (threadId) => Effect.sync(() => revoke(threadId)),
  } satisfies InspectionMcpHttpServerShape;
});

export const InspectionMcpHttpServerLive = Layer.effect(
  InspectionMcpHttpServer,
  makeInspectionMcpHttpServer,
);
