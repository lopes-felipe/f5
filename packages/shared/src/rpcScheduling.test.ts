import { WebSocketRequest } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS } from "./codexOAuthTiming";
import {
  ORCHESTRATION_COMMAND_LANES,
  RPC_LANE_LIMITS,
  RPC_LANES,
  RPC_METHOD_POLICY,
  RpcAdmission,
  isReadOnlyRpc,
  rpcLane,
  rpcLongRunningTimeoutMs,
  rpcMethodPolicy,
  rpcRequiresRuntime,
} from "./rpcScheduling";

/** Collects every `_tag` literal the request schema accepts. */
function requestTags(): Set<string> {
  const tags = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (ast: unknown) => {
    if (!ast || typeof ast !== "object" || seen.has(ast)) return;
    seen.add(ast);
    const node = ast as {
      propertySignatures?: ReadonlyArray<{ name: unknown; type: { literal?: unknown } }>;
      types?: ReadonlyArray<unknown>;
      encoding?: ReadonlyArray<{ to: unknown }>;
    };
    for (const property of node.propertySignatures ?? [])
      if (property.name === "_tag" && property.type.literal !== undefined)
        tags.add(String(property.type.literal));
    for (const type of node.types ?? []) visit(type);
    for (const link of node.encoding ?? []) visit(link.to);
  };
  visit(WebSocketRequest.fields.body.ast);
  return tags;
}

describe("RPC admission", () => {
  it("reserves controls independently of eight occupied ordinary slots", () => {
    const admission = new RpcAdmission();
    const releases = Array.from({ length: 8 }, () => admission.claim("ordinary", 1024));
    expect(releases.every(Boolean)).toBe(true);
    expect(admission.claim("ordinary", 1)).toBeNull();
    expect(admission.claim("stop", 1024)).not.toBeNull();
    expect(admission.claim("answer", 1024)).not.toBeNull();
    expect(admission.claim("answer", 1024)).not.toBeNull();
    expect(admission.claim("answer", 1)).toBeNull();
    expect(admission.claim("health", 1)).not.toBeNull();
    expect(admission.claim("health", 1)).toBeNull();
    releases[0]!();
    releases[0]!();
    expect(admission.claim("ordinary", 1024)).not.toBeNull();
    expect(admission.claim("ordinary", 1024)).toBeNull();
  });
  it("accepts legal 20 MiB frames and bounds retained ordinary bytes at 80 MiB", () => {
    const admission = new RpcAdmission();
    for (let i = 0; i < 4; i++)
      expect(admission.claim("ordinary", 20 * 1024 * 1024)).not.toBeNull();
    expect(admission.claim("ordinary", 1)).toBeNull();
    expect(admission.claim("stop", 1)).not.toBeNull();
  });
  it("admits four long operations without touching ordinary slots", () => {
    const admission = new RpcAdmission();
    for (let i = 0; i < RPC_LANE_LIMITS.long; i++)
      expect(admission.claim("long", 1)).not.toBeNull();
    expect(admission.claim("long", 1)).toBeNull();
    expect(admission.claim("ordinary", 1)).not.toBeNull();
  });
  it("reports lane counts, bytes and the oldest held claim", () => {
    let now = 1_000;
    const admission = new RpcAdmission(() => now);
    const first = admission.claim("ordinary", 10)!;
    now = 1_500;
    admission.claim("ordinary", 5);
    now = 2_000;
    expect(admission.snapshot().ordinary).toEqual({ count: 2, bytes: 15, oldestAgeMs: 1_000 });
    first();
    expect(admission.snapshot().ordinary).toEqual({ count: 1, bytes: 5, oldestAgeMs: 500 });
    expect(admission.snapshot().stop).toEqual({ count: 0, bytes: 0, oldestAgeMs: null });
  });
  it("classifies nested dispatch commands", () => {
    expect(
      rpcLane({
        _tag: "orchestration.dispatchCommand",
        command: { type: "thread.turn.interrupt" },
      }),
    ).toBe("stop");
    for (const type of [
      "thread.approval.respond",
      "thread.user-input.respond",
      "thread.turn.steer",
    ])
      expect(rpcLane({ _tag: "orchestration.dispatchCommand", command: { type } })).toBe("answer");
    expect(rpcLane({ _tag: "orchestration.getStartupSnapshot" })).toBe("recovery");
    expect(
      rpcLane({ _tag: "orchestration.dispatchCommand", command: { type: "thread.turn.start" } }),
    ).toBe("ordinary");
  });
});

