import type { GitStatusResult, ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveThreadPullRequests,
  summarizeThreadPullRequestState,
  threadPullRequestTooltipLines,
} from "./threadPullRequests";

const branchPr = (
  number: number,
  state: "open" | "closed" | "merged",
): NonNullable<GitStatusResult["pr"]> => ({
  number,
  title: `Branch ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  baseBranch: "main",
  headBranch: "feature",
  state,
});

const link = (number: number, repository = "o/r"): ThreadPullRequestLink => ({
  provider: "github",
  host: "github.com",
  repository,
  number,
  title: `Link ${number}`,
  url: `https://github.com/${repository}/pull/${number}`,
});

describe("resolveThreadPullRequests", () => {
  it("merges the branch PR with a link for the same PR, keeping the branch state", () => {
    const items = resolveThreadPullRequests({
      branchPr: branchPr(5, "merged"),
      links: [link(5)],
      linkState: () => ({ state: "open", title: "Stale" }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ number: 5, state: "merged", source: "branch", linked: true });
  });

  it("marks a branch-only PR as not unlinkable", () => {
    const [item] = resolveThreadPullRequests({
      branchPr: branchPr(5, "open"),
      links: [],
      linkState: () => undefined,
    });
    expect(item).toMatchObject({ source: "branch", linked: false });
    expect(item?.ref).toMatchObject({ repository: "o/r", number: 5 });
  });

  it("orders open PRs first, then newest, and leaves out unresolved links", () => {
    const states = new Map([
      [link(3).url, { state: "merged" as const, title: "Three" }],
      [link(2).url, { state: "open" as const, title: "Two" }],
    ]);
    const items = resolveThreadPullRequests({
      branchPr: branchPr(9, "closed"),
      links: [link(4), link(3), link(2)],
      linkState: (url) => states.get(url),
    });
    expect(items.map((item) => [item.number, item.state])).toEqual([
      [2, "open"],
      [9, "closed"],
      [3, "merged"],
    ]);
    expect(items.find((item) => item.number === 2)?.title).toBe("Two");
  });
});

describe("summaries", () => {
  it("picks the most actionable state", () => {
    const items = resolveThreadPullRequests({
      branchPr: branchPr(1, "closed"),
      links: [link(2)],
      linkState: () => ({ state: "merged", title: "Two" }),
    });
    expect(summarizeThreadPullRequestState(items)).toBe("merged");
    expect(summarizeThreadPullRequestState([])).toBeNull();
  });

  it("lists five PRs, then a remainder count", () => {
    const items = resolveThreadPullRequests({
      branchPr: null,
      links: [1, 2, 3, 4, 5, 6, 7].map((number) => link(number)),
      linkState: () => ({ state: "open", title: "T" }),
    });
    const lines = threadPullRequestTooltipLines(items);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("#1 open · T");
    expect(lines[5]).toBe("+2 more");
  });
});
