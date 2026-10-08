/**
 * Read-only GitHub pull request inspection through the existing credential-
 * scoped `gh api` client. Only fixed GET endpoints are reachable: there is no
 * free-form REST or GraphQL request path.
 *
 * Pull request heads, including fork heads, are read through the base
 * repository (`refs/pull/N/head` keeps them reachable), so nothing is fetched
 * into or checked out in the user's repository.
 */
import { Effect, Schema } from "effect";

import { GitHubCliError } from "../git/Errors.ts";
import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";
import { InspectionError, looksBinary, paginateLines } from "./fileInspection.ts";
import { paginateText } from "./gitInspection.ts";

const PR_FILES_PAGE_SIZE = 100;
/** GitHub's pull request files endpoint returns at most 3000 files. */
const PR_FILES_API_LIMIT = 3_000;

export interface PullRequestReference {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export function parsePullRequestReference(input: {
  readonly url?: unknown;
  readonly repository?: unknown;
  readonly number?: unknown;
  readonly host?: unknown;
}): PullRequestReference {
  if (typeof input.url === "string" && input.url.length > 0) {
    const parsed = parsePullRequestUrl(input.url);
    if (!parsed) throw new InspectionError("invalid_argument", "Invalid pull request URL.");
    return parsed;
  }
  const host = typeof input.host === "string" ? input.host.toLowerCase() : "github.com";
  if (
    typeof input.repository !== "string" ||
    !REPOSITORY_PATTERN.test(input.repository) ||
    typeof input.number !== "number" ||
    !Number.isSafeInteger(input.number) ||
    input.number <= 0 ||
    !HOST_PATTERN.test(host) ||
    host.includes("..")
  ) {
    throw new InspectionError(
      "invalid_argument",
      "Provide a pull request URL, or repository ('owner/name') and number.",
    );
  }
  return { host, repository: input.repository, number: input.number };
}

export function parsePullRequestUrl(value: string): PullRequestReference | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)(?:\/.*)?$/.exec(url.pathname);
    if (!match) return null;
    const repository = `${match[1]}/${match[2]}`;
    const host = url.hostname.toLowerCase();
    if (!REPOSITORY_PATTERN.test(repository) || !HOST_PATTERN.test(host)) return null;
    return { host, repository, number: Number(match[3]) };
  } catch {
    return null;
  }
}