describe("RPC method policy", () => {
  it("covers exactly the routed request tags", () => {
    expect(new Set(Object.keys(RPC_METHOD_POLICY))).toEqual(requestTags());
  });

  it("gives every policy a known lane and long-lane deadlines only to long work", () => {
    for (const [method, policy] of Object.entries(RPC_METHOD_POLICY)) {
      expect(RPC_LANES, method).toContain(policy.lane);
      expect("longRunningTimeoutMs" in policy, method).toBe(policy.lane === "long");
      if (policy.lane === "long") expect(policy.kind, method).toBe("mutation");
    }
    expect(rpcMethodPolicy("unknown.getAnything")).toBeUndefined();
    expect(rpcMethodPolicy("toString")).toBeUndefined();
    expect(rpcLane({ _tag: "unknown.getAnything" })).toBe("ordinary");
  });

  it("routes every multiplexed control command to a dedicated lane", () => {
    for (const [type, lane] of Object.entries(ORCHESTRATION_COMMAND_LANES))
      expect(rpcLane({ _tag: "orchestration.dispatchCommand", command: { type } })).toBe(lane);
    expect(rpcLane({ _tag: "orchestration.dispatchCommand" })).toBe("ordinary");
  });

  it("puts probes on the health lane and keeps terminal and storage status ordinary", () => {
    expect(rpcLane({ _tag: "server.probe" })).toBe("health");
    for (const method of [
      "orchestration.getStartupSnapshot",
      "orchestration.getSnapshot",
      "orchestration.getLatestSequence",
    ])
      expect(rpcLane({ _tag: method })).toBe("recovery");
    expect(rpcLane({ _tag: "terminal.snapshot" })).toBe("ordinary");
    expect(rpcLane({ _tag: "storage.getStatus" })).toBe("ordinary");
  });

  it("moves long operations and their deadlines into the policy", () => {
    const longMethods = Object.entries(RPC_METHOD_POLICY)
      .filter(([, policy]) => policy.lane === "long")
      .map(([method]) => method)
      .sort();
    expect(longMethods).toEqual(
      [
        "git.prepareWorktree",
        "git.runStackedAction",
        "mcp.probeServer",
        "mcp.startLogin",
        "mcp.startOAuthLogin",
        "prHub.analyzeAdvisories",
        "server.runProviderUpdate",
        "worktrees.moveThread",
        "worktrees.resolveTransition",
        "worktrees.switchWorkspace",
      ].sort(),
    );
    expect(rpcLongRunningTimeoutMs({ _tag: "git.runStackedAction" })).toBeNull();
    expect(rpcLongRunningTimeoutMs({ _tag: "server.runProviderUpdate" })).toBe(660_000);
    expect(rpcLongRunningTimeoutMs({ _tag: "mcp.probeServer" })).toBe(75_000);
    expect(rpcLongRunningTimeoutMs({ _tag: "mcp.startOAuthLogin" })).toBe(
      CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS,
    );
    // Only Codex MCP login waits for the OAuth window; other providers use the default.
    expect(rpcLongRunningTimeoutMs({ _tag: "mcp.startLogin", provider: "codex" })).toBe(
      CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS,
    );
    expect(rpcLongRunningTimeoutMs({ _tag: "mcp.startLogin", provider: "claudeAgent" })).toBe(
      undefined,
    );
    expect(rpcLongRunningTimeoutMs({ _tag: "git.status" })).toBe(undefined);
  });

  it("treats audited Upstream reads as reads and keeps queue reads that fetch as mutations", () => {
    for (const method of [
      "upstreamPorts.listProjects",
      "upstreamPorts.getOverview",
      "upstreamPorts.listTopics",
      "upstreamPorts.listTopicIds",
      "upstreamPorts.getTopic",
      "upstreamPorts.getTopicFiles",
      "upstreamPorts.previewPortGroups",
      "upstreamPorts.getPortPrompt",
    ]) {
      expect(isReadOnlyRpc(method), method).toBe(true);
      expect(rpcRequiresRuntime({ _tag: method }), method).toBe(true);
    }
    // getPortQueue can start a base fetch, so it is not proven read-only.
    expect(isReadOnlyRpc("upstreamPorts.getPortQueue")).toBe(false);
    expect(isReadOnlyRpc("upstreamPorts.decide")).toBe(false);
  });

  it("marks projection-backed startup reads as runtime-independent", () => {
    expect(rpcRequiresRuntime({ _tag: "orchestration.getStartupSnapshot" })).toBe(false);
    expect(rpcRequiresRuntime({ _tag: "orchestration.getThreadTailDetails" })).toBe(false);
    expect(rpcRequiresRuntime({ _tag: "orchestration.getSnapshot" })).toBe(true);
    expect(rpcRequiresRuntime({ _tag: "orchestration.getLatestSequence" })).toBe(true);
    expect(rpcRequiresRuntime({ _tag: "orchestration.dispatchCommand" })).toBe(true);
    expect(rpcRequiresRuntime({ _tag: "git.status" })).toBe(false);
    expect(rpcRequiresRuntime({ _tag: "server.probe" })).toBe(false);
  });

  it("requires the runtime only for the bodies whose route branch awaits it", () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown> & { _tag: string }, boolean]> = [
      [{ _tag: "server.updateSettings", patch: {} }, false],
      [{ _tag: "server.updateSettings", projectSettingsOverrides: { p: null } }, true],
      [{ _tag: "server.getProviderInventory", instanceId: "codex" }, false],
      [{ _tag: "server.getProviderInventory", instanceId: "codex", projectId: "p" }, true],
      [{ _tag: "git.preparePullRequestThread", mode: "worktree" }, false],
      [{ _tag: "git.preparePullRequestThread", mode: "local" }, true],
      [{ _tag: "git.runStackedAction", action: "commit" }, false],
      [{ _tag: "git.runStackedAction", action: "commit", featureBranch: true }, true],
    ];
    for (const [body, expected] of cases)
      expect(rpcRequiresRuntime(body), JSON.stringify(body)).toBe(expected);
  });

  it("computes the same lane from client params and the server-decoded body", () => {
    const decode = Schema.decodeUnknownSync(WebSocketRequest);
    const bodies: ReadonlyArray<Record<string, unknown> & { _tag: string }> = [
      { _tag: "server.probe" },
      { _tag: "git.status", cwd: "/repo" },
      { _tag: "orchestration.getStartupSnapshot" },
      {
        _tag: "orchestration.dispatchCommand",
        command: {
          type: "thread.turn.interrupt",
          commandId: "command-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        _tag: "orchestration.dispatchCommand",
        command: {
          type: "thread.archive",
          commandId: "command-2",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      { _tag: "storage.cancelCleanup", operationId: "operation-1" },
    ];
    for (const body of bodies) {
      const decoded = decode(JSON.parse(JSON.stringify({ id: "1", body })));
      expect(rpcLane(decoded.body), body._tag).toBe(rpcLane(body));
    }
  });
});

it("keeps ordinary thread reads out of the snapshot lane and admits queue steering", () => {
  for (const method of [
    "orchestration.getThreadDetails",
    "orchestration.getThreadTailDetails",
    "orchestration.getThreadHistoryPage",
    "orchestration.getThreadCommandExecutions",
    "orchestration.getThreadFileChanges",
  ])
    expect(rpcLane({ _tag: method })).toBe("ordinary");
  const admission = new RpcAdmission();
  for (let i = 0; i < 8; i++) admission.claim("ordinary", 1);
  expect(admission.claim(rpcLane({ _tag: "nextTurnQueue.steer" }), 1)).not.toBeNull();
});

it("allows only explicitly audited reads during recovery", () => {
  for (const method of [
    "providerAccount.logout",
    "providerAccount.loginStart",
    "githubAccount.loginStart",
    "githubAccount.loginCancel",
    "nativeOperation.resolve",
    "unknown.getAnything",
  ])
    expect(isReadOnlyRpc(method)).toBe(false);
  for (const method of [
    "terminal.snapshot",
    "review.previewDiff",
    "nextTurnQueue.summary",
    "globalSearch.query",
    "worktrees.list",
    "projects.cloneList",
    "githubAccount.cliCandidates",
    "projects.setWatchedPaths",
  ])
    expect(isReadOnlyRpc(method)).toBe(true);
  expect(rpcMethodPolicy("projects.setWatchedPaths")?.kind).toBe("connection-control");
});

it("keeps storage cancellation responsive while database users fill the ordinary lane", () => {
  const admission = new RpcAdmission();
  for (let index = 0; index < 8; index++) admission.claim("ordinary", 1);
  expect(rpcLane({ _tag: "storage.cancelCleanup" })).toBe("stop");
  expect(admission.claim(rpcLane({ _tag: "storage.cancelCleanup" }), 1)).not.toBeNull();
  for (const method of [
    "storage.getUsage",
    "storage.getStatus",
    "storage.getTargets",
    "storage.getOperation",
  ])
    expect(isReadOnlyRpc(method)).toBe(true);
  expect(isReadOnlyRpc("storage.cleanup")).toBe(false);
  expect(isReadOnlyRpc("storage.cancelCleanup")).toBe(false);
});
