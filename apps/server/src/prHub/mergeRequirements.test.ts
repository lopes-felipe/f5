import { describe, expect, it } from "vitest";
import {
  evaluateMergeRequirements,
  mergePolicyDenial,
  rawReviewGateSatisfied,
} from "./mergeRequirements.ts";
const node = (checks: unknown[] = [], complete = true) => ({
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRef: { branchProtectionRule: null },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: checks,
              totalCount: checks.length,
              pageInfo: { hasNextPage: !complete },
            },
          },
        },
      },
    ],
  },
  reviewThreads: {
    nodes: [{ isResolved: false }],
    totalCount: 1,
    pageInfo: { hasNextPage: false },
  },
});
const required = [
  {
    type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "test", integration_id: 7 }] },
  },
];
describe("effective merge requirements", () => {
  it("accounts for ruleset checks, their required app, pending and missing evidence", () => {
    const check = { name: "test", conclusion: "SUCCESS", checkSuite: { app: { databaseId: 7 } } };
    expect(evaluateMergeRequirements(node([check]), required).mandatorySatisfied).toBe(true);
    expect(evaluateMergeRequirements(node([]), required).checks[0]?.state).toBe("missing");
    expect(
      evaluateMergeRequirements(node([{ ...check, conclusion: "FAILURE" }]), required).checks[0]
        ?.state,
    ).toBe("failure");
    expect(
      evaluateMergeRequirements(
        node([{ ...check, conclusion: null, status: "IN_PROGRESS" }]),
        required,
      ).checks[0]?.state,
    ).toBe("pending");
    expect(
      evaluateMergeRequirements(
        node([{ ...check, checkSuite: { app: { databaseId: 8 } } }]),
        required,
      ).checks[0]?.state,
    ).toBe("missing");
    expect(evaluateMergeRequirements(node([check], false), required).verification).toBe("unknown");
  });
  it("preserves approval with nits unless resolution is mandatory and fails closed on unknown policy", () => {
    expect(evaluateMergeRequirements(node(), []).mandatorySatisfied).toBe(true);
    expect(
      evaluateMergeRequirements(node(), [
        { type: "pull_request", parameters: { required_review_thread_resolution: true } },
      ]).mandatorySatisfied,
    ).toBe(false);
    expect(evaluateMergeRequirements({ ...node(), baseRef: undefined }, []).verification).toBe(
      "unknown",
    );
    expect(
      evaluateMergeRequirements({ ...node(), mergeStateStatus: "UNKNOWN" }, []).mandatorySatisfied,
    ).toBe(false);
    expect(evaluateMergeRequirements(node(), [{ type: "merge_queue" }]).mandatorySatisfied).toBe(
      false,
    );
  });
});

describe("mergePolicyDenial", () => {
  const satisfied = evaluateMergeRequirements(node(), []);
  const allow = { requirements: satisfied, viewerPermission: "WRITE" };

  it("lets a merge through when no review rule applies", () => {
    expect(mergePolicyDenial({ ...allow, reviewDecision: null })).toBeNull();
    expect(mergePolicyDenial({ ...allow, reviewDecision: undefined })).toBeNull();
    expect(mergePolicyDenial({ ...allow, reviewDecision: "APPROVED" })).toBeNull();
  });

  it.each(["REVIEW_REQUIRED", "CHANGES_REQUESTED", "approved", ""])(
    "refuses review decision %j with a review-specific reason",
    (reviewDecision) => {
      expect(mergePolicyDenial({ ...allow, reviewDecision })).toMatch(/approving review/);
      expect(rawReviewGateSatisfied(reviewDecision)).toBe(false);
    },
  );

  it("reports unmet branch requirements and missing write access", () => {
    const blocked = evaluateMergeRequirements(node(), [{ type: "merge_queue" }]);
    expect(mergePolicyDenial({ ...allow, requirements: blocked, reviewDecision: null })).toBe(
      blocked.explanation,
    );
    expect(mergePolicyDenial({ ...allow, viewerPermission: "READ", reviewDecision: null })).toMatch(
      /write access/,
    );
  });
});
