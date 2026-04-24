import { describe, expect, it } from "vitest";

import {
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});

describe("resolveMarkdownFileLinkMeta", () => {
  it("returns workspace-relative display path for a plain file path", () => {
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/Users/julius/project")).toEqual({
      filePath: "/Users/julius/project/src/main.ts",
      targetPath: "/Users/julius/project/src/main.ts",
      displayPath: "src/main.ts",
      basename: "main.ts",
    });
  });

  it("exposes line and column separately while keeping the full target path", () => {
    expect(resolveMarkdownFileLinkMeta("src/main.ts:42:7", "/Users/julius/project")).toEqual({
      filePath: "/Users/julius/project/src/main.ts",
      targetPath: "/Users/julius/project/src/main.ts:42:7",
      displayPath: "src/main.ts",
      basename: "main.ts",
      line: "42",
      column: "7",
    });
  });

  it("normalizes file:// URIs to absolute paths", () => {
    const meta = resolveMarkdownFileLinkMeta("file:///Users/julius/project/src/main.ts#L42");
    expect(meta).not.toBeNull();
    expect(meta!.filePath).toBe("/Users/julius/project/src/main.ts");
    expect(meta!.targetPath).toBe("/Users/julius/project/src/main.ts:42");
    expect(meta!.line).toBe("42");
    expect(meta!.basename).toBe("main.ts");
  });

  it("leaves absolute paths outside the workspace as their own display path", () => {
    expect(resolveMarkdownFileLinkMeta("/etc/hosts", "/Users/julius/project")).toEqual({
      filePath: "/etc/hosts",
      targetPath: "/etc/hosts",
      displayPath: "/etc/hosts",
      basename: "hosts",
    });
  });

  it("returns null for external URLs", () => {
    expect(resolveMarkdownFileLinkMeta("https://example.com/docs")).toBeNull();
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("returns non-file URIs unchanged", () => {
    expect(rewriteMarkdownFileUriHref("https://example.com")).toBe("https://example.com");
    expect(rewriteMarkdownFileUriHref("/Users/julius/a.ts")).toBe("/Users/julius/a.ts");
    expect(rewriteMarkdownFileUriHref("")).toBe("");
  });

  it("converts a file:// URI with a line anchor to a path with line suffix", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L12")).toBe(
      "/Users/julius/project/src/main.ts:12",
    );
  });

  it("strips the fake leading slash from Windows-style file URLs", () => {
    expect(rewriteMarkdownFileUriHref("file:///C:/Users/julius/project/main.ts")).toBe(
      "C:/Users/julius/project/main.ts",
    );
  });
});
