import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  PROJECT_SEARCH_CONTENTS_MAX_LIMIT,
  PROJECT_LIST_ENTRIES_MAX_LIMIT,
  ProjectAuthorizeEntryInput,
  ProjectListEntriesInput,
  ProjectIcon,
  ProjectIssueAssetUrlResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
} from "./project";

const decodeProjectListEntriesInput = Schema.decodeUnknownSync(ProjectListEntriesInput);
const decodeProjectAuthorizeEntryInput = Schema.decodeUnknownSync(ProjectAuthorizeEntryInput);
const decodeProjectSearchContentsInput = Schema.decodeUnknownSync(ProjectSearchContentsInput);
const decodeProjectSearchContentsResult = Schema.decodeUnknownSync(ProjectSearchContentsResult);
const decodeProjectIcon = Schema.decodeUnknownSync(ProjectIcon);

describe("workspace asset URL responses", () => {
  const decode = Schema.decodeUnknownSync(ProjectIssueAssetUrlResult);
  it("accepts only relative URLs on the workspace asset route", () => {
    const entry = { relativePath: "my file.png", expiresAt: 10_000 };
    const url = "/api/workspace-assets/token.sig/my%20file.png";
    expect(decode([null, { ...entry, url }])).toEqual([null, { ...entry, url }]);
    for (const url of [
      "data:text/plain,hello",
      "file:///tmp/document",
      "https://other.example/document",
      "//other.example/document",
      "/api/workspace-assets/token/../../../other",
      "/api/workspace-assets/../file.png",
      "/api/workspace-assets/token/%2e%2E",
      "/api/workspace-assets/token/file.png?redirect=other",
      "/api/workspace-assets/token/file.png#fragment",
      "/api/workspace-assets/token/other\\file.png",
    ]) {
      expect(() => decode([{ ...entry, url }])).toThrow();
    }
  });
});

describe("ProjectIcon", () => {
  it("accepts a bounded project image path", () => {
    expect(decodeProjectIcon({ type: "image", path: " assets/logo.png " })).toEqual({
      type: "image",
      path: "assets/logo.png",
    });
    expect(() => decodeProjectIcon({ type: "image", path: "x".repeat(513) })).toThrow();
  });
  it("accepts the bounded manual icon variants", () => {
    expect(decodeProjectIcon({ type: "lucide", glyph: "rocket", color: "violet" })).toEqual({
      type: "lucide",
      glyph: "rocket",
      color: "violet",
    });
    expect(decodeProjectIcon({ type: "emoji", emoji: " 🧪 " })).toEqual({
      type: "emoji",
      emoji: "🧪",
    });
  });

  it("rejects unsupported glyphs and oversized emoji values", () => {
    expect(() => decodeProjectIcon({ type: "lucide", glyph: "shell", color: "gray" })).toThrow();
    expect(() => decodeProjectIcon({ type: "emoji", emoji: "not an emoji" })).toThrow();
    expect(() => decodeProjectIcon({ type: "emoji", emoji: "x".repeat(17) })).toThrow();
  });
});

describe("ProjectListEntriesInput", () => {
  it("accepts the maximum workspace file tree entry limit", () => {
    const parsed = decodeProjectListEntriesInput({
      cwd: "/repo/project",
      limit: PROJECT_LIST_ENTRIES_MAX_LIMIT,
    });

    expect(parsed.limit).toBe(PROJECT_LIST_ENTRIES_MAX_LIMIT);
  });

  it("rejects workspace file tree entry limits above the maximum", () => {
    expect(() =>
      decodeProjectListEntriesInput({
        cwd: "/repo/project",
        limit: PROJECT_LIST_ENTRIES_MAX_LIMIT + 1,
      }),
    ).toThrow();
  });
});

describe("ProjectAuthorizeEntryInput", () => {
  it("accepts a bounded relative path and optional expected kind", () => {
    expect(
      decodeProjectAuthorizeEntryInput({
        cwd: "/workspace",
        relativePath: "src/index.ts",
        kind: "file",
      }),
    ).toEqual({ cwd: "/workspace", relativePath: "src/index.ts", kind: "file" });
  });
});

describe("ProjectSearchContents", () => {
  it("preserves significant query whitespace and code-point match ranges", () => {
    const input = decodeProjectSearchContentsInput({
      requestId: "request-1",
      projectId: "project-1",
      threadId: "thread-1",
      query: " needle ",
      limit: PROJECT_SEARCH_CONTENTS_MAX_LIMIT,
      caseSensitive: false,
      wholeWord: true,
      useRegex: false,
    });
    expect(input.query).toBe(" needle ");

    expect(
      decodeProjectSearchContentsResult({
        requestId: "request-1",
        matches: [
          {
            path: "src/unicode.ts",
            lineNumber: 4,
            lineContent: "😀 needle",
            matchRanges: [{ start: 2, end: 8 }],
          },
        ],
        truncated: false,
        indexedPathCount: 25_000,
        indexTruncated: true,
      }).matches[0]?.matchRanges,
    ).toEqual([{ start: 2, end: 8 }]);
  });

  it("rejects queries over the bounded result limit", () => {
    expect(() =>
      decodeProjectSearchContentsInput({
        requestId: "request-1",
        projectId: "project-1",
        query: "needle",
        limit: PROJECT_SEARCH_CONTENTS_MAX_LIMIT + 1,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      }),
    ).toThrow();
  });
});
