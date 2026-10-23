import { describe, expect, it } from "vitest";
import {
  F5_PULL_REQUEST_REFERENCE_MIME,
  formatPullRequestReference,
  parsePullRequestReference,
  pullRequestReferenceMatches,
  readPullRequestReferenceDrag,
  writePullRequestReferenceDrag,
} from "./pullRequestReference";
import {
  collectComposerMentionPaths,
  doesSelectionTouchInlineToken,
  materializeComposerPrompt,
  splitPromptIntoComposerSegments,
  filterComposerTerminalPlaceholders,
} from "../composer-editor-mentions";
import { collapseExpandedComposerCursor, expandCollapsedComposerCursor } from "../composer-logic";
const url = "https://github.com/org/repo/pull/7";
const raw = `[PR #7](${url})`;
const transfer = () => {
  const values = new Map<string, string>();
  return {
    effectAllowed: "none" as DataTransfer["effectAllowed"],
    get types() {
      return [...values.keys()];
    },
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => {
      values.set(type, value);
    },
  };
};
describe("PR reference drags", () => {
  it("serializes a bounded internal reference with useful external fallbacks", () => {
    const data = transfer();
    expect(writePullRequestReferenceDrag(data, url)).toBe(true);
    expect(readPullRequestReferenceDrag(data)).toBe(raw);
    expect(data.effectAllowed).toBe("copy");
    expect(data.getData("text/plain")).toBe(raw);
    expect(data.getData("text/uri-list")).toBe(url);
  });
  it.each([
    "null",
    "{}",
    "[]",
    "malformed",
    JSON.stringify({ version: 2, url }),
    JSON.stringify({ version: 1, url: "javascript:alert(1)" }),
    "x".repeat(5000),
  ])("rejects an invalid drag without interpreting it as plain text", (value) => {
    const data = transfer();
    data.setData(F5_PULL_REQUEST_REFERENCE_MIME, value);
    expect(readPullRequestReferenceDrag(data)).toBeNull();
  });
  it.each([
    "http://github.com/org/repo/pull/7",
    "https://user:secret@github.com/org/repo/pull/7",
    "https://github.com/org/repo/pull/0",
    "https://github.com/org/repo/pull/7\n",
    "https://github.com/org/repo/pull/7/(bad)",
  ])("rejects unsafe or ambiguous reference source %s", (value) => {
    expect(formatPullRequestReference(value)).toBeNull();
  });
  it("recognizes a self-hosted forge from its path without assuming github.com", () => {
    expect(
      parsePullRequestReference("https://git.example/group/sub/repo/-/merge_requests/4"),
    ).toMatchObject({ provider: "gitlab", repository: "group/sub/repo", number: 4 });
    expect(parsePullRequestReference("https://code.example/team/repo/pulls/9")).toMatchObject({
      provider: "forgejo",
      number: 9,
    });
  });
});
describe("PR reference chips", () => {
  it("retains the complete reference in prompt materialization without granting file access", () => {
    const prompt = `Check ${raw} please`;
    expect(splitPromptIntoComposerSegments(prompt).map((part) => part.type)).toEqual([
      "text",
      "pull-request",
      "text",
    ]);
    expect(materializeComposerPrompt(prompt, [], [])).toEqual({ prompt, mentions: [] });
    expect(filterComposerTerminalPlaceholders(prompt, [], [])).toEqual({ prompt, mentions: [] });
    expect(collectComposerMentionPaths(prompt)).toEqual([]);
    expect(doesSelectionTouchInlineToken(prompt, 6, 7)).toBe(true);
    expect(pullRequestReferenceMatches(`[PR #8](${url})`)).toEqual([]);
  });
  it("treats the reference as one cursor position with the full URL preserved", () => {
    const prompt = `a ${raw} z`;
    expect(collapseExpandedComposerCursor(prompt, 2 + raw.length)).toBe(3);
    expect(expandCollapsedComposerCursor(prompt, 3)).toBe(2 + raw.length);
    expect(expandCollapsedComposerCursor(prompt, 2)).toBe(2);
    expect(collapseExpandedComposerCursor(prompt, prompt.length)).toBe(5);
  });
});
