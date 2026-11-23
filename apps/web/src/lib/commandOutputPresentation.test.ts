import { describe, expect, it } from "vitest";

import {
  buildSearchMatcher,
  classifyCommandOutput,
  findMatchRanges,
  languageForPath,
  resolveCommandPath,
  type ClassifyCommandOutputInput,
} from "./commandOutputPresentation";

const CWD = "/repo";

function classify(
  input: Partial<ClassifyCommandOutputInput> & { command: string; output: string },
) {
  return classifyCommandOutput({ status: "completed", cwd: CWD, ...input });
}

describe("classifyCommandOutput: file reads", () => {
  it("numbers a sed range from its start line", () => {
    const result = classify({
      command: "cd apps/web && sed -n 750,752p src/a.tsx",
      output: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    });
    expect(result).toEqual({
      kind: "file",
      displayPath: "src/a.tsx",
      filePath: "/repo/apps/web/src/a.tsx",
      language: languageForPath("a.tsx"),
      code: "const a = 1;\nconst b = 2;\nconst c = 3;",
      lineNumbers: [750, 751, 752],
    });
  });

  it("drops the gutter for compound reads and shortened previews", () => {
    const compound = classify({
      command: "sed -n 1,2p a.ts; sed -n 9,10p a.ts",
      output: "a\nb\nc\nd\n",
    });
    expect(compound).toMatchObject({ kind: "file", lineNumbers: null, code: "a\nb\nc\nd" });
    const shortened = classify({ command: "cat a.ts", output: "a\nb", shortened: true });
    expect(shortened).toMatchObject({ kind: "file", lineNumbers: null });
    expect(classify({ command: "tail -n 2 a.ts", output: "a\nb" })).toMatchObject({
      kind: "file",
      lineNumbers: null,
    });
  });

  it("falls back to plain for reads in different languages", () => {
    expect(classify({ command: "cat a.ts; cat b.py", output: "x\ny" }).kind).toBe("plain");
  });

  it("moves nl -ba / cat -n numbers into the gutter", () => {
    const result = classify({
      command: "nl -ba a.ts | sed -n 20,22p",
      output: "    20\tconst a = 1;\n    21\t\n    22\treturn a;\n",
    });
    expect(result).toMatchObject({
      kind: "file",
      code: "const a = 1;\n\nreturn a;",
      lineNumbers: [20, 21, 22],
    });
    expect(classify({ command: "cat -n a.ts", output: "sed: a.ts: No such file" }).kind).toBe(
      "plain",
    );
  });
});

describe("classifyCommandOutput: search results", () => {
  it("parses grep -n on one file and keeps trailing output plain", () => {
    const result = classify({
      command: `grep -n "plainWorktreeDraft\\|isLocalDraftThread =" ChatView.tsx | head -40; ls | grep -i branch`,
      output: [
        "1428:  const isLocalDraftThread = !isServerThread;",
        "3963:  const plainWorktreeDraft =",
        "BranchToolbar.tsx",
        "",
      ].join("\n"),
    });
    expect(result.kind).toBe("search");
    if (result.kind !== "search") return;
    expect(result.matchCount).toBe(2);
    expect(result.fileCount).toBe(1);
    expect(result.segments).toEqual([
      {
        type: "group",
        displayPath: "ChatView.tsx",
        filePath: "/repo/ChatView.tsx",
        language: languageForPath("ChatView.tsx"),
        showHeader: true,
        lines: [
          {
            lineNumber: 1428,
            text: "  const isLocalDraftThread = !isServerThread;",
            isMatch: true,
            matches: [[8, 28]],
          },
          {
            lineNumber: 3963,
            text: "  const plainWorktreeDraft =",
            isMatch: true,
            matches: [[8, 26]],
          },
        ],
      },
      { type: "plain", text: "BranchToolbar.tsx" },
    ]);
  });

  it("groups ripgrep matches by file", () => {
    const result = classify({
      command: "rg -n useTheme src",
      output: "src/a.ts:3:useTheme()\nsrc/a.ts:9:x useTheme\nsrc/b.tsx:1:useTheme\n",
    });
    expect(result.kind).toBe("search");
    if (result.kind !== "search") return;
    expect(result.fileCount).toBe(2);
    expect(result.segments.map((segment) => segment.type)).toEqual(["group", "group"]);
    expect(result.segments[0]).toMatchObject({
      displayPath: "src/a.ts",
      filePath: "/repo/src/a.ts",
      lines: [{ lineNumber: 3 }, { lineNumber: 9, matches: [[2, 10]] }],
    });
  });

  it("reads context lines and -- separators", () => {
    const result = classify({
      command: "grep -rn -C1 foo src",
      output: "src/a.ts-1-before\nsrc/a.ts:2:foo\n--\nsrc/a.ts:9:foo\n",
    });
    expect(result.kind).toBe("search");
    if (result.kind !== "search") return;
    expect(result.matchCount).toBe(2);
    expect(result.segments).toMatchObject([
      {
        type: "group",
        showHeader: true,
        lines: [
          { lineNumber: 1, isMatch: false, matches: [] },
          { lineNumber: 2, isMatch: true },
        ],
      },
      { type: "separator" },
      { type: "group", showHeader: false, lines: [{ lineNumber: 9 }] },
    ]);
  });

  it("is plain when no line parses", () => {
    expect(classify({ command: "grep -l foo src", output: "src/a.ts\nsrc/b.ts" }).kind).toBe(
      "plain",
    );
  });
});

