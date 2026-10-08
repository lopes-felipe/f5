import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { CodeReviewWorkflowId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitHubCli, type GitHubCliShape } from "../git/Services/GitHubCli.ts";
import {
  type CodeReviewTargetSnapshot,
  CodeReviewTargetSnapshotRepository,
} from "../persistence/Services/CodeReviewTargetSnapshots.ts";
import { makeWorkflowEvidenceLedger } from "./evidenceLedger.ts";
import {
  parseRemoteRepository,
  resolveReviewTargetRequest,
  ReviewTargetError,
  ReviewTargetService,
  ReviewTargetServiceLive,
  summarizePatchFiles,
} from "./reviewTarget.ts";

const origin = { host: "github.com", repository: "acme/app" };

describe("review target resolution", () => {
  it("resolves pull request URLs, owner/repo#N, and PR numbers", () => {
    expect(
      resolveReviewTargetRequest("Review https://github.com/acme/app/pull/12 please", null),
    ).toEqual({
      kind: "pull-request",
      reference: { host: "github.com", repository: "acme/app", number: 12 },
    });
    expect(resolveReviewTargetRequest("check acme/app#7", null)).toMatchObject({
      kind: "pull-request",
      reference: { repository: "acme/app", number: 7 },
    });
    expect(resolveReviewTargetRequest("Review PR #9", origin)).toMatchObject({
      kind: "pull-request",
      reference: { repository: "acme/app", number: 9 },
    });
    expect(resolveReviewTargetRequest("Review my local changes", origin)).toEqual({
      kind: "workspace",
    });
  });

  it("treats the same pull request named twice as one target", () => {
    expect(
      resolveReviewTargetRequest("https://github.com/acme/app/pull/12 (acme/app#12)", origin),
    ).toMatchObject({ kind: "pull-request", reference: { number: 12 } });
  });

  it("rejects ambiguous targets instead of guessing", () => {
    expect(resolveReviewTargetRequest("Compare acme/app#1 and acme/app#2", origin)).toBeInstanceOf(
      ReviewTargetError,
    );
    expect(resolveReviewTargetRequest("Review PR #9", null)).toBeInstanceOf(ReviewTargetError);
  });

  it("parses origin remotes in https, ssh, and scp forms", () => {
    expect(parseRemoteRepository("git@github.com:acme/app.git")).toEqual(origin);
    expect(parseRemoteRepository("https://github.com/acme/app.git")).toEqual(origin);
    expect(parseRemoteRepository("ssh://git@github.com/acme/app")).toEqual(origin);
    expect(parseRemoteRepository("file:///tmp/repo")).toBeNull();
  });

  it("summarizes changed files from a unified diff", () => {
    const files = summarizePatchFiles(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1,2 @@",
        " one",
        "+two",
        "",
      ].join("\n"),
    );
    expect(files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      ["src/a.ts", 1, 0],
    ]);
  });
});

describe("evidence ledger", () => {
  it("reports unresolved failures since a turn started and clears them on success", async () => {
    const ledger = makeWorkflowEvidenceLedger();
    const threadId = ThreadId.makeUnsafe("thread-evidence");
    const since = new Date(Date.now() - 1_000).toISOString();
    await Effect.runPromise(
      ledger.recordFailure({ threadId, key: "review_target_diff", message: "rate limited" }),
    );
    expect(
      (await Effect.runPromise(ledger.unresolvedFailureSince({ threadId, since })))?.message,
    ).toBe("rate limited");
    await Effect.runPromise(ledger.recordSuccess({ threadId, key: "review_target_diff" }));
    expect(await Effect.runPromise(ledger.unresolvedFailureSince({ threadId, since }))).toBe(
      undefined,
    );
  });
});

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

