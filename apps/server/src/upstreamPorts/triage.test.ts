import type { UpstreamTriageBatchResult, UpstreamTriageGroup } from "@t3tools/contracts";
import { Effect, Semaphore } from "effect";
import { describe, expect, it } from "vitest";

import { TextGenerationError } from "../git/Errors.ts";
import { chunkCommit, SEED_RULES, sha } from "./testFixtures.ts";
import {
  autoDecision,
  batchCommits,
  buildTopics,
  legacyEquivalenceGroups,
  planReverts,
  ProviderUnavailableError,
  triageChunk,
  validateBatchOutput,
  type ChunkCommit,
  type PriorCommit,
  type TriageCall,
} from "./triage.ts";

const revertBody = (target: string) => `Revert "x"\n\nThis reverts commit ${target}.`;

const group = (
  overrides: Partial<UpstreamTriageGroup> & Pick<UpstreamTriageGroup, "commits">,
): UpstreamTriageGroup => ({
  key: `g-${overrides.commits[0]!.slice(0, 6)}`,
  attachTo: null,
  relatedTo: null,
  title: "Group",
  summary: "",
  suggestion: "port",
  reasonKey: null,
  reason: "Useful",
  userImpact: "medium",
  confidence: 0.5,
  areas: [],
  question: null,
  ...overrides,
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const baseInput = (commits: ReadonlyArray<ChunkCommit>, triage: TriageCall | null) => ({
  repository: "https://github.com/pingdotgg/t3code",
  policy: "Port useful desktop changes.",
  rules: SEED_RULES,
  model: "claude-test",
  commits,
  prior: new Map<string, PriorCommit>(),
  openTopics: [],
  attachable: new Set<string>(),
  triage,
  semaphore: Semaphore.makeUnsafe(3),
});

describe("planReverts", () => {
  const original = chunkCommit({ sha: sha(1), paths: ["a.ts", "b.ts"] });

  it("skips a full [O, R] chain inside the run", () => {
    const revert = chunkCommit({ sha: sha(2), paths: ["b.ts", "a.ts"], body: revertBody(sha(1)) });
    const plan = planReverts([original, revert], new Map(), new Set(), SEED_RULES);
    expect(plan.decided).toHaveLength(1);
    expect(plan.decided[0]!.commits).toEqual([sha(1), sha(2)]);
    expect(plan.decided[0]!.decision?.reasonKey).toBe("reverted");
    expect(plan.decided[0]!.decision?.decidedBy).toBe("rule");
  });

  it("sends a partial revert and a revert of a revert to the LLM with the net effect", () => {
    const partial = chunkCommit({ sha: sha(2), paths: ["a.ts"], body: revertBody(sha(1)) });
    expect(
      planReverts([original, partial], new Map(), new Set(), SEED_RULES).llmChains[0],
    ).toMatchObject({
      shas: [sha(1), sha(2)],
      hint: "Revert chain, net effect: removed",
    });
    const revert = chunkCommit({ sha: sha(2), paths: ["a.ts", "b.ts"], body: revertBody(sha(1)) });
    const reapply = chunkCommit({ sha: sha(3), paths: ["a.ts", "b.ts"], body: revertBody(sha(2)) });
    const plan = planReverts([original, revert, reapply], new Map(), new Set(), SEED_RULES);
    expect(plan.llmChains[0]).toMatchObject({
      shas: [sha(1), sha(2), sha(3)],
      hint: "Revert chain, net effect: restored",
    });
  });

  it("attaches a revert of an inbox or watch topic to it", () => {
    const revert = chunkCommit({ sha: sha(2), paths: ["a.ts"], body: revertBody(sha(1)) });
    const prior = new Map<string, PriorCommit>([
      [
        sha(1),
        { kind: "topic", topicId: "pr-5", state: "watch", status: "watch", paths: ["a.ts"] },
      ],
    ]);
    const plan = planReverts([revert], prior, new Set(["pr-5"]), SEED_RULES);
    expect(plan.decided[0]).toMatchObject({ attachTo: "pr-5", commits: [sha(2)] });
  });

  it("raises a high-impact port suggestion when a ported or done change is reverted", () => {
    const revert = chunkCommit({ sha: sha(2), paths: ["a.ts"], body: revertBody(sha(1)) });
    for (const target of [
      { kind: "topic", topicId: "pr-5", state: "done", status: "equivalent", paths: ["a.ts"] },
      { kind: "topic", topicId: "pr-5", state: "ready", status: "port", paths: ["a.ts"] },
      { kind: "archive", disposition: "ported", subject: "Old", paths: ["a.ts"] },
    ] as const) {
      const plan = planReverts([revert], new Map([[sha(1), target]]), new Set(), SEED_RULES);
      expect(plan.decided[0]!.suggestion).toMatchObject({ status: "port", userImpact: "high" });
      expect(plan.decided[0]!.decision).toBeNull();
      if (target.kind === "topic") expect(plan.decided[0]!.related).toEqual(["pr-5"]);
    }
  });

  it("skips a full revert of a skipped or not-applicable change and sends a partial one to the LLM", () => {
    const full = chunkCommit({ sha: sha(2), paths: ["a.ts"], body: revertBody(sha(1)) });
    const skipped: PriorCommit = {
      kind: "topic",
      topicId: "pr-5",
      state: "skipped",
      status: "skip",
      paths: ["a.ts"],
    };
    expect(
      planReverts([full], new Map([[sha(1), skipped]]), new Set(), SEED_RULES).decided[0]!.decision
        ?.reasonKey,
    ).toBe("reverted");
    const archived: PriorCommit = {
      kind: "archive",
      disposition: "not-applicable",
      subject: "Old",
      paths: ["a.ts"],
    };
    expect(
      planReverts([full], new Map([[sha(1), archived]]), new Set(), SEED_RULES).decided[0]!.decision
        ?.reasonKey,
    ).toBe("reverted");
    const partial = planReverts(
      [full],
      new Map([[sha(1), { ...skipped, paths: ["a.ts", "b.ts"] }]]),
      new Set(),
      SEED_RULES,
    );
    expect(partial.decided).toHaveLength(0);
    expect(partial.handled.has(sha(2))).toBe(false);
    expect(partial.hints.get(sha(2))).toContain("pr-5");
  });

  it("hints archived deferred and unknown targets for the LLM", () => {
    const revert = chunkCommit({ sha: sha(2), paths: ["a.ts"], body: revertBody(sha(1)) });
    const deferred: PriorCommit = {
      kind: "archive",
      disposition: "deferred",
      subject: "Old thing",
      paths: ["a.ts"],
    };
    expect(
      planReverts([revert], new Map([[sha(1), deferred]]), new Set(), SEED_RULES).hints.get(sha(2)),
    ).toBe(`reverts archived deferred change ${sha(1).slice(0, 7)}: Old thing`);
    expect(planReverts([revert], new Map(), new Set(), SEED_RULES).hints.get(sha(2))).toContain(
      "unknown",
    );
  });
});

describe("batching and validation", () => {
  it("keeps revert chains in one batch", () => {
    expect(batchCommits([["a"], ["b", "c", "d"], ["e"]], 3)).toEqual([
      ["a"],
      ["b", "c", "d"],
      ["e"],
    ]);
    expect(batchCommits([["a"], ["b"], ["c"]], 2)).toEqual([["a", "b"], ["c"]]);
  });

  it("matches unique prefixes, keeps the first duplicate, drops unknowns and reports omissions", () => {
    const input = [sha(1), sha(2), sha(3)];
    const output: UpstreamTriageBatchResult = {
      groups: [
        group({ commits: [sha(1).slice(0, 12), "f".repeat(40)] }),
        group({ commits: [sha(1), sha(2)], key: "second" }),
      ],
    };
    const validated = validateBatchOutput(input, output, SEED_RULES, "m");
    expect(validated.groups.map((entry) => entry.commits)).toEqual([[sha(1)], [sha(2)]]);
    expect(validated.omitted).toEqual([sha(3)]);
  });

  it("marks unknown reason keys ineligible for auto-skip", () => {
    const validated = validateBatchOutput(
      [sha(1)],
      {
        groups: [
          group({ commits: [sha(1)], suggestion: "skip", reasonKey: "nonsense", confidence: 0.99 }),
        ],
      },
      SEED_RULES,
      "m",
    );
    const suggestion = validated.groups[0]!.suggestion;
    expect(suggestion.reasonKey).toBeUndefined();
    expect(autoDecision({ suggestion, revertChain: false }, SEED_RULES)).toBeNull();
  });

  it("auto-skips only at the threshold with no question, conflict or chain", () => {
    const suggestion = {
      status: "skip" as const,
      reasonKey: "mobile",
      reason: "Mobile only",
      userImpact: "none" as const,
      confidence: SEED_RULES.autoSkipConfidence,
      areas: [],
      model: "m",
    };
    expect(autoDecision({ suggestion, revertChain: false }, SEED_RULES)).toMatchObject({
      decidedBy: "llm",
      reasonKey: "mobile",
    });
    expect(
      autoDecision(
        { suggestion: { ...suggestion, confidence: 0.84 }, revertChain: false },
        SEED_RULES,
      ),
    ).toBeNull();
    expect(
      autoDecision(
        { suggestion: { ...suggestion, question: "Do we ship mobile?" }, revertChain: false },
        SEED_RULES,
      ),
    ).toBeNull();
    expect(
      autoDecision(
        { suggestion: { ...suggestion, conflict: true }, revertChain: false },
        SEED_RULES,
      ),
    ).toBeNull();
    expect(autoDecision({ suggestion, revertChain: true }, SEED_RULES)).toBeNull();
  });
});

describe("triageChunk", () => {
  const commits = [1, 2, 3, 4].map((n) => chunkCommit({ sha: sha(n) }));

  it("applies path rules before the LLM and never sends rule-skipped commits", async () => {
    const seen: string[] = [];
    const mobile = chunkCommit({ sha: sha(9), paths: ["apps/mobile/app.tsx"] });
    const result = await run(
      triageChunk(
        baseInput([mobile, ...commits.slice(0, 1)], (prompt) => {
          seen.push(prompt);
          return Effect.succeed({ groups: [group({ commits: [sha(1)] })] });
        }),
      ),
    );
    expect(seen.join("\n")).not.toContain(sha(9));
    const skip = result.groups.find((entry) => entry.commits.includes(sha(9)))!;
    expect(skip.decision).toMatchObject({ reasonKey: "mobile", decidedBy: "rule" });
  });

  it("runs rules only without a triage call", async () => {
    const result = await run(triageChunk(baseInput(commits, null)));
    expect(result.llmCalls).toBe(0);
    expect(result.groups).toHaveLength(4);
    expect(
      result.groups.every((entry) => entry.decision === null && entry.suggestion === null),
    ).toBe(true);
  });

  it("splits a timed-out batch once, then falls back to inbox per commit", async () => {
    const sizes: number[] = [];
    const call: TriageCall = (prompt) => {
      const count = commits.filter((commit) => prompt.includes(commit.sha)).length;
      sizes.push(count);
      if (count === 4 || prompt.includes(sha(3)))
        return Effect.fail(
          new TextGenerationError({ operation: "t", detail: "slow", kind: "timeout" }),
        );
      return Effect.succeed({
        groups: [
          group({ commits: commits.filter((c) => prompt.includes(c.sha)).map((c) => c.sha) }),
        ],
      });
    };
    const result = await run(triageChunk({ ...baseInput(commits, call), batchSize: 4 }));
    expect(sizes).toEqual([4, 2, 2]);
    const fallback = result.groups.filter((entry) => entry.suggestion?.triageError);
    expect(fallback.map((entry) => entry.commits[0])).toEqual([sha(3), sha(4)]);
    expect(fallback.every((entry) => entry.decision === null)).toBe(true);
  });

  it("opens the circuit after three consecutive provider failures", async () => {
    const call: TriageCall = () =>
      Effect.fail(new TextGenerationError({ operation: "t", detail: "down", kind: "unavailable" }));
    const exit = await Effect.runPromiseExit(
      triageChunk({ ...baseInput(commits, call), batchSize: 1, concurrency: 1 }),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("ProviderUnavailableError");
    expect(ProviderUnavailableError.name).toBe("ProviderUnavailableError");
    const error = await Effect.runPromise(
      Effect.flip(triageChunk({ ...baseInput(commits, call), batchSize: 1, concurrency: 1 })),
    );
    expect(error.llmCalls).toBe(3);
  });

  it("stops calling at the remaining budget and deadline, sending the rest to the inbox", async () => {
    let calls = 0;
    const call: TriageCall = (prompt) => {
      calls += 1;
      return Effect.succeed({
        groups: [
          group({ commits: commits.filter((c) => prompt.includes(c.sha)).map((c) => c.sha) }),
        ],
      });
    };
    const budgeted = await run(
      triageChunk({
        ...baseInput(commits, call),
        batchSize: 1,
        budget: { calls: 2, deadlineAt: Number.POSITIVE_INFINITY, now: () => 0 },
      }),
    );
    expect(calls).toBe(2);
    expect(budgeted.llmCalls).toBe(2);
    const fallback = budgeted.groups.filter((entry) => entry.suggestion?.triageError);
    expect(fallback).toHaveLength(commits.length - 2);
    expect(fallback[0]!.suggestion?.triageError).toContain("call budget");

    calls = 0;
    let clock = 0;
    const late = await run(
      triageChunk({
        ...baseInput(commits, (prompt) => {
          clock = 10;
          return call(prompt);
        }),
        batchSize: 1,
        concurrency: 1,
        budget: { calls: 100, deadlineAt: 5, now: () => clock },
      }),
    );
    expect(calls).toBe(1);
    expect(
      late.groups.filter((entry) => entry.suggestion?.triageError)[0]!.suggestion?.triageError,
    ).toContain("deadline");
  });

  it("attaches later waves to earlier new groups and marks disagreeing merges as conflicts", async () => {
    const call: TriageCall = (prompt) => {
      if (prompt.includes(sha(1)))
        return Effect.succeed({
          groups: [group({ key: "settings", commits: [sha(1)], suggestion: "port" })],
        });
      return Effect.succeed({
        groups: [
          group({
            key: "followup",
            commits: [sha(2)],
            attachTo: "settings",
            suggestion: "skip",
            reasonKey: "maintenance",
            confidence: 0.99,
          }),
        ],
      });
    };
    const result = await run(
      triageChunk({ ...baseInput(commits.slice(0, 2), call), batchSize: 1, concurrency: 1 }),
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.commits).toEqual([sha(1), sha(2)]);
    expect(result.groups[0]!.suggestion).toMatchObject({ status: "port", conflict: true });
    expect(result.groups[0]!.decision).toBeNull();
  });

  it("keeps a same-status follow-up's lower confidence and question, so it is not auto-skipped", async () => {
    const skip = { suggestion: "skip" as const, reasonKey: "maintenance" };
    const call: TriageCall = (prompt) =>
      Effect.succeed({
        groups: prompt.includes(sha(1))
          ? [group({ key: "cleanup", commits: [sha(1)], ...skip, confidence: 0.99 })]
          : [
              group({
                key: "followup",
                commits: [sha(2)],
                attachTo: "cleanup",
                ...skip,
                confidence: 0.4,
                question: "Does this remove a setting F5 still uses?",
              }),
            ],
      });
    const result = await run(
      triageChunk({ ...baseInput(commits.slice(0, 2), call), batchSize: 1, concurrency: 1 }),
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.suggestion).toMatchObject({
      status: "skip",
      confidence: 0.4,
      question: "Does this remove a setting F5 still uses?",
    });
    expect(result.groups[0]!.suggestion?.conflict).toBeUndefined();
    expect(result.groups[0]!.decision).toBeNull();
  });

  it("turns an attach to a non-attachable topic into a related topic and keeps questions", async () => {
    const call: TriageCall = () =>
      Effect.succeed({
        groups: [
          group({ commits: [sha(1)], attachTo: "pr-77", question: "Is the old flow still used?" }),
        ],
      });
    const result = await run(triageChunk(baseInput(commits.slice(0, 1), call)));
    expect(result.groups[0]).toMatchObject({ attachTo: null, related: ["pr-77"] });
    expect(result.groups[0]!.suggestion?.question).toBe("Is the old flow still used?");
  });
});

describe("buildTopics", () => {
  it("mints PR ids, re-checks attach targets and maps related keys", () => {
    const commits = [
      chunkCommit({ sha: sha(1), pr: 10 }),
      chunkCommit({ sha: sha(2), pr: 10 }),
      chunkCommit({ sha: sha(3) }),
    ];
    const built = buildTopics({
      groups: [
        {
          key: "a",
          commits: [sha(1)],
          attachTo: null,
          related: [],
          title: "A",
          summary: "",
          suggestion: null,
          decision: null,
          revertChain: false,
        },
        {
          key: "b",
          commits: [sha(2)],
          attachTo: null,
          related: ["a"],
          title: "B",
          summary: "",
          suggestion: null,
          decision: null,
          revertChain: false,
        },
        {
          key: "c",
          commits: [sha(3)],
          attachTo: "pr-1",
          related: [],
          title: "C",
          summary: "",
          suggestion: null,
          decision: null,
          revertChain: false,
        },
      ],
      commits,
      attachable: new Set(),
      existingIds: new Set(["pr-1"]),
      now: "2026-10-22T07:00:00.000Z",
    });
    expect(built.topics.map((entry) => entry.id)).toEqual([
      "pr-10",
      `pr-10-${sha(2).slice(0, 7)}`,
      `c-${sha(3).slice(0, 12)}`,
    ]);
    expect(built.topics[1]!.relatedTopics).toEqual(["pr-10"]);
    expect(built.topics[2]!.relatedTopics).toEqual(["pr-1"]);
    expect(built.membership.get(sha(3))).toBe(`c-${sha(3).slice(0, 12)}`);
    expect(built.inboxCount).toBe(3);
  });

  it("groups legacy records by identical reachable f5 SHAs and never decides them", () => {
    const commits = [1, 2, 3].map((n) => chunkCommit({ sha: sha(n) }));
    const groups = legacyEquivalenceGroups({
      commits,
      f5ShasBySha: new Map([
        [sha(1), [sha(100, "b")]],
        [sha(2), [sha(100, "b")]],
        [sha(3), [sha(101, "b")]],
      ]),
      reachable: new Set([sha(100, "b")]),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ commits: [sha(1), sha(2)], decision: null });
    expect(groups[0]!.suggestion).toMatchObject({
      status: "equivalent",
      confidence: 0.7,
      f5Refs: [sha(100, "b")],
    });
  });
});