describe("buildSearchMatcher", () => {
  const ranges = (
    text: string,
    options: Partial<Parameters<typeof buildSearchMatcher>[0]> & { patterns: string[] },
  ) =>
    findMatchRanges(
      text,
      buildSearchMatcher({
        fixedStrings: false,
        ignoreCase: false,
        extendedRegex: false,
        ...options,
      }),
    );

  it("translates basic regex operators and literals", () => {
    expect(ranges("foo bar (x)", { patterns: ["foo\\|bar"] })).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(ranges("call(x)", { patterns: ["call(x)"] })).toEqual([[0, 7]]);
    expect(ranges("aaa", { patterns: ["\\(a\\)\\{2\\}"] })).toEqual([[0, 2]]);
    expect(ranges("a  b", { patterns: ["[[:space:]]+"], extendedRegex: true })).toEqual([[1, 3]]);
  });

  it("escapes fixed strings and honors ignore case", () => {
    expect(ranges("a.b axb", { patterns: ["a.b"], fixedStrings: true })).toEqual([[0, 3]]);
    expect(ranges("Foo foo", { patterns: ["foo"], ignoreCase: true })).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it("gives no marks for invalid or empty-matching patterns", () => {
    expect(
      buildSearchMatcher({
        patterns: ["(?i)foo"],
        fixedStrings: false,
        ignoreCase: false,
        extendedRegex: true,
      }),
    ).toBeNull();
    expect(
      buildSearchMatcher({
        patterns: ["x*"],
        fixedStrings: false,
        ignoreCase: false,
        extendedRegex: true,
      }),
    ).toBeNull();
  });
});

describe("classifyCommandOutput: diffs", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@ function x() {",
    " keep",
    "--- removed line that looks like a header",
    "+added",
    " keep",
    "diff --git a/b.py b/b.py",
    "--- a/b.py",
    "+++ b/b.py",
    "@@ -1 +1,2 @@",
    " x",
    "+y",
    "",
  ].join("\n");

  it("splits files and numbers rows from hunk headers", () => {
    const result = classify({ command: "git diff", output: diff });
    expect(result.kind).toBe("diff");
    if (result.kind !== "diff") return;
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
    expect(result.showLineNumbers).toBe(true);
    expect(result.files.map((file) => file.displayPath)).toEqual(["src/a.ts", "b.py"]);
    expect(result.files[0]?.filePath).toBe("/repo/src/a.ts");
    expect(result.files[0]?.rows.map((row) => [row.kind, row.lineNumber])).toEqual([
      ["meta", null],
      ["meta", null],
      ["meta", null],
      ["meta", null],
      ["hunk", null],
      ["context", 10],
      ["del", 11],
      ["add", 11],
      ["context", 12],
    ]);
    expect(result.files[1]?.rows.slice(-2).map((row) => [row.kind, row.lineNumber])).toEqual([
      ["context", 1],
      ["add", 2],
    ]);
  });

  it("recognizes diff output from other commands and hides numbers when shortened", () => {
    expect(classify({ command: "cat change.patch", output: diff, shortened: true })).toMatchObject({
      kind: "diff",
      showLineNumbers: false,
    });
    expect(classify({ command: "git diff", output: "nothing here" }).kind).toBe("plain");
  });
});

describe("classifyCommandOutput: JSON, ANSI and status", () => {
  it("detects JSON without reformatting it", () => {
    const output = '{\n  "a": [1, 2]\n}\n';
    expect(classify({ command: "gh api repos/x", output })).toEqual({ kind: "json", text: output });
    expect(classify({ command: "echo", output: "{ not json }" }).kind).toBe("plain");
    expect(classify({ command: "echo", output: "[1, 2" }).kind).toBe("plain");
  });

  it("renders ANSI output even when the command failed", () => {
    const result = classify({
      command: "bun run test",
      output: "\x1b[31mFAIL\x1b[0m a.test.ts",
      status: "failed",
    });
    expect(result).toMatchObject({ kind: "ansi", text: "FAIL a.test.ts" });
  });

  it("keeps failed commands plain otherwise", () => {
    expect(classify({ command: "sed -n 1,2p a.ts", output: "a\nb", status: "failed" }).kind).toBe(
      "plain",
    );
    expect(classify({ command: "git diff", output: "", status: "completed" }).kind).toBe("plain");
  });
});

describe("resolveCommandPath", () => {
  it("joins cwd, cd offset and relative paths", () => {
    expect(resolveCommandPath("./src/../a.ts", "/repo", "apps/web")).toBe("/repo/apps/web/a.ts");
    expect(resolveCommandPath("/abs/a.ts", "/repo", null)).toBe("/abs/a.ts");
    expect(resolveCommandPath("a.ts", undefined, null)).toBe("a.ts");
  });
});
