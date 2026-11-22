import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  ThreadId,
  type ForgePrepareOperationInput,
  type OrchestrationThread,
} from "@t3tools/contracts";
import type { PrHubAccountRuntime } from "../prHub/Layers/PrHubFederation";
import { makePullRequestMcpHandler } from "./pullRequestMcpRuntime";

const ref = {
  provider: "github",
  host: "github.com",
  repository: "team/repo",
  number: 12,
} as const;
const thread = { id: ThreadId.makeUnsafe("pr-thread"), archivedAt: null } as OrchestrationThread;
const detail = {
  number: 12,
  url: "https://github.com/team/repo/pull/12",
  headRefOid: "current-head",
  baseRefName: "main",
  headRefName: "work",
  title: "Stack layer",
};

function fixture() {
  const prepared: ForgePrepareOperationInput[] = [];
  const runtime = {
    account: { generation: "forge-generation" },
    provider: { getDetail: () => Effect.succeed(detail) },
  } as unknown as PrHubAccountRuntime;
  const never = () => Effect.die("Unexpected call");
  const handler = makePullRequestMcpHandler({
    git: { status: never, branchPullRequest: never },
    engine: { dispatch: never },
    federation: { parseUrl: never, resolve: () => Effect.succeed(runtime) },
    extensions: {
      getChecks: never,
      getCheckLog: never,
      getStack: () => Effect.succeed({ number: 1, fingerprint: "stack-version", layers: [] }),
      getOperation: () => Effect.succeed(null),
      prepareOperation: (operation) =>
        Effect.sync(() => {
          prepared.push(operation);
          return { ...operation, status: "prepared" };
        }),
      submitOperation: () => Effect.sync(() => ({ ...prepared.at(-1)!, status: "succeeded" })),
    },
  });
  const merge = (expectedHeadSha: string) =>
    Effect.runPromise(
      handler(thread, undefined, [ref], {
        name: "pull_request_merge",
        input: { expectedHeadSha, stack: true, method: "squash" },
      }),
    );
  return { merge, prepared };
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
});
