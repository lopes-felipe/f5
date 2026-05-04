import { describe, expect, it } from "vitest";

import {
  compareRankedSearchResults,
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  scoreSubsequenceMatch,
  type RankedSearchResult,
} from "./searchRanking";

function score(value: string, query: string): number | null {
  return scoreQueryMatch({
    value,
    query,
    exactBase: 0,
    prefixBase: 10,
    boundaryBase: 20,
    includesBase: 30,
    fuzzyBase: 100,
  });
}

describe("normalizeSearchQuery", () => {
  it("trims, lowercases, and optionally removes a leading pattern", () => {
    expect(normalizeSearchQuery("  Claude Sonnet  ")).toBe("claude sonnet");
    expect(normalizeSearchQuery("  /Model  ", { trimLeadingPattern: /^\//u })).toBe("model");
  });
});

describe("scoreSubsequenceMatch", () => {
  it("scores compact subsequence matches ahead of sparse matches", () => {
    const compact = scoreSubsequenceMatch("gpt-5.3-codex", "g53");
    const sparse = scoreSubsequenceMatch("general-purpose-text-5-3", "g53");

    expect(compact).not.toBeNull();
    expect(sparse).not.toBeNull();
    expect(compact!).toBeLessThan(sparse!);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(scoreSubsequenceMatch("sonnet", "xyz")).toBeNull();
  });
});

describe("scoreQueryMatch", () => {
  it("orders exact, prefix, boundary, includes, and fuzzy matches by score class", () => {
    const exact = score("sonnet", "sonnet");
    const prefix = score("sonnet 4.6", "son");
    const boundary = score("claude sonnet", "son");
    const includes = score("claudesonnet", "son");
    const fuzzy = score("claude sonnet", "csn");

    expect(exact).toBe(0);
    expect(prefix).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(includes).not.toBeNull();
    expect(fuzzy).not.toBeNull();
    expect(prefix!).toBeLessThan(boundary!);
    expect(boundary!).toBeLessThan(includes!);
    expect(includes!).toBeLessThan(fuzzy!);
  });

  it("returns null when no enabled matching strategy matches", () => {
    expect(score("opus", "xyz")).toBeNull();
  });
});

describe("ranked result ordering", () => {
  it("compares by score and then tie-breaker", () => {
    expect(
      compareRankedSearchResults(
        { item: "b", score: 1, tieBreaker: "beta" },
        { item: "a", score: 1, tieBreaker: "alpha" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareRankedSearchResults(
        { item: "a", score: 0, tieBreaker: "zeta" },
        { item: "b", score: 1, tieBreaker: "alpha" },
      ),
    ).toBeLessThan(0);
  });

  it("inserts candidates into a bounded sorted result set", () => {
    const ranked: RankedSearchResult<string>[] = [
      { item: "a", score: 10, tieBreaker: "a" },
      { item: "c", score: 30, tieBreaker: "c" },
    ];

    insertRankedSearchResult(ranked, { item: "b", score: 20, tieBreaker: "b" }, 3);
    insertRankedSearchResult(ranked, { item: "z", score: 40, tieBreaker: "z" }, 3);
    insertRankedSearchResult(ranked, { item: "aa", score: 10, tieBreaker: "aa" }, 3);

    expect(ranked.map((entry) => entry.item)).toEqual(["a", "aa", "b"]);
  });

  it("does nothing when the limit is zero", () => {
    const ranked: RankedSearchResult<string>[] = [];
    insertRankedSearchResult(ranked, { item: "a", score: 0, tieBreaker: "a" }, 0);
    expect(ranked).toEqual([]);
  });
});
