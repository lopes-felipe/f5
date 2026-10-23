import { describe, expect, it } from "vitest";

import {
  collectMarkdownLinkHrefs,
  isMarkdownFileLinkLabel,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("collectMarkdownLinkHrefs", () => {
  // The regex the scanner replaced; it is quadratic on unterminated brackets.
  const reference = (text: string) =>
    [...text.matchAll(/\[(?:\\.|[^\]\\])*\]\(\s*(<[^>]+>|[^()\s]+)[^)]*\)/g)].flatMap((match) => {
      const raw = match[1];
      if (!raw) return [];
      return [raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw];
    });

  it.each([
    "See [app.ts](./app.ts) and [b](src/b.ts 'title').",
    "[a](<foo)bar> invalid [b](ok)",
    "[a](foo \"mixed title') [b](< >)",
    "[a](<one [b](two)> invalid [c](ok)",
    "[[[nested](src/main.ts) [unfinished",
    "[outer [inner] invalid [valid](src/main.ts)",
    "[bad](missing title [valid](src/main.ts)",
    "```text\n[link](src/main.ts)\n```",
    "[empty]() [valid](src/main.ts 'title')",
    '[angle](<src/My File.ts> "title")',
    "[esc \\] still label](a.ts) \\\\[x](b.ts) [y\\](c.ts)",
    "[a](x [b](y) [c]( \n <d e>\n tail) [f](g(h)i)",
    "[a](<multi\nline>) [b](<>) [c](<) [d]( ) []()",
  ])("matches the previous regex on %j", (text) => {
    expect(collectMarkdownLinkHrefs(text)).toEqual(reference(text));
  });

  it("matches the previous regex on generated bracket soup", () => {
    const alphabet = ["[", "]", "(", ")", "<", ">", "\\", " ", "\n", "a", "'", '"'];
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31);
    for (let round = 0; round < 2_000; round += 1) {
      const text = Array.from({ length: 1 + (next() % 24) }, () => alphabet[next() % 12]).join("");
      expect(collectMarkdownLinkHrefs(text), JSON.stringify(text)).toEqual(reference(text));
    }
  });

  it("stays linear on unterminated brackets and destinations", () => {
    const started = performance.now();
    for (const text of [
      "[".repeat(32_000),
      "[](a".repeat(16_000),
      "[](<a".repeat(16_000),
      "[x](https://e.com/".repeat(8_000),
      "[unfinished item\n".repeat(8_000),
    ])
      expect(collectMarkdownLinkHrefs(text)).toEqual([]);
    // The regex took about 12 seconds for these inputs.
    expect(performance.now() - started).toBeLessThan(500);
  });
});

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

  it("accepts localhost file URLs but rejects remote hosts", () => {
    expect(resolveMarkdownFileLinkTarget("file://localhost/C:/repo/main.ts#L4")).toBe(
      "C:/repo/main.ts:4",
    );
    expect(resolveMarkdownFileLinkTarget("file://server/share/main.ts")).toBeNull();
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});

describe("isMarkdownFileLinkLabel", () => {
  it.each([
    ["validates the input", "/repo/src/example.ts:12", false],
    ["read src/example.ts", "/repo/src/example.ts:12", false],
    ["example.ts?why this matters", "/repo/src/example.ts", false],
    ["example.ts", "/repo/src/example.ts:12", true],
    ["example.ts:12", "/repo/src/example.ts:12", true],
    ["example.ts:99", "/repo/src/example.ts:12", false],
    ["example.ts:12:2", "/repo/src/example.ts:12:2", true],
    ["example.ts:12:3", "/repo/src/example.ts:12:2", false],
    ["example.ts:12", "/repo/src/example.ts", false],
    ["src/example.ts:12", "/repo/src/example.ts:12", true],
    ["./src/example.ts", "/repo/src/example.ts", true],
    ["/repo/src/example.ts", "/repo/src/example.ts", true],
    ["src/", "/home/me/project/src/", true],
    ["EXAMPLE.TS", "C:/repo/src/example.ts:12", true],
    ["file name.ts", "file:///repo/file%20name.ts", true],
    ["", "/repo/src/example.ts", true],
  ])("classifies %s for %s", (label, href, expected) => {
    const meta = resolveMarkdownFileLinkMeta(href);
    expect(meta).not.toBeNull();
    expect(isMarkdownFileLinkLabel(label, meta!)).toBe(expected);
  });
});

describe("resolveMarkdownFileLinkMeta", () => {
  it("returns workspace-relative display path for a plain file path", () => {
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/Users/julius/project")).toEqual({
      filePath: "/Users/julius/project/src/main.ts",
      targetPath: "/Users/julius/project/src/main.ts",
      displayPath: "project/src/main.ts",
      basename: "main.ts",
    });
  });

  it("exposes line and column separately while keeping the full target path", () => {
    expect(resolveMarkdownFileLinkMeta("src/main.ts:42:7", "/Users/julius/project")).toEqual({
      filePath: "/Users/julius/project/src/main.ts",
      targetPath: "/Users/julius/project/src/main.ts:42:7",
      displayPath: "project/src/main.ts",
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

  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath: "t3code/apps/web/src/session-logic.ts",
      line: "501",
    });
  });

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath:
        "t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
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