function fakeGitHub(input: { readonly headShas: ReadonlyArray<string> }) {
  let pullReads = 0;
  const requests: string[] = [];
  const shape = {
    getCredentialContext: () => Effect.succeed({} as never),
    request: (request: { readonly endpoint: string }) => {
      requests.push(request.endpoint);
      const respond = (body: unknown) =>
        Effect.succeed({
          status: 200,
          body,
          graphqlErrors: [],
          links: {},
          etag: null,
          lastModified: null,
          rateLimit: { remaining: 5_000 },
          rateLimitResource: null,
        } as never);
      if (request.endpoint.endsWith("/pulls/42")) {
        const head = input.headShas[Math.min(pullReads, input.headShas.length - 1)] ?? HEAD_SHA;
        pullReads += 1;
        return respond({
          html_url: "https://github.com/acme/app/pull/42",
          title: "Fork change",
          state: "open",
          user: { login: "contributor" },
          changed_files: 1,
          base: { ref: "main", sha: BASE_SHA, repo: { full_name: "acme/app" } },
          head: { ref: "feature", sha: head, repo: { full_name: "contributor/app" } },
        });
      }
      if (request.endpoint.includes("/compare/")) {
        return respond({ merge_base_commit: { sha: MERGE_BASE_SHA } });
      }
      if (request.endpoint.endsWith("/pulls/42/files")) {
        return respond([
          {
            filename: "src/a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            sha: "d".repeat(40),
            patch: "@@ -1 +1,2 @@\n one\n+two",
          },
        ]);
      }
      return Effect.succeed({
        status: 404,
        body: null,
        graphqlErrors: [],
        links: {},
        etag: null,
        lastModified: null,
        rateLimit: { remaining: 5_000 },
        rateLimitResource: null,
      } as never);
    },
  } as unknown as GitHubCliShape;
  return { shape, requests };
}

function memoryRepository() {
  const rows = new Map<string, CodeReviewTargetSnapshot>();
  return Layer.succeed(CodeReviewTargetSnapshotRepository, {
    upsert: (snapshot: CodeReviewTargetSnapshot) =>
      Effect.sync(() => {
        rows.set(snapshot.workflowId, snapshot);
      }),
    getByWorkflowId: (workflowId: CodeReviewWorkflowId) =>
      Effect.sync(() => Option.fromNullishOr(rows.get(workflowId))),
    getById: (id: string) =>
      Effect.sync(() =>
        Option.fromNullishOr([...rows.values()].find((snapshot) => snapshot.id === id)),
      ),
  } as never);
}

let workspace: string;
beforeEach(async () => {
  workspace = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "f5-review-target-"));
});
afterEach(async () => {
  await NodeFs.rm(workspace, { recursive: true, force: true });
});

function captureWith(github: GitHubCliShape) {
  const layer = ReviewTargetServiceLive.pipe(
    Layer.provide(Layer.succeed(GitHubCli, github)),
    Layer.provide(memoryRepository()),
  );
  return Effect.gen(function* () {
    const service = yield* ReviewTargetService;
    const workflowId = CodeReviewWorkflowId.makeUnsafe("review-1");
    const projectId = ProjectId.makeUnsafe("project-1");
    const snapshot = yield* service.capture({
      workflowId,
      projectId,
      workspaceRoot: workspace,
      reviewPrompt: "Please review https://github.com/acme/app/pull/42",
      comparisonRef: null,
    });
    const stored = yield* service.getByWorkflowId(workflowId);
    const other = yield* service
      .getForProject({ snapshotId: snapshot.id, projectId: ProjectId.makeUnsafe("project-2") })
      .pipe(Effect.flip);
    return { snapshot, stored, other };
  }).pipe(Effect.provide(layer));
}

describe("review target capture", () => {
  it("pins a fork pull request to immutable revisions and keeps it project-scoped", async () => {
    const github = fakeGitHub({ headShas: [HEAD_SHA] });
    const { snapshot, stored, other } = await Effect.runPromise(captureWith(github.shape));
    expect(snapshot.kind).toBe("pull-request");
    expect(snapshot.headSha).toBe(HEAD_SHA);
    expect(snapshot.mergeBaseSha).toBe(MERGE_BASE_SHA);
    expect(snapshot.pullRequest?.headRepository).toBe("contributor/app");
    expect(snapshot.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(snapshot.patch).toContain("+two");
    expect(Option.getOrNull(stored)?.id).toBe(snapshot.id);
    expect(other).toBeInstanceOf(ReviewTargetError);
    // Read-only REST calls only; nothing is fetched or checked out.
    expect(github.requests.every((endpoint) => endpoint.startsWith("repos/"))).toBe(true);
  });

  it("fails explicitly when the pull request head keeps moving", async () => {
    const github = fakeGitHub({
      headShas: ["1".repeat(40), "2".repeat(40), "3".repeat(40), "4".repeat(40)],
    });
    const error = await Effect.runPromise(captureWith(github.shape).pipe(Effect.flip));
    expect(error).toBeInstanceOf(ReviewTargetError);
    expect(error instanceof ReviewTargetError ? error.message : "").toContain("kept changing");
  });
});
