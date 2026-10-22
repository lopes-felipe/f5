import type { UpstreamTopic } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  applyOps,
  buildRevertChains,
  canonicalJson,
  deriveTopicState,
  digestShas,
  evaluateBaseRefRules,
  findRevertTarget,
  indexEpochs,
  intervalPath,
  legacyPath,
  matchAutoSkipRule,
  opEffectPresent,
  parseLedgerFiles,
  parseRules,
  parseUpstreamTopicTrailers,
  pickDecisionFields,
  serializeLedgerFiles,
  topicIdFor,
  validateLedger,
  validateProvenance,
  type IntervalFile,
  type LegacyBatchFile,
  type Rules,
  type UpstreamLedger,
} from "./upstreamPorts";

const sha = (seed: string | number) => String(seed).padStart(40, "0").slice(-40);
const ARCHIVE_TARGET = sha("a0");

const RULES: Rules = {
  schemaVersion: 1,
  reasonKeys: ["mobile", "maintenance", "reverted", "declined-by-policy"],
  reasonLabels: {
    mobile: "Mobile app only",
    maintenance: "No user-visible behavior change",
    reverted: "Reverted upstream",
    "declined-by-policy": "Declined by f5 product policy",
  },
  upstreamOnlySubsystems: ["auth-scopes"],
  ignoredPathPrefixes: [".repos/"],
  autoSkip: [
    { reasonKey: "mobile", pathPrefixes: ["apps/mobile/"] },
    { reasonKey: "maintenance", pathPrefixes: ["docs/"], pathSuffixes: [".md"] },
  ],
  autoSkipConfidence: 0.85,
};

function topic(id: string, overrides: Partial<UpstreamTopic> = {}): UpstreamTopic {
  return {
    id,
    createdAt: "2026-10-20T07:00:00.000Z",
    title: `Topic ${id}`,
    summary: "",
    upstreamPrs: [],
    status: "inbox",
    epoch: 1,
    ...overrides,
  };
}

function interval(
  number: number,
  baseSha: string,
  commits: ReadonlyArray<{ sha: string; topic: string; subject?: string }>,
): IntervalFile {
  return {
    schemaVersion: 7,
    interval: number,
    baseSha,
    targetSha: commits[0]!.sha,
    selection: "first-parent",
    createdAt: "2026-10-20T07:00:00.000Z",
    count: commits.length,
    digest: digestShas(commits.map((commit) => commit.sha)),
    commits: commits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject ?? `subject ${commit.sha.slice(-4)}`,
      topic: commit.topic,
    })),
  };
}

function legacyBatch(
  number: number,
  commits: ReadonlyArray<{ sha: string; topic: string; subject?: string }>,
): LegacyBatchFile {
  return {
    schemaVersion: 7,
    batch: number,
    createdAt: "2026-10-20T07:00:00.000Z",
    count: commits.length,
    digest: digestShas(commits.map((commit) => commit.sha).toSorted()),
    commits: commits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject ?? `legacy ${commit.sha.slice(-4)}`,
      topic: commit.topic,
    })),
  };
}

const archive = {
  lastTargetSha: ARCHIVE_TARGET,
  deferredSubjects: new Map([[sha("d1"), "legacy 00d1"]]),
};

function baseLedger(): UpstreamLedger {
  return {
    intervals: [
      interval(1, ARCHIVE_TARGET, [
        { sha: sha("b2"), topic: "pr-2" },
        { sha: sha("b1"), topic: "pr-1" },
      ]),
    ],
    legacy: [legacyBatch(1, [{ sha: sha("d1"), topic: "c-0000000000d1" }])],
    topics: [topic("c-0000000000d1"), topic("pr-1"), topic("pr-2")],
  };
}

const validate = (ledger: UpstreamLedger) => validateLedger(ledger, { rules: RULES, archive });

