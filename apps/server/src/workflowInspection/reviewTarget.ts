/**
 * Review targets are resolved and captured by the host before any reviewer
 * starts. Both reviewers and every retry read the same pinned snapshot, so a
 * reviewer can never silently substitute the local checkout or another branch.
 */
import { randomUUID } from "node:crypto";

import type { CodeReviewWorkflowId, ProjectId } from "@t3tools/contracts";
import { Data, Effect, Layer, Option, ServiceMap } from "effect";

import { GitHubCli } from "../git/Services/GitHubCli.ts";
import { captureWorkspaceReviewDiff } from "../git/ReviewDiffService.ts";
import { isSafeRevision, runReadOnlyGit } from "../git/readOnlyGit.ts";
import {
  type CodeReviewTargetFile,
  type CodeReviewTargetSnapshot,
  CodeReviewTargetSnapshotRepository,
} from "../persistence/Services/CodeReviewTargetSnapshots.ts";
import { InspectionError } from "./fileInspection.ts";
import {
  makeGitHubInspection,
  parsePullRequestUrl,
  type PullRequestReference,
  pullRequestFilePatch,
} from "./githubInspection.ts";

/** Workspace diffs larger than this cannot be pinned completely. */
export const WORKSPACE_REVIEW_PATCH_LIMIT_BYTES = 8 * 1024 * 1024;

export class ReviewTargetError extends Data.TaggedError("ReviewTargetError")<{
  readonly message: string;
}> {}

export type ReviewTargetRequest =
  | { readonly kind: "pull-request"; readonly reference: PullRequestReference }
  | { readonly kind: "workspace" };

export interface OriginRepository {
  readonly host: string;
  readonly repository: string;
}

/** Parse `origin` URLs in https, ssh://, and scp-like forms. */
export function parseRemoteRepository(remoteUrl: string): OriginRepository | null {
  const trimmed = remoteUrl.trim();
  const scpLike = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scpLike) return { host: scpLike[1]!.toLowerCase(), repository: scpLike[2]! };
  try {
    const url = new URL(trimmed);
    if (!["https:", "ssh:", "git:", "http:"].includes(url.protocol)) return null;
    const match = /^\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
    return match ? { host: url.hostname.toLowerCase(), repository: match[1]! } : null;
  } catch {
    return null;
  }
}

