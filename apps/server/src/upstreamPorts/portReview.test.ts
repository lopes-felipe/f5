import { describe, expect, it } from "vitest";
import {
  nextPortReviewStep,
  parsePortPullRequestUrl,
  portReviewSummary,
  type PortReviewPrLookup,
} from "./portReview.ts";
import {
  REVIEW_PR,
  reviewContext,
  reviewRecord,
  reviewThread,
  reviewWorkflow,
} from "./testing/reviewFixtures.ts";

describe("nextPortReviewStep", () => {
  it.each([
    ["pending", null, "wait"],
    ["submitted", "pending", "wait"],
    ["submitted", "canceled", "skip"],
    ["submitted", "cleared", "skip"],
    ["submitted", "rejected", "skip"],
    ["rejected", null, "skip"],
  ] as const)("missing thread: %s / %s -> %s", (status, disposition, kind) => {
    const ctx = reviewContext({ thread: null, groupSubmissionDisposition: disposition });
    expect(
      nextPortReviewStep(reviewRecord(), { ...ctx, group: { ...ctx.group, status } }).kind,
    ).toBe(kind);
  });

  it.each([
    [{ deletedAt: "now" }, "Port thread deleted"],
    [{ archivedAt: "now" }, "Port thread archived"],
  ])("guards lifecycle changes", (overrides, detail) => {
    expect(
      nextPortReviewStep(reviewRecord(), reviewContext({ thread: reviewThread(overrides) })),
    ).toMatchObject({ kind: "skip", detail });
  });
  it("guards unlinked ports and records cancellation / archiving intent", () => {
    for (const status of ["waiting", "reviewing", "apply_pending", "applying"] as const)
      expect(nextPortReviewStep(reviewRecord({ status }), reviewContext({ links: [] }))).toEqual({
        kind: "skip",
        detail: "Port unlinked",
        cancelRevision: status === "apply_pending" || status === "applying",
        archiveWorkflow: status === "reviewing",
      });
  });
  it("waits for an outcome and skips non PR outcomes", () => {
    const thread = reviewThread();
    expect(
      nextPortReviewStep(reviewRecord(), reviewContext({ thread: { ...thread, latestTurn: null } }))
        .kind,
    ).toBe("wait");
    for (const outcome of [
      "hello",
      "equivalent x:1",
      "not-applicable unsupported",
      "blocked failure",
    ]) {
      const ctx = reviewContext({
        thread: {
          ...thread,
          messages: thread.messages.map((message) => ({
            ...message,
            text: outcome === "hello" ? outcome : "UPSTREAM-OUTCOME: " + outcome,
          })),
        },
      });
      expect(nextPortReviewStep(reviewRecord(), ctx).kind).toBe(
        outcome === "hello" ? "wait" : "skip",
      );
    }
  });
  it("prefers the projected PR and rejects invalid outcome URLs", () => {
    expect(
      nextPortReviewStep(
        reviewRecord(),
        reviewContext({ projectedPrUrl: "https://github.com/o/f5/pull/99" }),
      ),
    ).toEqual({ kind: "startReview", prUrl: "https://github.com/o/f5/pull/99", headSha: "abc" });
    const thread = reviewThread();
    expect(
      nextPortReviewStep(
        reviewRecord(),
        reviewContext({
          thread: {
            ...thread,
            messages: thread.messages.map((m) => ({
              ...m,
              text: "UPSTREAM-OUTCOME: pr https://example.com/o/f5/pull/1",
            })),
          },
        }),
      ),
    ).toMatchObject({ kind: "skip", detail: "Port outcome has no valid pull request URL" });
  });
  it("skips a grouped port whose topics all ended without a PR", () => {
    const thread = reviewThread();
    const ctx = reviewContext({
      thread: {
        ...thread,
        messages: thread.messages.map((message) => ({
          ...message,
          text: "UPSTREAM-OUTCOME pr-1: equivalent src/a.ts:1\nUPSTREAM-OUTCOME pr-2: not-applicable Not used",
        })),
      },
    });
    expect(
      nextPortReviewStep(reviewRecord(), {
        ...ctx,
        group: { ...ctx.group, topicIds: ["pr-1", "pr-2"] },
      }),
    ).toMatchObject({ kind: "skip", detail: "Port ended without a pull request for any topic" });
    expect(
      nextPortReviewStep(reviewRecord(), {
        ...ctx,
        group: { ...ctx.group, topicIds: ["pr-1", "pr-2", "pr-3"] },
      }).kind,
    ).toBe("wait");
  });
  const prLookup = (patch = {}): PortReviewPrLookup => ({
    kind: "found",
    origin: "o/f5",
    pr: {
      number: 42,
      url: REVIEW_PR,
      state: "open",
      headRepoFullName: "o/f5",
      headRef: "f5/upstream-pr-1",
      headSha: "abc",
      ...patch,
    },
  });
  it("pins a matching PR, skips closed PRs and rejects foreign heads", () => {
    expect(
      nextPortReviewStep(reviewRecord(), reviewContext({ prLookup: prLookup() })),
    ).toMatchObject({ kind: "startReview", headSha: "abc" });
    for (const state of ["closed", "merged"])
      expect(
        nextPortReviewStep(reviewRecord(), reviewContext({ prLookup: prLookup({ state }) })),
      ).toMatchObject({ kind: "skip" });
    for (const mismatch of [{ headRepoFullName: "foreign/f5" }, { headRef: "main" }])
      expect(
        nextPortReviewStep(reviewRecord(), reviewContext({ prLookup: prLookup(mismatch) })),
      ).toMatchObject({ kind: "fail", stage: "review-setup" });
    expect(
      nextPortReviewStep(
        reviewRecord(),
        reviewContext({ prLookup: { kind: "error", transient: true, detail: "offline" } }),
      ),
    ).toEqual({ kind: "wait", detail: "offline" });
  });
  it("resumes missing workflows and reviewer threads; handles deletion, archive and empty reports", () => {
    const row = reviewRecord({ status: "reviewing", prUrl: REVIEW_PR });
    expect(nextPortReviewStep(row, reviewContext())).toEqual({ kind: "createWorkflow" });
    expect(
      nextPortReviewStep(
        row,
        reviewContext({ workflow: reviewWorkflow(), reviewerThreadsMissing: true }),
      ),
    ).toEqual({ kind: "createWorkflow" });
    expect(
      nextPortReviewStep(
        row,
        reviewContext({ workflow: { ...reviewWorkflow(), deletedAt: "now" } }),
      ),
    ).toMatchObject({ kind: "fail", stage: "review" });
    expect(
      nextPortReviewStep(
        row,
        reviewContext({ workflow: { ...reviewWorkflow(), archivedAt: "now" } }),
      ),
    ).toMatchObject({ kind: "skip" });
    expect(
      nextPortReviewStep(row, reviewContext({ workflow: reviewWorkflow(true) })),
    ).toMatchObject({
      kind: "fail",
      stage: "review",
      detail: "Review completed with an empty report",
    });
  });
  it("requires a fresh review after head movement but ignores base movement", () => {
    const row = reviewRecord({ status: "reviewing", prUrl: REVIEW_PR, reviewedHeadSha: "abc" });
    const ctx = reviewContext({
      workflow: reviewWorkflow(true),
      report: "Fix the bug",
      prLookup: prLookup({ headSha: "def" }),
    });
    expect(nextPortReviewStep(row, ctx)).toMatchObject({
      kind: "fail",
      stage: "review",
      detail: expect.stringContaining("abc→def"),
    });
    expect(
      nextPortReviewStep(row, { ...ctx, prLookup: prLookup({ baseRef: "new-base" }) }),
    ).toEqual({ kind: "prepareApply" });
    expect(
      nextPortReviewStep(row, {
        ...ctx,
        prLookup: { kind: "error", transient: true, detail: "offline" },
      }),
    ).toEqual({ kind: "wait", detail: "offline" });
  });
  it("stops retrying a submission after three failures", () => {
    expect(nextPortReviewStep(reviewRecord({ status: "apply_pending" }), reviewContext())).toEqual({
      kind: "submit",
    });
    expect(
      nextPortReviewStep(
        reviewRecord({ status: "apply_pending", submitFailures: 3 }),
        reviewContext(),
      ),
    ).toMatchObject({ kind: "fail", stage: "apply-feedback" });
  });
  it("never applies a report without a successful lookup and two known matching heads", () => {
    const row = reviewRecord({ status: "reviewing", reviewedHeadSha: "abc", prUrl: REVIEW_PR });
    const ctx = reviewContext({ workflow: reviewWorkflow(true), report: "Fix it" });
    for (const [lookup, kind] of [
      [{ kind: "unavailable" }, "wait"],
      [{ kind: "error", transient: true, detail: "rate limited" }, "wait"],
      [{ kind: "error", transient: false, detail: "forbidden" }, "fail"],
      [{ kind: "found", origin: "o/f5", pr: null }, "fail"],
      [prLookup({ headSha: undefined }), "fail"],
    ] as const)
      expect(nextPortReviewStep(row, { ...ctx, prLookup: lookup }).kind).toBe(kind);
    expect(nextPortReviewStep({ ...row, reviewedHeadSha: null }, ctx).kind).toBe("fail");
    expect(
      nextPortReviewStep(reviewRecord(), reviewContext({ prLookup: { kind: "unavailable" } })).kind,
    ).toBe("wait");
  });
  it("uses a projected PR after an interrupted turn and makes failed ports retryable", () => {
    for (const state of ["interrupted", "error"] as const) {
      const ctx = reviewContext({
        thread: reviewThread({ latestTurn: { ...reviewThread().latestTurn!, state } }),
      });
      expect(nextPortReviewStep(reviewRecord(), ctx)).toMatchObject({
        kind: "fail",
        stage: "review-setup",
      });
      expect(nextPortReviewStep(reviewRecord(), { ...ctx, projectedPrUrl: REVIEW_PR }).kind).toBe(
        "startReview",
      );
    }
    for (const segment of ['bad"repo', "bad`repo", "bad(repo)", "bad<repo>"])
      expect(parsePortPullRequestUrl("https://github.com/o/" + segment + "/pull/1")).toBeNull();
  });
  it.each([
    ["queued", "wait"],
    ["preparing-worktree", "wait"],
    ["blocked", "wait"],
    ["running", "wait"],
    ["awaiting-input", "wait"],
    ["awaiting-approval", "wait"],
    ["completed", "complete"],
    ["interrupted", "fail"],
    ["failed", "fail"],
    ["rejected", "fail"],
  ] as const)("maps submission %s to %s", (status, kind) => {
    expect(
      nextPortReviewStep(
        reviewRecord({ status: "applying" }),
        reviewContext({ submission: { status, reason: "reason" } }),
      ).kind,
    ).toBe(kind);
  });
  it("reports workflow errors through Open review, and maps private pending state", () => {
    const workflow = reviewWorkflow();
    expect(
      portReviewSummary(reviewRecord({ status: "reviewing" }), {
        ...workflow,
        reviewerA: { ...workflow.reviewerA, status: "error", error: "failed" },
      }),
    ).toMatchObject({ status: "error", retryable: false });
    expect(
      portReviewSummary(reviewRecord({ status: "apply_pending", detail: "offline" })),
    ).toMatchObject({ status: "applying", detail: "offline" });
    expect(portReviewSummary(reviewRecord({ status: "skipped" })).retryable).toBe(true);
  });
});