describe("canonicalJson", () => {
  it("is stable across key order and omits absent optional fields", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe(
      canonicalJson({ a: { c: [2, 1] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });

  it("round-trips serialized ledger files byte for byte", () => {
    const files = serializeLedgerFiles(baseLedger());
    const parsed = parseLedgerFiles(files);
    expect(parsed.errors).toEqual([]);
    expect(serializeLedgerFiles(parsed.ledger)).toEqual(files);
  });

  it("rejects null where the schema disallows it and non-canonical bytes", () => {
    const files = serializeLedgerFiles(baseLedger());
    const path = "topics/2026-10.json";
    const value = JSON.parse(files.get(path)!);
    value.topics[0].reason = null;
    const withNull = new Map(files).set(path, canonicalJson(value));
    expect(parseLedgerFiles(withNull).errors.join("\n")).toContain(path);

    const reformatted = new Map(files).set(path, JSON.stringify(JSON.parse(files.get(path)!)));
    expect(parseLedgerFiles(reformatted).errors.join("\n")).toContain("not canonical");
  });

  it("checks file names and month membership", () => {
    const files = serializeLedgerFiles(baseLedger());
    const renamed = new Map(files);
    renamed.set(
      "intervals/0001-wrong.json",
      renamed.get(intervalPath(baseLedger().intervals[0]!))!,
    );
    renamed.delete(intervalPath(baseLedger().intervals[0]!));
    expect(parseLedgerFiles(renamed).errors.join("\n")).toContain("file name must be");

    const ledger = baseLedger();
    const moved = serializeLedgerFiles(ledger);
    const text = moved.get("topics/2026-10.json")!;
    moved.delete("topics/2026-10.json");
    moved.set("topics/2026-09.json", text.replace('"month": "2026-10"', '"month": "2026-09"'));
    expect(parseLedgerFiles(moved).errors.join("\n")).toContain("outside 2026-09");
  });
});

describe("validateLedger", () => {
  it("accepts a valid ledger with inbox topics", () => {
    expect(validate(baseLedger())).toEqual([]);
  });

  it("chains interval 1 from the archive target", () => {
    const ledger = baseLedger();
    const wrongBase = { ...ledger, intervals: [{ ...ledger.intervals[0]!, baseSha: sha("ff") }] };
    expect(validate(wrongBase).join("\n")).toContain("archive's last targetSha");
  });

  it("detects digest and count mismatches", () => {
    const ledger = baseLedger();
    const file = ledger.intervals[0]!;
    expect(
      validate({ ...ledger, intervals: [{ ...file, digest: "0".repeat(64) }] }).join("\n"),
    ).toContain("digest differs");
    expect(validate({ ...ledger, intervals: [{ ...file, count: 3 }] }).join("\n")).toContain(
      "count differs",
    );
  });

  it("rejects a SHA duplicated across interval and legacy files", () => {
    const ledger = baseLedger();
    const dup = {
      ...ledger,
      legacy: [legacyBatch(1, [{ sha: sha("b1"), topic: "c-0000000000d1", subject: "x" }])],
    };
    expect(validateLedger(dup, { rules: RULES }).join("\n")).toContain("appears in both");
  });

  it("rejects non-deferred legacy members", () => {
    const ledger = baseLedger();
    const other = {
      ...ledger,
      legacy: [legacyBatch(1, [{ sha: sha("e1"), topic: "c-0000000000d1" }])],
    };
    expect(validate(other).join("\n")).toContain("not an archive deferred record");
  });

  it("rejects unresolved membership and memberless topics", () => {
    const ledger = baseLedger();
    expect(
      validate({ ...ledger, topics: ledger.topics.filter((t) => t.id !== "pr-1") }).join("\n"),
    ).toContain("unknown topic pr-1");
    expect(validate({ ...ledger, topics: [...ledger.topics, topic("pr-9")] }).join("\n")).toContain(
      "pr-9 has no member commits",
    );
  });

  it("enforces per-status field rules", () => {
    const decided = { decidedBy: "user" as const, decidedAt: "2026-10-21T00:00:00.000Z" };
    const check = (t: UpstreamTopic) => {
      const ledger = baseLedger();
      return validate({
        ...ledger,
        topics: ledger.topics.map((existing) => (existing.id === t.id ? t : existing)),
      }).join("\n");
    };
    expect(check(topic("pr-1", { status: "skip", reason: "x", ...decided }))).toContain(
      "skip requires reasonKey",
    );
    expect(
      check(topic("pr-1", { status: "skip", reasonKey: "unknown", reason: "x", ...decided })),
    ).toContain("unknown reasonKey");
    expect(
      check(
        topic("pr-1", {
          status: "skip",
          reasonKey: "upstream-only:auth-scopes",
          reason: "x",
          ...decided,
        }),
      ),
    ).toBe("");
    expect(
      check(
        topic("pr-1", {
          status: "skip",
          reasonKey: "upstream-only:other",
          reason: "x",
          ...decided,
        }),
      ),
    ).toContain("unknown reasonKey");
    expect(check(topic("pr-1", { status: "declined", ...decided }))).toContain("requires a reason");
    expect(check(topic("pr-1", { status: "skip", reasonKey: "mobile", reason: "x" }))).toContain(
      "requires decidedBy",
    );
    expect(check(topic("pr-1", { status: "inbox", scope: "only the fix" }))).toContain(
      "scope is allowed only with port",
    );
    expect(check(topic("pr-1", { status: "port", scope: "only the fix", ...decided }))).toBe("");
    expect(check(topic("pr-1", { status: "watch", reason: "series", ...decided }))).toContain(
      "watch requires revisitAfter",
    );
    expect(check(topic("pr-1", { status: "equivalent", reason: "x", ...decided }))).toContain(
      "requires equivalence",
    );
    expect(
      check(
        topic("pr-1", {
          status: "equivalent",
          reason: "x",
          equivalence: { f5Refs: ["#12"], evidence: ["../outside.ts:1"] },
          ...decided,
        }),
      ),
    ).toContain("relative path:line");
    expect(
      check(
        topic("pr-1", {
          status: "equivalent",
          reason: "x",
          equivalence: { f5Refs: ["#12", sha("f5")], evidence: ["apps/web/src/a.ts:3"] },
          ...decided,
        }),
      ),
    ).toBe("");
  });

  it("requires a label for every reason key", () => {
    const { reasonLabels, ...rest } = RULES;
    const rules = { ...rest, reasonLabels: { ...reasonLabels, mobile: "" } };
    expect(parseRules(JSON.stringify(rules)).errors.join("\n")).toContain("mobile has no label");
    expect(parseRules(JSON.stringify(RULES)).errors).toEqual([]);
  });

  it("requires the maintenance key when ignored path prefixes are set", () => {
    const { reasonLabels, ...rest } = RULES;
    const { maintenance: _maintenance, ...labels } = reasonLabels;
    const rules = {
      ...rest,
      reasonKeys: RULES.reasonKeys.filter((key) => key !== "maintenance"),
      reasonLabels: labels,
      autoSkip: RULES.autoSkip.filter((rule) => rule.reasonKey !== "maintenance"),
    };
    expect(parseRules(JSON.stringify(rules)).errors.join("\n")).toContain(
      "reasonKeys must include maintenance",
    );
    expect(
      parseRules(JSON.stringify({ ...rules, ignoredPathPrefixes: [] })).errors.join("\n"),
    ).not.toContain("maintenance");
  });

  it("rejects ledger timestamps that are not UTC", () => {
    const ledger = baseLedger();
    const local = {
      ...ledger,
      topics: ledger.topics.map((t) =>
        t.id === "pr-1" ? { ...t, createdAt: "2026-10-21T08:00:00+02:00" } : t,
      ),
    };
    expect(parseLedgerFiles(serializeLedgerFiles(local)).errors.join("\n")).toContain("createdAt");
    expect(parseLedgerFiles(serializeLedgerFiles(ledger)).errors).toEqual([]);
  });
});

describe("evaluateBaseRefRules", () => {
  const ledgerDirs = ["upstream"];
  it("rejects modifying an immutable file and allows adding one", () => {
    expect(
      evaluateBaseRefRules({
        ledgerDirs,
        baseHasArchive: true,
        changes: [{ path: "upstream/intervals/0001-aaaaaaaaaaaa.json", status: "M" }],
      }),
    ).toHaveLength(1);
    expect(
      evaluateBaseRefRules({
        ledgerDirs,
        baseHasArchive: true,
        changes: [
          { path: "upstream/intervals/0002-aaaaaaaaaaaa.json", status: "A" },
          { path: "upstream/topics/2026-10.json", status: "M" },
        ],
      }),
    ).toEqual([]);
    expect(
      evaluateBaseRefRules({
        ledgerDirs,
        baseHasArchive: true,
        changes: [{ path: "upstream/archive/schema6.json", status: "D" }],
      }),
    ).toHaveLength(1);
  });

  it("rejects ledger-state changes mixed with code", () => {
    const errors = evaluateBaseRefRules({
      ledgerDirs,
      baseHasArchive: true,
      changes: [
        { path: "upstream/topics/2026-10.json", status: "M" },
        { path: "apps/web/src/main.tsx", status: "M" },
      ],
    });
    expect(errors.join("\n")).toContain("apps/web/src/main.tsx");
  });

  it("exempts the migration PR whose base has no archive", () => {
    expect(
      evaluateBaseRefRules({
        ledgerDirs,
        baseHasArchive: false,
        changes: [
          { path: "upstream/archive/schema6.json", status: "A" },
          { path: "upstream/topics/2026-10.json", status: "A" },
          { path: "scripts/check-upstream-ports.ts", status: "M" },
        ],
      }),
    ).toEqual([]);
  });

  it("guards the base location when ledgerDir moves", () => {
    expect(
      evaluateBaseRefRules({
        ledgerDirs: ["tracking", "upstream"],
        baseHasArchive: true,
        changes: [
          { path: "upstream/archive/schema6.json", status: "D" },
          { path: "tracking/archive/schema6.json", status: "A" },
        ],
      }).join("\n"),
    ).toContain("upstream/archive/schema6.json is immutable");
  });

  it("allows policy and rules edits alongside code", () => {
    expect(
      evaluateBaseRefRules({
        ledgerDirs,
        baseHasArchive: true,
        changes: [
          { path: "upstream/policy.md", status: "M" },
          { path: "upstream/rules.json", status: "M" },
          { path: "apps/server/src/index.ts", status: "M" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("deriveTopicState", () => {
  const empty = new Map<string, Set<number>>();
  const context = (trailers = empty, activeLinks = empty) => ({
    trailers,
    activeLinks,
    today: "2026-10-21",
  });

  it("lets a current-epoch trailer win over skip", () => {
    const trailers = indexEpochs([{ id: "pr-1", epoch: 1 }]);
    expect(
      deriveTopicState(topic("pr-1", { status: "skip", reasonKey: "mobile" }), context(trailers)),
    ).toBe("done");
  });

  it("ignores old-epoch trailers after a reopen and counts #2", () => {
    const old = indexEpochs([{ id: "pr-1", epoch: 1 }]);
    const reopened = topic("pr-1", { status: "inbox", epoch: 2 });
    expect(deriveTopicState(reopened, context(old))).toBe("inbox");
    expect(deriveTopicState(reopened, context(indexEpochs([{ id: "pr-1", epoch: 2 }])))).toBe(
      "done",
    );
  });

  it("ignores old-epoch links", () => {
    const links = indexEpochs([{ id: "pr-1", epoch: 1 }]);
    expect(
      deriveTopicState(topic("pr-1", { status: "port", epoch: 2 }), context(empty, links)),
    ).toBe("ready");
    expect(deriveTopicState(topic("pr-1", { status: "port" }), context(empty, links))).toBe(
      "in-progress",
    );
  });

  it("treats watch past revisitAfter as inbox", () => {
    expect(
      deriveTopicState(topic("pr-1", { status: "watch", revisitAfter: "2026-10-21" }), context()),
    ).toBe("inbox");
    expect(
      deriveTopicState(topic("pr-1", { status: "watch", revisitAfter: "2026-10-22" }), context()),
    ).toBe("watch");
  });

  it("maps equivalent to done and skip/declined to skipped", () => {
    expect(deriveTopicState(topic("pr-1", { status: "equivalent" }), context())).toBe("done");
    expect(deriveTopicState(topic("pr-1", { status: "declined" }), context())).toBe("skipped");
  });
});

describe("parseUpstreamTopicTrailers", () => {
  it("handles multiple ids, epochs, CRLF, and body paragraphs", () => {
    const text = [
      "Port the composer fix",
      "",
      "Some paragraph text",
      "Upstream-Topic: pr-21027",
      "more text in the same paragraph",
      "Upstream-Topic: c-0123456789ab#3\r",
      "Upstream-Topic: pr-5-abcdef0",
    ].join("\r\n");
    expect(parseUpstreamTopicTrailers(text)).toEqual([
      { id: "pr-21027", epoch: 1 },
      { id: "c-0123456789ab", epoch: 3 },
      { id: "pr-5-abcdef0", epoch: 1 },
    ]);
  });

  it("requires ': ' after the key", () => {
    expect(parseUpstreamTopicTrailers("Upstream-Topic:pr-1\nUpstream-Topic pr-2")).toEqual([]);
  });
});

describe("applyOps and opEffectPresent", () => {
  it("marks a decision merged by content equality (squash-style)", () => {
    const ledger = baseLedger();
    const decided = {
      ...ledger.topics[1]!,
      status: "skip" as const,
      reasonKey: "mobile",
      reason: "Mobile app only",
      decidedBy: "user" as const,
      decidedAt: "2026-10-21T08:00:00.000Z",
    };
    const op = { kind: "decision" as const, topicId: "pr-1", fields: pickDecisionFields(decided) };
    expect(opEffectPresent(ledger, op)).toBe(false);
    const applied = applyOps(ledger, [op]);
    expect(applied.conflicts).toEqual([]);
    // A squash merge reproduces the same bytes; the op's effect is then present.
    const merged = parseLedgerFiles(serializeLedgerFiles(applied.ledger)).ledger;
    expect(opEffectPresent(merged, op)).toBe(true);
  });

  it("ignores a superseded decision by applying only the later one", () => {
    const ledger = baseLedger();
    const at = "2026-10-21T08:00:00.000Z";
    const first = {
      kind: "decision" as const,
      topicId: "pr-1",
      fields: { status: "port" as const, epoch: 1, decidedBy: "user" as const, decidedAt: at },
    };
    const second = {
      kind: "decision" as const,
      topicId: "pr-1",
      fields: {
        status: "watch" as const,
        epoch: 2,
        reason: "Revisit",
        revisitAfter: "2026-11-20",
        decidedBy: "user" as const,
        decidedAt: at,
      },
    };
    const applied = applyOps(ledger, [first, second]).ledger;
    const result = applied.topics.find((t) => t.id === "pr-1")!;
    expect(result.status).toBe("watch");
    expect(result.epoch).toBe(2);
    expect(result.scope).toBeUndefined();
  });

  it("reports an interval number reused with different bytes as a conflict", () => {
    const ledger = baseLedger();
    const other = interval(1, ARCHIVE_TARGET, [{ sha: sha("c1"), topic: "pr-3" }]);
    const applied = applyOps(ledger, [{ kind: "interval", file: other, topics: [topic("pr-3")] }]);
    expect(applied.conflicts.join("\n")).toContain("interval 1 already exists");
  });

  it("appends a new interval and its topics, and treats a replay as a no-op", () => {
    const ledger = baseLedger();
    const next = interval(2, sha("b2"), [{ sha: sha("c1"), topic: "pr-3" }]);
    const op = { kind: "interval" as const, file: next, topics: [topic("pr-3")] };
    const applied = applyOps(ledger, [op]);
    expect(applied.conflicts).toEqual([]);
    expect(validate(applied.ledger)).toEqual([]);
    expect(opEffectPresent(applied.ledger, op)).toBe(true);
    expect(applyOps(applied.ledger, [op]).ledger).toEqual(applied.ledger);
  });

  it("rejects a decision made against an older epoch than the ledger's", () => {
    const ledger = baseLedger();
    const reopened = {
      ...ledger,
      topics: ledger.topics.map((t) => (t.id === "pr-1" ? { ...t, epoch: 2 } : t)),
    };
    const stale = {
      kind: "decision" as const,
      topicId: "pr-1",
      fields: {
        status: "skip" as const,
        epoch: 1,
        reasonKey: "mobile",
        reason: "Mobile app only",
        decidedBy: "user" as const,
        decidedAt: "2026-10-21T08:00:00.000Z",
      },
    };
    const applied = applyOps(reopened, [stale]);
    expect(applied.conflicts.join("\n")).toContain("made at epoch 1, but the ledger is at epoch 2");
    expect(applied.ledger.topics.find((t) => t.id === "pr-1")!.epoch).toBe(2);
  });

  it("names the missing topics when an interval is only partially present", () => {
    const ledger = baseLedger();
    const next = interval(2, sha("b2"), [{ sha: sha("c1"), topic: "pr-3" }]);
    const partial = { ...ledger, intervals: [...ledger.intervals, next] };
    const applied = applyOps(partial, [{ kind: "interval", file: next, topics: [topic("pr-3")] }]);
    expect(applied.conflicts).toEqual(["interval 2 is present, but its topics pr-3 are missing"]);
  });

  it("flags a topic id collision with different content", () => {
    const ledger = baseLedger();
    const next = interval(2, sha("b2"), [{ sha: sha("c1"), topic: "pr-1" }]);
    const applied = applyOps(ledger, [
      { kind: "interval", file: next, topics: [topic("pr-1", { title: "different" })] },
    ]);
    expect(applied.conflicts.join("\n")).toContain("topic id pr-1");
  });
});

describe("topicIdFor", () => {
  it("adds the SHA suffix on collision and is stable when rebuilt", () => {
    const commit = { sha: "abcdef0123456789abcdef0123456789abcdef01", pr: 42 };
    expect(topicIdFor(commit, new Set())).toBe("pr-42");
    expect(topicIdFor(commit, new Set(["pr-42"]))).toBe("pr-42-abcdef0");
    expect(topicIdFor(commit, new Set(["pr-42"]))).toBe("pr-42-abcdef0");
    expect(topicIdFor({ sha: commit.sha }, new Set())).toBe("c-abcdef012345");
  });
});

describe("matchAutoSkipRule", () => {
  it("never matches zero files and treats all-ignored as maintenance", () => {
    expect(matchAutoSkipRule([], RULES)).toBeNull();
    expect(matchAutoSkipRule([".repos/x/y.ts"], RULES)).toBe("maintenance");
  });

  it("matches only when every remaining file matches one rule", () => {
    expect(matchAutoSkipRule(["apps/mobile/a.ts", ".repos/b"], RULES)).toBe("mobile");
    expect(matchAutoSkipRule(["apps/mobile/a.ts", "apps/web/b.ts"], RULES)).toBeNull();
    expect(matchAutoSkipRule(["README.md", "docs/a.txt"], RULES)).toBe("maintenance");
  });
});

describe("buildRevertChains", () => {
  const o = { sha: sha("01"), body: "feat: thing", paths: ["a.ts", "b.ts"] };
  const fullRevert = {
    sha: sha("02"),
    body: `Revert "feat: thing"\n\nThis reverts commit ${sha("01")}.`,
    paths: ["b.ts", "a.ts"],
  };

  it("detects a full [O, R] chain", () => {
    expect(findRevertTarget(fullRevert.body)).toBe(sha("01"));
    expect(buildRevertChains([o, fullRevert])).toEqual([
      {
        root: sha("01"),
        members: [sha("01"), sha("02")],
        full: true,
        depth: 1,
        netEffect: "removed",
        rootInRun: true,
      },
    ]);
  });

  it("marks partial reverts", () => {
    const partial = { ...fullRevert, paths: ["a.ts"] };
    expect(buildRevertChains([o, partial])[0]!.full).toBe(false);
  });

  it("follows a revert of a revert", () => {
    const again = {
      sha: sha("03"),
      body: `Reapply\n\nThis reverts commit ${sha("02")}.`,
      paths: ["a.ts", "b.ts"],
    };
    const [chain] = buildRevertChains([o, fullRevert, again]);
    expect(chain!.members).toEqual([sha("01"), sha("02"), sha("03")]);
    expect(chain!.depth).toBe(2);
    expect(chain!.netEffect).toBe("restored");
  });

  it("resolves cross-interval and archive targets through externalPaths", () => {
    const [known] = buildRevertChains([fullRevert], (target) =>
      target === sha("01") ? ["a.ts", "b.ts"] : null,
    );
    expect(known).toMatchObject({ root: sha("01"), rootInRun: false, full: true });
    const [unknown] = buildRevertChains([fullRevert]);
    expect(unknown).toMatchObject({ rootInRun: false, full: false });
  });
});

describe("validateProvenance", () => {
  it("compares intervals with the first-parent slice and subjects", () => {
    const file = interval(1, ARCHIVE_TARGET, [
      { sha: sha("b2"), topic: "pr-2", subject: "two" },
      { sha: sha("b1"), topic: "pr-1", subject: "one" },
    ]);
    const git = (subjectOfB1: string) => (args: ReadonlyArray<string>) =>
      args[0] === "rev-list"
        ? [sha("b2"), sha("b1"), ARCHIVE_TARGET].join("\n")
        : [`${sha("b2")}\x1ftwo`, `${sha("b1")}\x1f${subjectOfB1}`].join("\n");
    expect(validateProvenance([file], git("one"), "refs/remotes/upstream/main")).toEqual([]);
    expect(validateProvenance([file], git("changed"), "refs/remotes/upstream/main")).toEqual([
      `interval 1: subject differs for ${sha("b1")}`,
    ]);
  });

  it("uses a sorted digest for legacy batches", () => {
    const batch = legacyBatch(1, [
      { sha: sha("f2"), topic: "x" },
      { sha: sha("f1"), topic: "x" },
    ]);
    expect(batch.digest).toBe(digestShas([sha("f1"), sha("f2")]));
    expect(legacyPath(batch)).toBe("legacy/0001.json");
  });
});
