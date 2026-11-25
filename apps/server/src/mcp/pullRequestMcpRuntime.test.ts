import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  ThreadId,
  type ForgePrepareOperationInput,
  type OrchestrationThread,
  type SourceControlPullRequestRef,
} from "@t3tools/contracts";
import {
  formatSourceControlPullRequestKey,
  parseSourceControlPullRequestKey,
} from "@t3tools/shared/sourceControl";
import type { PrHubAccountRuntime } from "../prHub/Layers/PrHubFederation";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider";
import { makePullRequestMcpHandler, REPOSITORY_FILE_BYTE_LIMIT } from "./pullRequestMcpRuntime";

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
    /** False for a thread whose workspace has no recognized forge repository. */
    home?: boolean;
    content?: (input: {
      ref: SourceControlPullRequestRef;
      path: string;
      revision?: string;
    }) => unknown;
  } = {},
) {
  const prepared: ForgePrepareOperationInput[] = [];
  const resolved: SourceControlPullRequestRef[] = [];
  const contentReads: Array<{
    ref: SourceControlPullRequestRef;
    path: string;
    revision?: string;
  }> = [];
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
      ...(options.content
        ? {
            readRepositoryContent: (input: {
              ref: SourceControlPullRequestRef;
              path: string;
              revision?: string;
            }) =>
              Effect.sync(() => {
                contentReads.push(input);
                return options.content!(input);
              }),
          }
        : {}),
    },
  } as unknown as PrHubAccountRuntime;
  const never = () => Effect.die("Unexpected call");
  const handler = makePullRequestMcpHandler({
    git: {
      status: () =>
        Effect.succeed({
          sourceControl:
            options.home === false
              ? null
              : { kind: forge, host: ref.host, owner: "team", repository: "repo" },
        } as Effect.Success<
          ReturnType<Parameters<typeof makePullRequestMcpHandler>[0]["git"]["status"]>
        >),
      branchPullRequest: never,
    },
    engine: { dispatch: never },
    federation: {
      parseUrl: never,
      resolve: ({ key }) =>
        Effect.gen(function* () {
          const target = parseSourceControlPullRequestKey(key ?? "");
          if (target) resolved.push(target);
          // Like the federation router: a host with no connected account is refused.
          if (target && target.host !== ref.host)
            return yield* new SourceControlProviderError({
              provider: "github",
              operation: "prHub.route",
              kind: "forbidden",
              detail: "No connected account for this host.",
            });
          return runtime;
        }),
    },
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
  return { call, merge, prepared, resolved, contentReads, checkReads: () => checkReads };
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

  it("reads PRs without a home repository only on a connected forge host, never writes", async () => {
    const { call, prepared, resolved } = fixture({ home: false, diff: "diff --git" });
    await expect(
      call({ name: "pull_request_read", input: { sections: ["diff"] } }),
    ).resolves.toMatchObject({ diff: "diff --git" });
    expect(resolved.at(-1)).toMatchObject({ host: "github.com", repository: "team/repo" });
    await expect(
      call({ name: "pull_request_read", input: {} }, { ...ref, host: "another.example" }),
    ).rejects.toThrow(/No connected account/u);
    await expect(
      call({ name: "pull_request_merge", input: { expectedHeadSha: "current-head" } }),
    ).rejects.toThrow(/no recognized forge/u);
    expect(prepared).toEqual([]);
  });

  describe("repository_file_read", () => {
    const file =
      (text: string | null, binary = false) =>
      () => ({
        kind: "file" as const,
        path: "src/a.ts",
        size: text?.length ?? 2_000_000,
        text,
        binary,
      });

    it("reads a file at the named PR's head", async () => {
      const { call, contentReads } = fixture({ content: file("export {};") });
      await expect(
        call({ name: "repository_file_read", input: { number: 12, path: "/src/a.ts" } }),
      ).resolves.toEqual({
        repository: "team/repo",
        revision: "current-head",
        path: "src/a.ts",
        kind: "file",
        size: 10,
        text: "export {};",
        truncated: false,
      });
      expect(contentReads).toEqual([
        { ref: { ...ref, number: 12 }, path: "src/a.ts", revision: "current-head" },
      ]);
    });

    it("lists a directory at an explicit revision of another repository on the forge", async () => {
      const { call, contentReads } = fixture({
        content: () => ({
          kind: "directory",
          path: "",
          entries: [{ name: "src", type: "dir", size: 0 }],
        }),
      });
      await expect(
        call({ name: "repository_file_read", input: { repository: "team/other", ref: "main" } }),
      ).resolves.toEqual({
        repository: "team/other",
        revision: "main",
        path: "",
        kind: "directory",
        entries: [{ name: "src", type: "dir", size: 0 }],
        truncated: false,
      });
      expect(contentReads[0]).toMatchObject({
        ref: { repository: "team/other" },
        revision: "main",
      });
    });

    it("caps file text and withholds binary or missing content", async () => {
      const big = fixture({ content: file("x".repeat(REPOSITORY_FILE_BYTE_LIMIT + 10)) });
      const capped = (await big.call({
        name: "repository_file_read",
        input: { path: "big.txt" },
      })) as { text: string; truncated: boolean };
      expect(capped.truncated).toBe(true);
      expect(capped.text).toHaveLength(REPOSITORY_FILE_BYTE_LIMIT);
      await expect(
        fixture({ content: file(null, true) }).call({
          name: "repository_file_read",
          input: { path: "logo.png" },
        }),
      ).resolves.toMatchObject({ text: null, note: expect.stringMatching(/Binary/u) });
      await expect(
        fixture({ content: file(null) }).call({
          name: "repository_file_read",
          input: { path: "huge.json" },
        }),
      ).resolves.toMatchObject({ text: null, note: expect.stringMatching(/too large/u) });
    });

    it("refuses traversal paths, unsupported forges and other hosts", async () => {
      const { call, contentReads } = fixture({ content: file("x") });
      for (const path of ["../secret", "src/../../x", "a//b", "a\\b"])
        await expect(call({ name: "repository_file_read", input: { path } })).rejects.toThrow(
          /repository root/u,
        );
      expect(contentReads).toEqual([]);
      await expect(
        fixture().call({ name: "repository_file_read", input: { path: "README.md" } }),
      ).rejects.toThrow(/not supported for this forge/u);
      const homeless = fixture({ home: false, content: file("x") });
      await expect(
        homeless.call({
          name: "repository_file_read",
          input: { pr: formatSourceControlPullRequestKey({ ...ref, host: "another.example" }) },
        }),
      ).rejects.toThrow(/No connected account/u);
      await expect(
        homeless.call({
          name: "repository_file_read",
          input: { pr: formatSourceControlPullRequestKey(ref), path: "README.md" },
        }),
      ).resolves.toMatchObject({ repository: "team/repo", revision: "current-head" });
    });
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
