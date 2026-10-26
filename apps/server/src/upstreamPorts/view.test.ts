import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { decisionFields, nextEpoch, suggestionDecision } from "./decisions.ts";
import {
  buildPortCommand,
  groupTopicIds,
  portArgsHash,
  portBranchName,
  portThreadTitle,
} from "./admission.ts";
import { SEED_RULES, topic } from "./testFixtures.ts";
import { indexTrailers, pageRows, revisionOf, type DerivedRow } from "./view.ts";

const row = (
  overrides: Parameters<typeof topic>[0],
  state: DerivedRow["state"] = "inbox",
): DerivedRow => ({
  topic: topic(overrides),
  state,
  commitCount: 1,
  doneBy: null,
});

const projectId = ProjectId.makeUnsafe("project-1");

describe("listing", () => {
  const rows = [
    row({ id: "pr-1", createdAt: "2026-10-01T00:00:00.000Z" }),
    row({
      id: "pr-2",
      createdAt: "2026-10-02T00:00:00.000Z",
      suggestion: {
        status: "port",
        reason: "",
        userImpact: "high",
        confidence: 0.4,
        areas: [],
        model: "m",
      },
    }),
    row({
      id: "pr-3",
      createdAt: "2026-10-03T00:00:00.000Z",
      suggestion: {
        status: "skip",
        reason: "",
        userImpact: "none",
        confidence: 0.9,
        areas: [],
        model: "m",
        question: "?",
      },
    }),
    row({ id: "pr-4", createdAt: "2026-10-04T00:00:00.000Z" }),
    row(
      { id: "pr-5", createdAt: "2026-10-05T00:00:00.000Z", decidedBy: "llm", status: "skip" },
      "skipped",
    ),
  ];

  it("orders the inbox by impact, confidence, then newest", () => {
    const page = pageRows(rows, { projectId, list: "inbox" }, "rev");
    expect(page.rows.map((entry) => entry.topic.id)).toEqual(["pr-2", "pr-4", "pr-1", "pr-3"]);
  });

  it("filters by author and question", () => {
    expect(
      pageRows(rows, { projectId, list: "skipped", filter: { decidedBy: "llm" } }, "rev").rows,
    ).toHaveLength(1);
    expect(
      pageRows(rows, { projectId, list: "inbox", filter: { hasQuestion: true } }, "rev").rows.map(
        (r) => r.topic.id,
      ),
    ).toEqual(["pr-3"]);
  });

  it("pages with a cursor and reports a stale cursor after the revision changes", () => {
    const first = pageRows(rows, { projectId, list: "inbox", limit: 2 }, "rev");
    expect(first.rows.map((entry) => entry.topic.id)).toEqual(["pr-2", "pr-4"]);
    const second = pageRows(
      rows,
      { projectId, list: "inbox", limit: 2, cursor: first.nextCursor! },
      "rev",
    );
    expect(second.rows.map((entry) => entry.topic.id)).toEqual(["pr-1", "pr-3"]);
    expect(second.nextCursor).toBeNull();
    expect(
      pageRows(rows, { projectId, list: "inbox", limit: 2, cursor: first.nextCursor! }, "rev-2")
        .status,
    ).toBe("cursor_stale");
    expect(
      pageRows(rows, { projectId, list: "inbox", limit: 3, cursor: first.nextCursor! }, "rev")
        .status,
    ).toBe("cursor_stale");
  });

  it("changes the revision with the base SHA, op seq, links version and date", () => {
    const base = { baseSha: "a".repeat(40), maxSeq: 1, linksVersion: 0, today: "2026-10-22" };
    const revision = revisionOf(base);
    expect(revisionOf({ ...base, baseSha: "b".repeat(40) })).not.toBe(revision);
    expect(revisionOf({ ...base, maxSeq: 2 })).not.toBe(revision);
    expect(revisionOf({ ...base, linksVersion: 1 })).not.toBe(revision);
    expect(revisionOf({ ...base, today: "2026-10-23" })).not.toBe(revision);
  });

  it("indexes trailers and prefers the merge PR number for doneBy", () => {
    const index = indexTrailers([
      {
        sha: "f".repeat(40),
        subject: "Merge pull request #42 from x/y",
        body: "Upstream-Topic: pr-1\n",
      },
      {
        sha: "e".repeat(40),
        subject: "Port settings",
        body: "Port\n\nUpstream-Topic: pr-1\r\nUpstream-Topic: pr-2#2\n",
      },
    ]);
    expect([...index.epochs.get("pr-1")!]).toEqual([1]);
    expect([...index.epochs.get("pr-2")!]).toEqual([2]);
    expect(index.doneBy.get("pr-1#1")).toBe("#42");
    expect(index.doneBy.get("pr-2#2")).toBe("e".repeat(12));
  });
});

