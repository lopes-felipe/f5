import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  ThreadId,
  type ForgePrepareOperationInput,
  type OrchestrationThread,
  type SourceControlPullRequestRef,
} from "@t3tools/contracts";
import type { PrHubAccountRuntime } from "../prHub/Layers/PrHubFederation";
import { makePullRequestMcpHandler } from "./pullRequestMcpRuntime";

const ref: SourceControlPullRequestRef = {
  provider: "github",
  host: "github.com",
  repository: "team/repo",
  number: 12,
};
const thread = {
  id: ThreadId.makeUnsafe("pr-thread"),
  archivedAt: null,
  worktreePath: "/repo",
} as OrchestrationThread;
const detail = {
  number: 12,
  url: "https://github.com/team/repo/pull/12",
  headRefOid: "current-head",
  baseRefName: "main",
  headRefName: "work",
  title: "Stack layer",
};

function fixture(
  options: {
    provider?: "github" | "gitlab" | "bitbucket";
    candidates?: unknown;
    checks?: () => unknown;
    log?: unknown;
    diff?: string;
    comments?: readonly Record<string, unknown>[];
    reviewThreads?: readonly Record<string, unknown>[];
    pullRequests?: readonly Record<string, unknown>[];
  } = {},
) {
  const prepared: ForgePrepareOperationInput[] = [];
  const forge = options.provider ?? "github";
  let labels = ["old"];
  let checkReads = 0;
  const runtime = {
    account: { generation: "forge-generation", login: "me" },
    provider: {
      getDetail: () => Effect.succeed({ ...detail, raw: { labels, reviewers: [] } }),
      listReviewerCandidates: () => Effect.succeed(options.candidates),
      getComments: () => Effect.succeed(options.comments ?? []),
      getReviewThreads: () => Effect.succeed(options.reviewThreads ?? []),
      listPullRequests: () => Effect.succeed(options.pullRequests ?? []),
      forgeCapabilities: { review: { reply: true, resolve: true } },
      getDiff: () => Effect.succeed(options.diff ?? ""),
    },
  } as unknown as PrHubAccountRuntime;
  const never = () => Effect.die("Unexpected call");
  const handler = makePullRequestMcpHandler({
    git: {
      status: () =>
        Effect.succeed({
          sourceControl: { kind: forge, host: ref.host, owner: "team", repository: "repo" },
        } as Effect.Success<
          ReturnType<Parameters<typeof makePullRequestMcpHandler>[0]["git"]["status"]>
        >),
      branchPullRequest: never,
    },
    engine: { dispatch: never },
    federation: { parseUrl: never, resolve: () => Effect.succeed(runtime) },
    extensions: {
      getChecks: () =>
        Effect.sync(() => {
          checkReads++;
          return options.checks?.() as Effect.Success<
            ReturnType<Parameters<typeof makePullRequestMcpHandler>[0]["extensions"]["getChecks"]>
          >;
        }),
      getCheckLog: () =>
        Effect.succeed(
          options.log as Effect.Success<
            ReturnType<Parameters<typeof makePullRequestMcpHandler>[0]["extensions"]["getCheckLog"]>
          >,
        ),
      getStack: () => Effect.succeed({ number: 1, fingerprint: "stack-version", layers: [] }),
      recoverOperation: never,
      getOperation: ({ operationId }) =>
        Effect.sync(() => {
          const found = prepared.find((operation) => operation.operationId === operationId);
          return found ? { ...found, status: "succeeded" as const } : null;
        }),
      prepareOperation: (operation) =>
        Effect.sync(() => {
          prepared.push(operation);
          return { ...operation, status: "prepared" };
        }),
      submitOperation: ({ operationId }) =>
        Effect.sync(() => {
          const operation = prepared.find((entry) => entry.operationId === operationId)!;
          if (operation.payload.kind === "labels") labels = [...operation.payload.labels].reverse();
          return { ...operation, status: "succeeded" };
        }),
    },
  });
  const call = (
    request: Parameters<typeof handler>[3],
    target: SourceControlPullRequestRef = { ...ref, provider: forge },
  ) => Effect.runPromise(handler(thread, undefined, [target], request));
  const merge = (expectedHeadSha: string) =>
    call({
      name: "pull_request_merge",
      input: { expectedHeadSha, stack: true, method: "squash" },
    });
  return { call, merge, prepared, checkReads: () => checkReads };
}

