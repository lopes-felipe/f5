import { describe, expect, it } from "vitest";
import { peekFactsFromRaw } from "./prHubPeekFacts";

const date = "2026-10-19T12:00:00.000Z";
describe("peekFactsFromRaw", () => {
  it.each([
    ["GitHub", { user: { login: "alice" }, draft: true, created_at: date }],
    ["GitLab", { author: { username: "alice" }, work_in_progress: true, created_at: date }],
    ["Forgejo", { user: { login: "alice" }, draft: true, created_at: date }],
    ["Bitbucket", { author: { display_name: "alice" }, draft: true, created_on: date }],
    ["Azure DevOps", { createdBy: { displayName: "alice" }, isDraft: true, creationDate: date }],
  ])("extracts %s facts", (_, raw) => {
    expect(peekFactsFromRaw({ ...raw, additions: 12, deletions: 3, merged_at: date })).toEqual({
      author: "alice",
      isDraft: true,
      additions: 12,
      deletions: 3,
      createdAt: date,
      mergedAt: date,
    });
  });
  it.each([
    undefined,
    null,
    [],
    "bad",
    {
      user: [],
      author: { username: 4 },
      draft: "true",
      additions: Infinity,
      deletions: "3",
      created_at: "yesterday",
      merged_at: "invalid",
    },
  ])("falls back for malformed payload %j", (raw) => {
    expect(peekFactsFromRaw(raw)).toEqual({
      author: null,
      isDraft: false,
      additions: null,
      deletions: null,
      createdAt: null,
      mergedAt: null,
    });
  });
  it("preserves false and zero, and skips malformed fallback fields", () => {
    expect(
      peekFactsFromRaw({
        user: { login: "" },
        author: { nickname: "nick" },
        draft: false,
        isDraft: true,
        additions: 0,
        deletions: 0,
        created_at: "bad",
        created_on: date,
      }),
    ).toMatchObject({
      author: "nick",
      isDraft: false,
      additions: 0,
      deletions: 0,
      createdAt: date,
    });
  });
});
