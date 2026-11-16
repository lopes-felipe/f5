import { expect, it } from "vitest";
import { decodeWatchFingerprint } from "./pullRequestWatchFingerprint.ts";

function response(
  input: {
    success?: number;
    pending?: number;
    editedAt?: string;
    head?: string;
    reverse?: boolean;
  } = {},
) {
  const counts = [
    { state: "SUCCESS", count: input.success ?? 1 },
    { state: "IN_PROGRESS", count: input.pending ?? 1 },
  ];
  return {
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: input.head ?? "head",
          comments: { totalCount: 1, nodes: [{ lastEditedAt: input.editedAt ?? null }] },
          reviews: { totalCount: 0, nodes: [] },
          reviewThreads: { totalCount: 1 },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      checkRunCountsByState: input.reverse ? counts.reverse() : counts,
                      statusContextCountsByState: [],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}
it("keeps reordered check counts stable while detecting newly passed checks and in-flight reruns", () => {
  const initial = decodeWatchFingerprint(response(), '"etag"');
  expect(decodeWatchFingerprint(response({ reverse: true }), '"etag"')).toEqual(initial);
  expect(decodeWatchFingerprint(response({ success: 2 }), '"etag"').status).not.toBe(
    initial.status,
  );
  expect(decodeWatchFingerprint(response({ pending: 2 }), '"etag"').status).not.toBe(
    initial.status,
  );
  expect(decodeWatchFingerprint(response({ head: "new-head" }), '"etag"').status).not.toBe(
    initial.status,
  );
});
it("detects edited bot comments without requiring a new comment count", () => {
  const initial = decodeWatchFingerprint(response(), '"etag"');
  expect(
    decodeWatchFingerprint(response({ editedAt: "2026-10-19T12:00:00.000Z" }), '"etag"').remarks,
  ).not.toBe(initial.remarks);
  expect(decodeWatchFingerprint(response(), '"changed"').remarks).not.toBe(initial.remarks);
});
it("rejects missing PRs and partial GraphQL errors", () => {
  expect(() =>
    decodeWatchFingerprint({ data: { repository: { pullRequest: null } } }, null),
  ).toThrow();
  expect(() =>
    decodeWatchFingerprint({ ...response(), errors: [{ message: "private detail" }] }, null),
  ).toThrow();
});
