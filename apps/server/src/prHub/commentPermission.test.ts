import { describe, expect, it } from "vitest";

import {
  canViewerCommentOnPullRequest,
  graphqlErrorMessage,
  PR_COMMENT_PERMISSION_PULL_REQUEST_FIELDS,
} from "./commentPermission.ts";

describe("canViewerCommentOnPullRequest", () => {
  it("allows readers on unlocked conversations", () => {
    expect(canViewerCommentOnPullRequest({ locked: false, viewerPermission: "READ" })).toBe(true);
    expect(canViewerCommentOnPullRequest({ locked: false, viewerPermission: null })).toBe(true);
  });

  it("allows only write access on locked conversations", () => {
    expect(canViewerCommentOnPullRequest({ locked: true, viewerPermission: "READ" })).toBe(false);
    expect(canViewerCommentOnPullRequest({ locked: true, viewerPermission: "TRIAGE" })).toBe(false);
    expect(canViewerCommentOnPullRequest({ locked: true, viewerPermission: null })).toBe(false);
    for (const permission of ["WRITE", "MAINTAIN", "ADMIN"]) {
      expect(canViewerCommentOnPullRequest({ locked: true, viewerPermission: permission })).toBe(
        true,
      );
    }
  });

  // GitHub's PullRequest type has no viewerCanComment; querying it rejects
  // the whole query and blocked every PR Hub comment.
  it("queries only fields GitHub's PullRequest type has", () => {
    expect(PR_COMMENT_PERMISSION_PULL_REQUEST_FIELDS).not.toContain("viewerCanComment");
  });
});

describe("graphqlErrorMessage", () => {
  it("returns GitHub's first error message", () => {
    expect(
      graphqlErrorMessage({
        errors: [{ message: "Field 'viewerCanComment' doesn't exist on type 'PullRequest'" }],
      }),
    ).toBe("Field 'viewerCanComment' doesn't exist on type 'PullRequest'");
    expect(graphqlErrorMessage({ data: {} })).toBeNull();
    expect(graphqlErrorMessage(null)).toBeNull();
  });
});