describe("decisions", () => {
  const context = {
    rules: SEED_RULES,
    state: "inbox" as const,
    now: "2026-10-22T08:00:00.000Z",
    today: "2026-10-22",
    baseSha: "c".repeat(40),
  };

  it("fills default reasons and dates", () => {
    expect(
      decisionFields(topic({ id: "pr-1" }), { kind: "skip", reasonKey: "mobile" }, context).reason,
    ).toBe(SEED_RULES.reasonLabels.mobile);
    expect(decisionFields(topic({ id: "pr-1" }), { kind: "watch" }, context)).toMatchObject({
      revisitAfter: "2026-11-21",
      reason: "Revisit after 2026-11-21",
    });
    expect(decisionFields(topic({ id: "pr-1" }), { kind: "equivalent" }, context)).toMatchObject({
      reason: "Already present in f5",
      equivalence: { f5Refs: ["c".repeat(40)], evidence: [] },
    });
    expect(() =>
      decisionFields(topic({ id: "pr-1" }), { kind: "skip", reasonKey: "bogus" }, context),
    ).toThrow();
    expect(() =>
      decisionFields(topic({ id: "pr-1" }), { kind: "watch", revisitAfter: "2026-10-01" }, context),
    ).toThrow();
  });

  it("bumps the epoch on reopen from port or done and on port to watch", () => {
    expect(nextEpoch({ status: "port", epoch: 1 }, "ready", "inbox")).toBe(2);
    expect(nextEpoch({ status: "port", epoch: 1 }, "in-progress", "watch")).toBe(2);
    expect(nextEpoch({ status: "skip", epoch: 1 }, "done", "inbox")).toBe(2);
    expect(nextEpoch({ status: "skip", epoch: 1 }, "skipped", "inbox")).toBe(1);
    expect(nextEpoch({ status: "inbox", epoch: 3 }, "inbox", "port")).toBe(3);
  });

  it("clears scope and equivalence when leaving their status", () => {
    const ported = topic({ id: "pr-1", status: "port", scope: "Only the API" });
    const fields = decisionFields(
      ported,
      { kind: "skip", reasonKey: "maintenance" },
      { ...context, state: "ready" },
    );
    expect(fields.scope).toBeUndefined();
    const equivalent = topic({
      id: "pr-2",
      status: "equivalent",
      equivalence: { f5Refs: ["x"], evidence: [] },
    });
    expect(
      decisionFields(equivalent, { kind: "inbox" }, { ...context, state: "done" }),
    ).toMatchObject({ epoch: 2 });
    expect(
      decisionFields(equivalent, { kind: "inbox" }, { ...context, state: "done" }).equivalence,
    ).toBeUndefined();
  });

  it("derives decisions from suggestions", () => {
    expect(suggestionDecision(topic({ id: "pr-1" }))).toBeNull();
    expect(
      suggestionDecision(
        topic({
          id: "pr-1",
          suggestion: {
            status: "equivalent",
            reason: "On main",
            userImpact: "none",
            confidence: 0.7,
            areas: [],
            model: "rule",
            f5Refs: ["d".repeat(40)],
          },
        }),
      ),
    ).toEqual({ kind: "equivalent", reason: "On main", f5Refs: ["d".repeat(40)] });
  });
});

describe("admission helpers", () => {
  it("hashes arguments independent of topic order", () => {
    const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never;
    const a = portArgsHash({
      topicIds: ["pr-1", "pr-2"],
      grouping: "together",
      modelSelection,
      runtimeMode: "full-access",
    });
    const b = portArgsHash({
      topicIds: ["pr-2", "pr-1"],
      grouping: "together",
      modelSelection,
      runtimeMode: "full-access",
    });
    expect(a).toBe(b);
    expect(
      portArgsHash({
        topicIds: ["pr-1", "pr-2"],
        grouping: "separately",
        modelSelection,
        runtimeMode: "full-access",
      }),
    ).not.toBe(a);
  });

  it("rejects more than five groups and names branches and threads", () => {
    expect(() => groupTopicIds(["a", "b", "c", "d", "e", "f"], "separately")).toThrow(/at most 5/u);
    expect(groupTopicIds(["a", "b", "c", "d", "e", "f"], "together")).toEqual([
      ["a", "b", "c", "d", "e", "f"],
    ]);
    expect(portBranchName(["pr-1"])).toBe("f5/upstream-pr-1");
    expect(portBranchName(["pr-1", "pr-2", "pr-3"])).toBe("f5/upstream-pr-1-and-2-more");
    expect(portThreadTitle([{ title: "x".repeat(100) }])).toHaveLength(80);
    expect(portThreadTitle([{ title: "a" }, { title: "b" }])).toBe("Port 2 upstream topics");
  });

  it("builds a worktree turn-start command", () => {
    const command = buildPortCommand({
      projectId: "project-1",
      projectCwd: "/repo",
      threadId: "thread-1",
      messageId: "message-1",
      submissionId: "upstream-port:req:0",
      title: "Port: Settings",
      prompt: "Port it",
      baseBranch: "main",
      branch: "f5/upstream-pr-1",
      runSetupScript: true,
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never,
      driver: "claudeAgent",
      runtimeMode: "full-access",
      createdAt: "2026-10-22T08:00:00.000Z",
    });
    expect(command.bootstrap?.prepareWorktree).toEqual({
      projectCwd: "/repo",
      baseBranch: "main",
      branch: "f5/upstream-pr-1",
    });
    expect(command.bootstrap?.runSetupScript).toBe(true);
    expect(command.commandId).toBe("upstream-port:req:0");
    expect(command.provider).toBe("claudeAgent");
  });
});
