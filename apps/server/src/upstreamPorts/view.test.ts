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
import {
  indexTrailers,
  listTopicIds,
  pageRows,
  resolveSort,
  revisionOf,
  type DerivedRow,
} from "./view.ts";

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

  describe("search, filters, facets and sort", () => {
    const suggestion = (
      status: "port" | "skip" | "watch" | "equivalent",
      userImpact: "high" | "medium" | "low" | "none",
      confidence: number,
      areas: string[],
      extra: object = {},
    ) => ({
      status,
      reason: `${status} because`,
      userImpact,
      confidence,
      areas,
      model: "m",
      ...extra,
    });
    const inbox = [
      row({
        id: "pr-10",
        title: "Fix terminal resize",
        createdAt: "2026-10-01T00:00:00.000Z",
        upstreamPrs: [10],
        suggestion: suggestion("port", "high", 0.6, ["terminal"]),
      }),
      row({
        id: "pr-11",
        title: "Mobile layout",
        createdAt: "2026-10-02T00:00:00.000Z",
        upstreamPrs: [11],
        suggestion: suggestion("skip", "none", 0.95, ["mobile"], { reasonKey: "mobile" }),
      }),
      row({
        id: "pr-12",
        title: "Server cache",
        createdAt: "2026-10-03T00:00:00.000Z",
        upstreamPrs: [12],
        suggestion: suggestion("port", "medium", 0.9, ["server", "terminal"], { conflict: true }),
      }),
      row({
        id: "pr-13",
        title: "Untriaged",
        createdAt: "2026-10-04T00:00:00.000Z",
        upstreamPrs: [13],
      }),
    ];
    const ids = (result: { readonly rows: ReadonlyArray<DerivedRow> }) =>
      result.rows.map((entry) => entry.topic.id);
    const list = (filter: object = {}, sort?: "priority" | "newest" | "oldest" | "confidence") =>
      pageRows(
        inbox,
        { projectId, list: "inbox", filter, ...(sort ? { sort } : {}) },
        "rev",
        (id) => (id === "pr-13" ? ["chore: bump electron"] : []),
      );

    it("matches the query on title, id, PR number, reason, areas and commit subjects", () => {
      expect(ids(list({ query: "TERMINAL" }))).toEqual(["pr-10", "pr-12"]);
      expect(ids(list({ query: "pr-11" }))).toEqual(["pr-11"]);
      expect(ids(list({ query: "#12" }))).toEqual(["pr-12"]);
      expect(ids(list({ query: "skip because" }))).toEqual(["pr-11"]);
      expect(ids(list({ query: "electron" }))).toEqual(["pr-13"]);
      expect(ids(list({ query: "  " }))).toHaveLength(4);
    });

    it("filters by suggestion, impact, area and conflict, and reports the total", () => {
      expect(ids(list({ suggestion: ["port"] }))).toEqual(["pr-10", "pr-12"]);
      expect(ids(list({ suggestion: ["none"] }))).toEqual(["pr-13"]);
      expect(ids(list({ impact: ["high", "none"] }))).toEqual(["pr-10", "pr-11"]);
      expect(ids(list({ area: "terminal", suggestion: ["port"] }))).toEqual(["pr-10", "pr-12"]);
      expect(ids(list({ hasConflict: true }))).toEqual(["pr-12"]);
      expect(list({ suggestion: ["port"] }).total).toBe(2);
      expect(list({}, undefined).total).toBe(4);
    });

    it("counts each facet over the other filters only", () => {
      const facets = list({ suggestion: ["port"], impact: ["high"] }).facets;
      // Suggestion counts ignore the suggestion filter but apply the impact one.
      expect(facets.suggestion).toEqual({ port: 1, skip: 0, watch: 0, equivalent: 0, none: 0 });
      // Impact counts ignore the impact filter but apply the suggestion one.
      expect(facets.impact).toEqual({ high: 1, medium: 1, low: 0, none: 0 });
      expect(facets.areas).toEqual([{ area: "terminal", count: 1 }]);
      expect(list().facets.areas).toEqual([
        { area: "terminal", count: 2 },
        { area: "mobile", count: 1 },
        { area: "server", count: 1 },
      ]);
    });

    it("sorts by priority, newest, oldest or confidence", () => {
      expect(ids(list({}, "priority"))).toEqual(["pr-10", "pr-12", "pr-13", "pr-11"]);
      expect(ids(list({}, "newest"))).toEqual(["pr-13", "pr-12", "pr-11", "pr-10"]);
      expect(ids(list({}, "oldest"))).toEqual(["pr-10", "pr-11", "pr-12", "pr-13"]);
      expect(ids(list({}, "confidence"))).toEqual(["pr-11", "pr-12", "pr-10", "pr-13"]);
      expect(resolveSort("inbox", undefined)).toBe("priority");
      expect(resolveSort("done", undefined)).toBe("newest");
    });

    it("treats a cursor as stale when the sort changes", () => {
      const first = pageRows(inbox, { projectId, list: "inbox", sort: "newest", limit: 2 }, "rev");
      expect(
        pageRows(
          inbox,
          { projectId, list: "inbox", sort: "newest", limit: 2, cursor: first.nextCursor! },
          "rev",
        ).status,
      ).toBe("ok");
      expect(
        pageRows(
          inbox,
          { projectId, list: "inbox", sort: "oldest", limit: 2, cursor: first.nextCursor! },
          "rev",
        ).status,
      ).toBe("cursor_stale");
    });

    it("lists every matching id in the order paging returns them", () => {
      const input = {
        list: "inbox" as const,
        filter: { suggestion: ["port" as const, "none" as const] },
        sort: "oldest" as const,
      };
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const page: ReturnType<typeof pageRows> = pageRows(
          inbox,
          { projectId, ...input, limit: 1, ...(cursor ? { cursor } : {}) },
          "rev",
        );
        paged.push(...ids(page));
        cursor = page.nextCursor;
      } while (cursor);
      expect(listTopicIds(inbox, input)).toEqual({ topicIds: paged, truncated: false });
      expect(paged).toEqual(["pr-10", "pr-12", "pr-13"]);
    });
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
