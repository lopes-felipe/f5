import type { UpstreamTopic, UpstreamTopicSuggestion } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  autoPortCandidates,
  countExpiryByLane,
  expiryCandidates,
  featureDigest,
  inboxSince,
} from "./budget.ts";
import { topic } from "./testFixtures.ts";
import { scoreTopic, type DerivedRow } from "./view.ts";

const suggestion = (overrides: Partial<UpstreamTopicSuggestion> = {}): UpstreamTopicSuggestion => ({
  status: "port",
  reason: "r",
  userImpact: "medium",
  confidence: 0.9,
  areas: [],
  model: "m",
  kind: "fix",
  ...overrides,
});

const row = (
  overrides: Partial<UpstreamTopic> & Pick<UpstreamTopic, "id">,
  state: DerivedRow["state"] = "inbox",
  areaPolicy: Record<string, "follow" | "fixes-only" | "ignore"> = {},
): DerivedRow => {
  const value = topic({ suggestion: suggestion(), ...overrides });
  const { lane, score } = scoreTopic(value, [], areaPolicy);
  return { topic: value, state, commitCount: 1, doneBy: null, lane, score };
};

const NONE = new Set<string>();

describe("inboxSince", () => {
  it("uses the revisit date for returned watches, else the latest decision or creation", () => {
    expect(inboxSince(topic({ id: "a", status: "watch", revisitAfter: "2026-10-20" }))).toBe(
      "2026-10-20",
    );
    expect(inboxSince(topic({ id: "a", decidedAt: "2026-10-15T08:00:00.000Z" }))).toBe(
      "2026-10-15",
    );
    expect(inboxSince(topic({ id: "a", createdAt: "2026-10-03T08:00:00.000Z" }))).toBe(
      "2026-10-03",
    );
  });
});

describe("expiryCandidates", () => {
  const options = { olderThanDays: 14, keepScore: 70, today: "2026-10-15", busyTopicIds: NONE };

  it("expires at the boundary and doubles the window for kept scores", () => {
    const low = row({ id: "low", createdAt: "2026-10-01T00:00:00.000Z" });
    const young = row({ id: "young", createdAt: "2026-10-02T00:00:00.000Z" });
    const kept = row({
      id: "kept",
      createdAt: "2026-10-01T00:00:00.000Z",
      suggestion: suggestion({ userImpact: "high", f5Coverage: "all" }),
    });
    expect(kept.score).toBeGreaterThanOrEqual(70);
    expect(expiryCandidates([low, young, kept], options).map((r) => r.topic.id)).toEqual(["low"]);
    expect(
      expiryCandidates([kept], { ...options, today: "2026-10-29" }).map((r) => r.topic.id),
    ).toEqual(["kept"]);
  });

  it("never expires security, busy, or non-inbox topics", () => {
    const old = "2026-09-01T00:00:00.000Z";
    const rows = [
      row({
        id: "sec",
        createdAt: old,
        suggestion: suggestion({ kind: "security", severity: "low" }),
      }),
      row({ id: "busy", createdAt: old }),
      row({ id: "ready", createdAt: old, status: "port" }, "ready"),
      row({ id: "feat", createdAt: old, suggestion: suggestion({ kind: "feat" }) }),
    ];
    const expired = expiryCandidates(rows, { ...options, busyTopicIds: new Set(["busy"]) });
    expect(expired.map((r) => r.topic.id)).toEqual(["feat"]);
    expect(countExpiryByLane(expired)).toEqual({ bug: 0, perf: 0, feature: 1, maintenance: 0 });
  });

  it("measures a returned watch from its revisit date", () => {
    const watch = row({
      id: "w",
      status: "watch",
      createdAt: "2026-08-01T00:00:00.000Z",
      revisitAfter: "2026-10-10",
    });
    expect(expiryCandidates([watch], options)).toEqual([]);
    expect(expiryCandidates([watch], { ...options, today: "2026-10-24" })).toHaveLength(1);
  });
});

it("counts this week's inbox features by area policy", () => {
  const policy = { git: "follow" } as const;
  const rows = [
    row(
      {
        id: "a",
        createdAt: "2026-10-14T00:00:00.000Z",
        suggestion: suggestion({ kind: "feat", areas: ["git"] }),
      },
      "inbox",
      policy,
    ),
    row(
      {
        id: "b",
        createdAt: "2026-10-13T00:00:00.000Z",
        suggestion: suggestion({ kind: "feat", areas: ["mcp"] }),
      },
      "inbox",
      policy,
    ),
    row(
      {
        id: "old",
        createdAt: "2026-10-01T00:00:00.000Z",
        suggestion: suggestion({ kind: "feat" }),
      },
      "inbox",
      policy,
    ),
    row({ id: "fix", createdAt: "2026-10-14T00:00:00.000Z" }, "inbox", policy),
  ];
  expect(featureDigest(rows, "2026-10-15", policy)).toEqual({ followed: 1, other: 1 });
});

describe("autoPortCandidates", () => {
  const security = (
    id: string,
    severity: "critical" | "high" | "medium",
    extra: Partial<UpstreamTopicSuggestion> = {},
  ) => row({ id, suggestion: suggestion({ kind: "security", severity, ...extra }) });
  const bug = (id: string, extra: Partial<UpstreamTopicSuggestion> = {}) =>
    row({ id, suggestion: suggestion({ userImpact: "high", f5Coverage: "all", ...extra }) });
  const rows = [
    security("s-high", "high"),
    security("s-crit", "critical"),
    security("s-med", "medium"),
    security("s-doubt", "critical", { question: "?" }),
    security("s-unsure", "critical", { confidence: 0.8 }),
    bug("b-ok"),
    bug("b-partial", { f5Coverage: "partial" }),
    bug("b-medium", { userImpact: "medium" }),
    bug("b-skip", { status: "skip" }),
  ];
  const ids = new Set(rows.map((r) => r.topic.id));

  it("picks confident high/critical security fixes, highest score first", () => {
    const picked = autoPortCandidates(rows, {
      mode: "security",
      topicIds: ids,
      busyTopicIds: NONE,
    });
    expect(picked.map((r) => r.topic.id)).toEqual(["s-crit", "s-high"]);
  });

  it("adds high-impact bug fixes covered by f5 in security-and-bugs mode", () => {
    const picked = autoPortCandidates(rows, {
      mode: "security-and-bugs",
      topicIds: ids,
      busyTopicIds: NONE,
    });
    expect(picked.map((r) => r.topic.id)).toEqual(["s-crit", "s-high", "b-ok"]);
  });

  it("only considers this run's idle topics and nothing when off", () => {
    expect(autoPortCandidates(rows, { mode: "off", topicIds: ids, busyTopicIds: NONE })).toEqual(
      [],
    );
    expect(
      autoPortCandidates(rows, {
        mode: "security-and-bugs",
        topicIds: new Set(["s-crit", "b-ok"]),
        busyTopicIds: new Set(["b-ok"]),
      }).map((r) => r.topic.id),
    ).toEqual(["s-crit"]);
  });
});