const PULL_URL_PATTERN =
  /https:\/\/[^\s<>()[\]"'`]+?\/pull\/[1-9][0-9]*(?=[/\s<>()[\]"'`.,;:!?]|$)/g;
const SHORT_REFERENCE_PATTERN =
  /(?<![\w./-])([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#([1-9][0-9]*)\b/g;
const NUMBER_REFERENCE_PATTERN = /\b(?:PR|pull\s+request)\s*#?\s*([1-9][0-9]*)\b/gi;

/**
 * Find the pull request the instructions explicitly name. Several distinct
 * pull requests, or a bare number without an identifiable repository, are
 * ambiguous and rejected rather than guessed.
 */
export function resolveReviewTargetRequest(
  reviewPrompt: string,
  origin: OriginRepository | null,
): ReviewTargetRequest | ReviewTargetError {
  const found = new Map<string, PullRequestReference>();
  const add = (reference: PullRequestReference) =>
    found.set(
      `${reference.host}/${reference.repository}#${reference.number}`.toLowerCase(),
      reference,
    );
  for (const match of reviewPrompt.matchAll(PULL_URL_PATTERN)) {
    const reference = parsePullRequestUrl(match[0]);
    if (reference) add(reference);
  }
  for (const match of reviewPrompt.matchAll(SHORT_REFERENCE_PATTERN)) {
    add({
      host: origin?.host ?? "github.com",
      repository: match[1]!,
      number: Number(match[2]),
    });
  }
  const bareNumbers = [...reviewPrompt.matchAll(NUMBER_REFERENCE_PATTERN)]
    .map((match) => Number(match[1]))
    .filter((number) => ![...found.values()].some((reference) => reference.number === number));
  if (bareNumbers.length > 0) {
    if (!origin) {
      return new ReviewTargetError({
        message: `The review instructions name pull request #${bareNumbers[0]}, but this project's GitHub repository could not be identified from its 'origin' remote. Use the full pull request URL.`,
      });
    }
    for (const number of bareNumbers) {
      add({ host: origin.host, repository: origin.repository, number });
    }
  }
  const references = [...found.values()];
  if (references.length > 1) {
    return new ReviewTargetError({
      message: `The review instructions name several pull requests (${references
        .map((reference) => `${reference.repository}#${reference.number}`)
        .join(", ")}). Start one review per pull request.`,
    });
  }
  return references[0] ? { kind: "pull-request", reference: references[0] } : { kind: "workspace" };
}

/** Changed files from a unified diff produced with `a/` and `b/` prefixes. */
export function summarizePatchFiles(patch: string): ReadonlyArray<CodeReviewTargetFile> {
  const files: Array<{
    path: string;
    previousPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }> = [];
  let current: (typeof files)[number] | null = null;
  let inHunk = false;
  const unquote = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as string;
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line);
      const oldPath = match ? unquote(match[1]!).replace(/^a\//, "") : "";
      const newPath = match ? unquote(match[2]!).replace(/^b\//, "") : "";
      current = {
        path: newPath || oldPath,
        previousPath: oldPath && oldPath !== newPath ? oldPath : null,
        status: oldPath && oldPath !== newPath ? "renamed" : "modified",
        additions: 0,
        deletions: 0,
        binary: false,
      };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "removed";
    else if (line.startsWith("Binary files") || line === "GIT binary patch") current.binary = true;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) current.additions += 1;
    else if (inHunk && line.startsWith("-")) current.deletions += 1;
  }
  return files
    .filter((file) => file.path.length > 0)
    .map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      headBlobSha: null,
      patchAvailable: !file.binary,
    }));
}

export interface ReviewTargetServiceShape {
  /** Resolve the target named by the instructions and pin it for this workflow. */
  readonly capture: (input: {
    readonly workflowId: CodeReviewWorkflowId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly reviewPrompt: string;
    readonly comparisonRef: string | null;
  }) => Effect.Effect<CodeReviewTargetSnapshot, ReviewTargetError>;
  readonly getByWorkflowId: (
    workflowId: CodeReviewWorkflowId,
  ) => Effect.Effect<Option.Option<CodeReviewTargetSnapshot>, ReviewTargetError>;
  /** A snapshot is only readable from sessions of the project that owns it. */
  readonly getForProject: (input: {
    readonly snapshotId: string;
    readonly projectId: ProjectId;
  }) => Effect.Effect<CodeReviewTargetSnapshot, ReviewTargetError>;
}

export class ReviewTargetService extends ServiceMap.Service<
  ReviewTargetService,
  ReviewTargetServiceShape
>()("t3/workflowInspection/reviewTarget/ReviewTargetService") {}

const toReviewTargetError = (error: unknown) =>
  new ReviewTargetError({
    message:
      error instanceof InspectionError || error instanceof Error
        ? error.message
        : "The review target could not be captured.",
  });

async function readOrigin(workspaceRoot: string): Promise<OriginRepository | null> {
  const result = await runReadOnlyGit(["remote", "get-url", "origin"], { cwd: workspaceRoot });
  return result.code === 0 ? parseRemoteRepository(result.stdout) : null;
}

export const makeReviewTargetService = Effect.gen(function* () {
  const github = yield* GitHubCli;
  const repository = yield* CodeReviewTargetSnapshotRepository;

  const capturePullRequest = (input: {
    readonly workflowId: CodeReviewWorkflowId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly reference: PullRequestReference;
  }) =>
    Effect.gen(function* () {
      const inspection = makeGitHubInspection({ github, cwd: input.workspaceRoot });
      // A push between reading metadata and files would mix revisions; retry once.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = yield* inspection.pullRequest(input.reference);
        const files = yield* inspection.allPullRequestFiles(input.reference, before.changedFiles);
        const after = yield* inspection.pullRequest(input.reference);
        if (after.headSha !== before.headSha || after.baseSha !== before.baseSha) continue;
        return {
          id: randomUUID(),
          workflowId: input.workflowId,
          projectId: input.projectId,
          kind: "pull-request",
          capturedAt: new Date().toISOString(),
          pullRequest: {
            host: before.host,
            repository: before.repository,
            number: before.number,
            url: before.url,
            title: before.title,
            state: before.state,
            author: before.author,
            baseRef: before.baseRef,
            headRef: before.headRef,
            headRepository: before.headRepository,
          },
          workspaceRoot: null,
          comparisonRef: null,
          baseSha: before.baseSha,
          headSha: before.headSha,
          mergeBaseSha: before.mergeBaseSha,
          files: files.map((file) => ({
            path: file.path,
            previousPath: file.previousPath,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            headBlobSha: file.headBlobSha,
            patchAvailable: file.patch !== null,
          })),
          patch: files.map(pullRequestFilePatch).join(""),
          provenance: `GitHub pull request files API for ${before.repository}#${before.number}: head ${before.headSha} compared with merge base ${before.mergeBaseSha} (base branch '${before.baseRef}' at ${before.baseSha}).`,
        } satisfies CodeReviewTargetSnapshot;
      }
      return yield* new ReviewTargetError({
        message: `Pull request ${input.reference.repository}#${input.reference.number} kept changing while it was being captured. Start the review again once pushes settle.`,
      });
    });

  const captureWorkspace = (input: {
    readonly workflowId: CodeReviewWorkflowId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly comparisonRef: string | null;
  }) =>
    Effect.gen(function* () {
      if (input.comparisonRef !== null && !isSafeRevision(input.comparisonRef)) {
        return yield* new ReviewTargetError({
          message: `The comparison ref ${JSON.stringify(input.comparisonRef)} is not a valid Git revision.`,
        });
      }
      const captured = yield* captureWorkspaceReviewDiff({
        cwd: input.workspaceRoot,
        comparisonRef: input.comparisonRef,
        patchLimitBytes: WORKSPACE_REVIEW_PATCH_LIMIT_BYTES,
      });
      if ("kind" in captured) {
        return yield* new ReviewTargetError({
          message: `The workspace diff could not be captured: ${captured.message}`,
        });
      }
      if (captured.truncated) {
        return yield* new ReviewTargetError({
          message: `The workspace diff is incomplete (${captured.truncationReason ?? "truncated"}). Narrow the change or review it as a pull request.`,
        });
      }
      return {
        id: randomUUID(),
        workflowId: input.workflowId,
        projectId: input.projectId,
        kind: "workspace",
        capturedAt: new Date().toISOString(),
        pullRequest: null,
        workspaceRoot: input.workspaceRoot,
        comparisonRef: input.comparisonRef,
        baseSha: captured.baseCommit,
        headSha: captured.headCommit,
        mergeBaseSha: captured.baseCommit,
        files: summarizePatchFiles(captured.patch),
        patch: captured.patch,
        provenance:
          input.comparisonRef === null
            ? `git diff of the working tree (staged, unstaged, and untracked changes) against HEAD ${captured.headCommit}.`
            : `git diff of the working tree (committed, staged, unstaged, and untracked changes) against the merge base ${captured.baseCommit} of HEAD ${captured.headCommit} and '${input.comparisonRef}'.`,
      } satisfies CodeReviewTargetSnapshot;
    });

  const capture: ReviewTargetServiceShape["capture"] = (input) =>
    Effect.gen(function* () {
      const origin = yield* Effect.promise(() => readOrigin(input.workspaceRoot));
      const request = resolveReviewTargetRequest(input.reviewPrompt, origin);
      if (request instanceof ReviewTargetError) return yield* request;
      const snapshot =
        request.kind === "pull-request"
          ? yield* capturePullRequest({ ...input, reference: request.reference })
          : yield* captureWorkspace(input);
      yield* repository.upsert(snapshot);
      return snapshot;
    }).pipe(
      Effect.mapError((error) =>
        error instanceof ReviewTargetError ? error : toReviewTargetError(error),
      ),
    );

  const getByWorkflowId: ReviewTargetServiceShape["getByWorkflowId"] = (workflowId) =>
    repository.getByWorkflowId(workflowId).pipe(Effect.mapError(toReviewTargetError));

  const getForProject: ReviewTargetServiceShape["getForProject"] = (input) =>
    repository.getById(input.snapshotId).pipe(
      Effect.mapError(toReviewTargetError),
      Effect.flatMap((snapshot) =>
        Option.isSome(snapshot) && snapshot.value.projectId === input.projectId
          ? Effect.succeed(snapshot.value)
          : Effect.fail(
              new ReviewTargetError({
                message: `Review target '${input.snapshotId}' does not exist in this project.`,
              }),
            ),
      ),
    );

  return { capture, getByWorkflowId, getForProject } satisfies ReviewTargetServiceShape;
});

export const ReviewTargetServiceLive = Layer.effect(ReviewTargetService, makeReviewTargetService);
