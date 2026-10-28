import { describe, expect, it } from "vitest";
import {
  codeBlockFilePath,
  codeBlockLanguageLabel,
  codeLineCount,
  fileUrlHref,
} from "./codeBlockPresentation";
import { normalizeFenceLanguage } from "./codeHighlightPolicy";

describe("codeBlockLanguageLabel", () => {
  it.each([
    ["ts", "TypeScript"],
    ["typescript", "TypeScript"],
    ["tsx", "TSX"],
    ["mjs", "JavaScript"],
    ["jsx", "JSX"],
    ["py", "Python"],
    ["zsh", "Shell"],
    ["shell-session", "Shell"],
    ["jsonc", "JSON"],
    ["yml", "YAML"],
    ["md", "Markdown"],
    ["patch", "Diff"],
    ["rs", "Rust"],
    ["rb", "Ruby"],
    ["kt", "Kotlin"],
    ["dockerfile", "Dockerfile"],
  ])("labels %s as %s", (language, label) => {
    expect(codeBlockLanguageLabel(normalizeFenceLanguage(language))).toBe(label);
  });

  it("labels a fence without a language, or plain text, as Text", () => {
    expect(codeBlockLanguageLabel(normalizeFenceLanguage(undefined))).toBe("Text");
    expect(codeBlockLanguageLabel(normalizeFenceLanguage("txt"))).toBe("Text");
    expect(codeBlockLanguageLabel("")).toBe("Text");
  });

  it("shows any other language name exactly as written", () => {
    expect(codeBlockLanguageLabel("elixir")).toBe("elixir");
  });
});

describe("codeBlockFilePath", () => {
  it("reads the path after the first colon of the info token", () => {
    expect(codeBlockFilePath("ts:src/a.ts", null)).toBe("src/a.ts");
    expect(codeBlockFilePath("ts:C:/repo/a.ts", "")).toBe("C:/repo/a.ts");
  });

  it("treats a token that is not path-like as a title, not a file", () => {
    expect(codeBlockFilePath("js:example", null)).toBeNull();
    expect(codeBlockFilePath("sh:Makefile", null)).toBeNull();
    expect(codeBlockFilePath("sh:./Makefile", null)).toBe("./Makefile");
    expect(codeBlockFilePath("toml:Cargo.toml", null)).toBe("Cargo.toml");
  });

  it("shows no path when fence meta is present, the suffix is empty, or it is too long", () => {
    // ```ts:src/my file.ts splits into lang `ts:src/my` and meta `file.ts`.
    expect(codeBlockFilePath("ts:src/my", "file.ts")).toBeNull();
    expect(codeBlockFilePath("ts:", null)).toBeNull();
    expect(codeBlockFilePath("ts", null)).toBeNull();
    expect(codeBlockFilePath(`ts:${"a".repeat(254)}.ts`, null)).toBeNull();
    expect(codeBlockFilePath(`ts:${"a".repeat(253)}.ts`, null)).toBe(`${"a".repeat(253)}.ts`);
    expect(codeBlockFilePath(null, null)).toBeNull();
  });
});

describe("codeLineCount", () => {
  it("ignores exactly one trailing newline", () => {
    expect(codeLineCount("a\nb\n")).toBe(2);
    expect(codeLineCount("a\n\n")).toBe(2);
    expect(codeLineCount("a\nb")).toBe(2);
    expect(codeLineCount("")).toBe(0);
  });
});

describe("fileUrlHref", () => {
  it("encodes every path segment, so # and ? stay part of the path", () => {
    expect(fileUrlHref("/repo/src/app.ts")).toBe("file:///repo/src/app.ts");
    expect(fileUrlHref("/tmp/a#b?.ts")).toBe("file:///tmp/a%23b%3F.ts");
    expect(fileUrlHref("/tmp/my file.ts")).toBe("file:///tmp/my%20file.ts");
    expect(fileUrlHref("C:\\repo\\a#1.ts")).toBe("file:///C:/repo/a%231.ts");
  });

  it("gives a relative path no URL", () => {
    expect(fileUrlHref("src/app.ts")).toBeUndefined();
  });
});
