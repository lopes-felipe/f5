import { describe, expect, it } from "vitest";
import { normalizeFallbackPr, normalizeGraphqlPr, buildTrackedPullRequest } from "./discoveryModel";

describe("review request source", () => {
  const reviewers = (names: ReadonlyArray<string>) => ({
    nodes: names.map((name) => ({
      requestedReviewer: name.includes("/") ? { combinedSlug: name } : { login: name },
    })),
  });
  const normalize = (aliases: ReadonlyArray<string>, reviewRequests?: unknown) =>
    normalizeGraphqlPr({
      host: "github.com",
      viewerLogin: "me",
      viewerTeams: new Set(["acme/platform"]),
      aliases: new Set(aliases),
      node: {
        number: 1,
        title: "Test",
        url: "https://github.com/acme/repo/pull/1",
        state: "OPEN",
        repository: { nameWithOwner: "acme/repo" },
        ...(reviewRequests === undefined ? {} : { reviewRequests }),
      },
    })!;
  const many = Array.from({ length: 20 }, (_, index) => `reviewer-${index}`);

  it("does not trust the personal-request search over a complete reviewer list", () => {
    // GitHub's search index lags: after the viewer reviews, the search still returns the
    // pull request although the reviewer list no longer names them.
    for (const list of [[], ["someone-else"], ["acme/platform"]]) {
      const pr = normalize(["direct_review"], reviewers(list));
      expect(pr.roles).not.toContain("review_requested");
      expect(pr.viewerReviewRequested).toBe(list.includes("acme/platform"));
    }
  });

  it("uses the reviewer list when it names the viewer", () => {
    const pr = normalize([], reviewers(["Me"]));
    expect(pr.roles).toContain("review_requested");
    expect(pr.viewerReviewRequested).toBe(true);
  });

  it("lets the searches stand in for a reviewer list that may be cut short or is missing", () => {
    expect(normalize(["direct_review"], reviewers(many)).roles).toContain("review_requested");
    expect(normalize(["direct_review"]).roles).toContain("review_requested");
    const team = normalize(["review_requested"], reviewers(many));
    expect(team.roles).toEqual(expect.arrayContaining(["team_review_requested"]));
    expect(team.roles).not.toContain("review_requested");
  });

  it("reads a fallback row found only by the broad search as a team request", () => {
    const fallback = (aliases: ReadonlyArray<string>) =>
      normalizeFallbackPr({
        host: "github.com",
        viewerLogin: "me",
        aliases: new Set(aliases),
        node: {
          number: 2,
          title: "Fallback",
          url: "https://github.com/acme/repo/pull/2",
          state: "open",
          repository: { nameWithOwner: "acme/repo" },
          author: { login: "teammate" },
        },
      })!;
    const team = fallback(["review_requested"]);
    expect(team.roles).toEqual(["team_review_requested"]);
    expect(team.viewerReviewRequested).toBe(true);
    expect(buildTrackedPullRequest(team, "me", undefined)).toMatchObject({
      attentionState: "team_review_requested",
      attentionBucket: "informational",
      notificationPending: false,
    });
    // The personal search proves a personal request, with or without the broad one.
    for (const aliases of [["direct_review"], ["direct_review", "review_requested"]]) {
      const direct = fallback(aliases);
      expect(direct.roles).toEqual(["review_requested"]);
      expect(buildTrackedPullRequest(direct, "me", undefined).attentionState).toBe(
        "review_requested",
      );
    }
  });
});

describe("repository merge methods", () => {
  it.each([
    [true, "BLOCKED", true],
    [false, "BLOCKED", false],
    [true, "CLEAN", false],
    [true, "HAS_HOOKS", false],
    [true, "UNSTABLE", false],
  ])(
    "advertises auto-merge only when it waits (%s, %s)",
    (autoMergeAllowed, mergeStateStatus, expected) => {
      const pr = normalizeGraphqlPr({
        host: "github.com",
        viewerLogin: "me",
        viewerTeams: new Set(),
        aliases: new Set(["author"]),
        node: {
          number: 1,
          title: "Test",
          url: "https://github.com/acme/repo/pull/1",
          state: "OPEN",
          mergeStateStatus,
          repository: { nameWithOwner: "acme/repo", viewerPermission: "WRITE", autoMergeAllowed },
        },
      })!;
      expect(
        buildTrackedPullRequest(pr, "me", undefined).forgeCapabilities?.actions.includes(
          "enable-auto-merge",
        ),
      ).toBe(expected);
    },
  );
  it.each([
    [
      { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true },
      ["squash", "rebase"],
    ],
    [{ squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: false }, ["merge"]],
    [{}, []],
  ])("advertises only explicitly allowed methods", (methods, expected) => {
    const pr = normalizeGraphqlPr({
      host: "github.com",
      viewerLogin: "me",
      viewerTeams: new Set(),
      aliases: new Set(),
      node: {
        number: 1,
        title: "Test",
        url: "https://github.com/acme/repo/pull/1",
        repository: { nameWithOwner: "acme/repo", ...methods },
      },
    });
    expect(pr?.allowedMergeMethods).toEqual(expected);
  });
});