function repositoryEndpoint(repository: string): string {
  return `repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
}

/** Path segments the GitHub client accepts in an endpoint. */
function contentsPath(filePath: string): string | null {
  const segments = filePath.split("/");
  if (segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || /^\.+$/.test(segment))) {
    return null;
  }
  return segments.join("/");
}

export function inspectionErrorFromGitHub(error: unknown, host: string): InspectionError {
  if (error instanceof InspectionError) return error;
  if (Schema.is(GitHubCliError)(error)) {
    switch (error.kind) {
      case "unauthenticated":
      case "binary_missing":
        return new InspectionError(
          "unauthenticated",
          `GitHub access for ${host} is not available: ${error.detail} Sign in to ${host} in F5 settings, then retry the stage.`,
        );
      case "forbidden":
        return new InspectionError(
          "forbidden",
          `The GitHub account for ${host} cannot read this repository: ${error.detail}`,
        );
      case "rate_limited":
        return new InspectionError(
          "rate_limited",
          `GitHub rate limit reached for ${host}${error.rateLimit?.resetAt ? ` (resets ${error.rateLimit.resetAt})` : ""}.`,
        );
      case "timeout":
      case "network":
        return new InspectionError("timeout", `GitHub request to ${host} failed: ${error.detail}`);
      case "not_found":
        return new InspectionError("not_found", `GitHub resource not found: ${error.detail}`);
      default:
        return new InspectionError("failed", `GitHub request failed: ${error.detail}`);
    }
  }
  return new InspectionError(
    "failed",
    error instanceof Error ? error.message : "GitHub request failed.",
  );
}

interface PullRequestRefJson {
  readonly ref: string;
  readonly sha: string;
  readonly repo: { readonly full_name: string } | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readRef(value: unknown): PullRequestRefJson {
  const record = asRecord(value);
  const repo = asRecord(record.repo);
  if (typeof record.ref !== "string" || typeof record.sha !== "string") {
    throw new InspectionError("failed", "GitHub returned an incomplete pull request.");
  }
  return {
    ref: record.ref,
    sha: record.sha,
    repo: typeof repo.full_name === "string" ? { full_name: repo.full_name } : null,
  };
}

export interface PullRequestMetadata {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: string;
  readonly draft: boolean;
  readonly author: string | null;
  readonly body: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepository: string | null;
  readonly mergeBaseSha: string;
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface PullRequestFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  /** Blob of the head version; null for deleted files. */
  readonly headBlobSha: string | null;
  /** GitHub omits patches for binary and very large files. */
  readonly patch: string | null;
}

export function makeGitHubInspection(input: {
  readonly github: GitHubCliShape;
  /** Directory used to select the signed-in account; never modified. */
  readonly cwd: string;
}) {
  const get = (
    reference: Pick<PullRequestReference, "host">,
    endpoint: string,
    query?: Readonly<Record<string, string | number | boolean>>,
  ) =>
    Effect.gen(function* () {
      const context = yield* input.github.getCredentialContext({
        cwd: input.cwd,
        host: reference.host,
      });
      const response = yield* input.github.request({
        cwd: input.cwd,
        context,
        method: "GET",
        endpoint,
        ...(query ? { query } : {}),
      });
      if (response.status === 404) {
        return yield* new InspectionError("not_found", `GitHub resource not found: ${endpoint}`);
      }
      if (response.status === 401) {
        return yield* new InspectionError(
          "unauthenticated",
          `GitHub rejected the credential for ${reference.host}. Sign in again, then retry the stage.`,
        );
      }
      if (response.status === 403 || response.status === 429) {
        return yield* new InspectionError(
          response.rateLimit.remaining === 0 || response.status === 429
            ? "rate_limited"
            : "forbidden",
          `GitHub refused ${endpoint} (HTTP ${response.status}).`,
        );
      }
      if (response.status !== 200) {
        return yield* new InspectionError(
          "failed",
          `GitHub returned HTTP ${response.status} for ${endpoint}.`,
        );
      }
      return response.body;
    }).pipe(Effect.mapError((error) => inspectionErrorFromGitHub(error, reference.host)));

  const pullRequest = (reference: PullRequestReference) =>
    Effect.gen(function* () {
      const prefix = repositoryEndpoint(reference.repository);
      const body = asRecord(yield* get(reference, `${prefix}/pulls/${reference.number}`));
      const base = readRef(body.base);
      const head = readRef(body.head);
      const comparison = asRecord(
        yield* get(reference, `${prefix}/compare/${base.sha}...${head.sha}`, { per_page: 1 }),
      );
      const mergeBase = asRecord(comparison.merge_base_commit);
      if (typeof mergeBase.sha !== "string") {
        return yield* new InspectionError("failed", "GitHub did not report a merge base.");
      }
      const user = asRecord(body.user);
      return {
        host: reference.host,
        repository: reference.repository,
        number: reference.number,
        url: typeof body.html_url === "string" ? body.html_url : "",
        title: typeof body.title === "string" ? body.title : "",
        state: body.merged === true ? "merged" : typeof body.state === "string" ? body.state : "",
        draft: body.draft === true,
        author: typeof user.login === "string" ? user.login : null,
        body: typeof body.body === "string" ? body.body : "",
        baseRef: base.ref,
        baseSha: base.sha,
        headRef: head.ref,
        headSha: head.sha,
        headRepository: head.repo?.full_name ?? null,
        mergeBaseSha: mergeBase.sha,
        changedFiles: typeof body.changed_files === "number" ? body.changed_files : 0,
        additions: typeof body.additions === "number" ? body.additions : 0,
        deletions: typeof body.deletions === "number" ? body.deletions : 0,
      } satisfies PullRequestMetadata;
    });

  const pullRequestFilesPage = (reference: PullRequestReference, page: number) =>
    Effect.gen(function* () {
      const body = yield* get(
        reference,
        `${repositoryEndpoint(reference.repository)}/pulls/${reference.number}/files`,
        { per_page: PR_FILES_PAGE_SIZE, page },
      );
      if (!Array.isArray(body)) {
        return yield* new InspectionError("failed", "GitHub returned an invalid file list.");
      }
      return body.map((entry): PullRequestFile => {
        const file = asRecord(entry);
        const status = typeof file.status === "string" ? file.status : "modified";
        return {
          path: typeof file.filename === "string" ? file.filename : "",
          previousPath: typeof file.previous_filename === "string" ? file.previous_filename : null,
          status,
          additions: typeof file.additions === "number" ? file.additions : 0,
          deletions: typeof file.deletions === "number" ? file.deletions : 0,
          headBlobSha: status !== "removed" && typeof file.sha === "string" ? file.sha : null,
          patch: typeof file.patch === "string" ? file.patch : null,
        };
      });
    });

  /** Every changed file. Fails rather than returning a partial list. */
  const allPullRequestFiles = (reference: PullRequestReference, expectedCount: number) =>
    Effect.gen(function* () {
      if (expectedCount > PR_FILES_API_LIMIT) {
        return yield* new InspectionError(
          "failed",
          `The pull request changes ${expectedCount} files; GitHub lists at most ${PR_FILES_API_LIMIT}, so the complete diff cannot be retrieved.`,
        );
      }
      const files: PullRequestFile[] = [];
      for (let page = 1; page <= Math.ceil(PR_FILES_API_LIMIT / PR_FILES_PAGE_SIZE); page += 1) {
        const entries = yield* pullRequestFilesPage(reference, page);
        files.push(...entries);
        if (entries.length < PR_FILES_PAGE_SIZE) break;
      }
      if (files.length !== expectedCount) {
        return yield* new InspectionError(
          "failed",
          `GitHub listed ${files.length} of ${expectedCount} changed files; the pull request may have changed while it was read. Retry the review.`,
        );
      }
      return files;
    });

  const decodeBase64 = (value: unknown) =>
    typeof value === "string" ? Buffer.from(value.replace(/\s+/g, ""), "base64") : null;

  /** File contents at an immutable revision of `repository`. */
  const fileAtRevision = (input: {
    readonly host: string;
    readonly repository: string;
    readonly revision: string;
    readonly path: string;
    readonly blobSha?: string | null;
    readonly startLine?: unknown;
    readonly maxLines?: unknown;
  }) =>
    Effect.gen(function* () {
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.revision)) {
        return yield* new InspectionError(
          "invalid_argument",
          "GitHub file reads require a full commit SHA.",
        );
      }
      const reference = { host: input.host };
      const prefix = repositoryEndpoint(input.repository);
      let content: Buffer | null = null;
      let blobSha = input.blobSha ?? null;
      if (!blobSha) {
        const encodedPath = contentsPath(input.path);
        if (!encodedPath) {
          return yield* new InspectionError(
            "invalid_argument",
            `GitHub cannot address '${input.path}' by path; use the review diff instead.`,
          );
        }
        const body = asRecord(
          yield* get(reference, `${prefix}/contents/${encodedPath}`, { ref: input.revision }),
        );
        if (body.type !== "file") {
          return yield* new InspectionError("not_a_file", `Not a file: ${input.path}`);
        }
        content = body.encoding === "base64" ? decodeBase64(body.content) : null;
        blobSha = typeof body.sha === "string" ? body.sha : null;
      }
      if (content === null) {
        if (!blobSha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(blobSha)) {
          return yield* new InspectionError("failed", `GitHub did not return '${input.path}'.`);
        }
        const blob = asRecord(yield* get(reference, `${prefix}/git/blobs/${blobSha}`));
        content = blob.encoding === "base64" ? decodeBase64(blob.content) : null;
        if (content === null) {
          return yield* new InspectionError("failed", `GitHub did not return '${input.path}'.`);
        }
      }
      if (looksBinary(content)) {
        return { path: input.path, revision: input.revision, binary: true };
      }
      return {
        path: input.path,
        revision: input.revision,
        binary: false,
        ...paginateLines(content.toString("utf8"), input),
      };
    });

  return {
    pullRequest,
    pullRequestFilesPage,
    allPullRequestFiles,
    fileAtRevision,
    paginateText,
  };
}

export type GitHubInspection = ReturnType<typeof makeGitHubInspection>;

/** Rebuild a reviewable unified diff from GitHub's per-file hunks. */
export function pullRequestFilePatch(file: PullRequestFile): string {
  const oldPath = JSON.stringify(`a/${file.previousPath ?? file.path}`);
  const newPath = JSON.stringify(`b/${file.path}`);
  const header = `diff --git ${oldPath} ${newPath}\n--- ${file.status === "added" ? "/dev/null" : oldPath}\n+++ ${file.status === "removed" ? "/dev/null" : newPath}\n`;
  return file.patch === null
    ? `${header}[GitHub did not provide a patch for this ${file.status} file (binary or too large). Read the file at the base and head revisions instead.]\n`
    : `${header}${file.patch}\n`;
}