describe("pull request MCP routing", () => {
  it("hands the stack fingerprint and reviewed head to the existing atomic operation", async () => {
    const { merge, prepared } = fixture();
    await expect(merge("current-head")).resolves.toMatchObject({ number: 12 });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      accountGeneration: "forge-generation",
      expectedHeadOid: "current-head",
      payload: { kind: "stack", action: "merge", method: "squash", fingerprint: "stack-version" },
    });
  });

  it("refuses a stale merge revision before preparing any write", async () => {
    const { merge, prepared } = fixture();
    await expect(merge("previous-head")).rejects.toThrow(/head changed/u);
    expect(prepared).toEqual([]);
  });

  it("rejects writes outside the thread repository and reads outside its forge", async () => {
    const { call, prepared } = fixture();
    await expect(
      call(
        { name: "pull_request_merge", input: { expectedHeadSha: "current-head" } },
        {
          ...ref,
          repository: "team/another",
        },
      ),
    ).rejects.toThrow(/outside/u);
    await expect(
      call(
        { name: "pull_request_read", input: {} },
        {
          ...ref,
          host: "another.example",
        },
      ),
    ).rejects.toThrow(/outside/u);
    expect(prepared).toEqual([]);
  });

  it("replays a named CI rerun without looking up the failed check again", async () => {
    const { call, prepared, checkReads } = fixture({
      checks: () => ({
        headOid: "current-head",
        checks: [{ name: "Tests", status: "failure", workflowRunId: "42" }],
      }),
    });
    const request = { name: "ci_rerun", input: { check: "Tests", operationId: "rerun" } } as const;
    await call(request);
    await call(request);
    await expect(call({ ...request, input: { ...request.input, check: "Lint" } })).rejects.toThrow(
      /already belongs/u,
    );
    expect(checkReads()).toBe(1);
    expect(prepared).toHaveLength(1);
  });

  it("replays a label update even when the normalized forge list changes order", async () => {
    const { call, prepared } = fixture();
    await call({
      name: "pull_request_update",
      input: { addLabels: ["one", "two"], operationId: "labels" },
    });
    await call({
      name: "pull_request_update",
      input: { addLabels: ["two", "one"], operationId: "labels" },
    });
    expect(prepared).toHaveLength(1);
  });

  it.each([
    ["gitlab", [{ id: 42, username: "alice" }], "42"],
    ["bitbucket", { values: [{ uuid: "{abc}", nickname: "alice" }] }, "{abc}"],
  ] as const)("resolves %s reviewer names to forge IDs", async (provider, candidates, id) => {
    const { call, prepared } = fixture({ provider, candidates });
    await call({ name: "pull_request_update", input: { requestReviewers: ["alice"] } });
    expect(prepared[0]?.payload).toEqual({ kind: "reviewers", reviewers: [id] });
  });

  it("keeps the Unicode-safe log tail within the byte budget", async () => {
    const { call } = fixture({
      checks: () => ({
        headOid: "current-head",
        checks: [{ id: "job", name: "Tests", status: "failure" }],
      }),
      log: { excerpt: "header\n" + "日本語".repeat(500) + "\nERROR final line", startLine: 8 },
    });
    const result = (await call({ name: "ci_logs", input: {} })) as {
      logs: { excerpt: string; truncated: boolean }[];
    };
    expect(result.logs[0]?.excerpt.endsWith("ERROR final line")).toBe(true);
    expect(result.logs[0]?.excerpt).not.toMatch(/header|\uFFFD/u);
    expect(Buffer.byteLength(result.logs[0]!.excerpt)).toBeLessThanOrEqual(3000);
    expect(result.logs[0]?.truncated).toBe(true);
  });

  it("pages top-level comments and diffs independently", async () => {
    const diff = "日本語".repeat(1400);
    const { call } = fixture({
      diff,
      comments: Array.from({ length: 13 }, (_, id) => ({ id, body: "comment" })),
    });
    const first = (await call({
      name: "pull_request_read",
      input: { sections: ["conversation", "diff"] },
    })) as {
      diff: string;
      nextDiffCursor: string;
      conversation: { nextCommentCursor: string };
    };
    const second = (await call({
      name: "pull_request_read",
      input: { diffCursor: first.nextDiffCursor },
    })) as { diff: string };
    expect(first.diff + second.diff).toBe(diff);
    await expect(
      call({
        name: "pull_request_read",
        input: { commentCursor: first.conversation.nextCommentCursor },
      }),
    ).resolves.toMatchObject({
      conversation: { comments: [{ id: "12" }], nextCommentCursor: null },
    });
  });

  it("pages a repository list and rejects cursors for different filters", async () => {
    const { call } = fixture({
      pullRequests: [1, 2, 3].map((number) => ({
        ...detail,
        number,
        state: "open",
        body: "",
        raw: {},
      })),
    });
    const first = (await call({ name: "pull_request_list", input: { limit: 1 } })) as {
      nextCursor: string;
    };
    await expect(
      call({ name: "pull_request_list", input: { cursor: first.nextCursor, limit: 1 } }),
    ).resolves.toMatchObject({ pullRequests: [{ number: 2 }] });
    await expect(
      call({ name: "pull_request_list", input: { cursor: first.nextCursor, state: "closed" } }),
    ).rejects.toThrow(/list changed/u);
  });

  it.each([
    ["github", "987"],
    ["gitlab", "discussion"],
  ] as const)("uses the native %s reply target", async (provider, replyTo) => {
    const { call, prepared } = fixture({
      provider,
      reviewThreads: [
        { id: "discussion", comments: [{ id: "node", databaseId: 987, path: "file.ts" }] },
      ],
    });
    await call({
      name: "pull_request_respond",
      input: { reviewThreadId: "discussion", body: "Reply" },
    });
    expect(prepared[0]?.payload).toEqual({ kind: "comment", body: "Reply", replyTo });
  });

  it("pages replies in a selected discussion", async () => {
    const { call } = fixture({
      reviewThreads: [
        {
          id: "discussion",
          comments: Array.from({ length: 13 }, (_, index) => ({
            id: String(index),
            path: "file.ts",
            body: "Reply",
          })),
        },
      ],
    });
    const first = (await call({
      name: "pull_request_read",
      input: { reviewThreadId: "discussion" },
    })) as {
      conversation: { nextReplyCursor: string };
    };
    await expect(
      call({
        name: "pull_request_read",
        input: {
          reviewThreadId: "discussion",
          replyCursor: first.conversation.nextReplyCursor,
        },
      }),
    ).resolves.toMatchObject({ conversation: { replies: [{ id: "12" }], nextReplyCursor: null } });
  });
});
