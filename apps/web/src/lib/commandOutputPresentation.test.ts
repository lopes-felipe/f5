import { describe, expect, it } from "vitest";

import {
  buildSearchMatcher,
  classifyCommandOutput,
  findMatchRanges,
  languageForPath,
  MAX_PRESENTED_LINES,
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
      file: { displayPath: "src/a.tsx", filePath: "/repo/apps/web/src/a.tsx" },
      fileCount: 1,
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

  it("names no single file for reads of several files in one language", () => {
    expect(classify({ command: "cat a.ts; cat b.ts", output: "x\ny" })).toMatchObject({
      kind: "file",
      file: null,
      fileCount: 2,
      lineNumbers: null,
    });
  });

  it("names but does not link a file read after a cd that may have failed", () => {
    expect(
      classify({ command: "cd src && sed -n 1,2p a.ts; sed -n 9,10p a.ts", output: "a\nb\nc\nd" }),
    ).toMatchObject({ kind: "file", file: { displayPath: "a.ts", filePath: null } });
  });

  it("does not count a final line break as an extra row", () => {
    const rows = Array.from({ length: MAX_PRESENTED_LINES }, (_, index) => `row ${index}`);
    expect(classify({ command: "cat a.ts", output: `${rows.join("\n")}\n` }).kind).toBe("file");
    expect(classify({ command: "cat a.ts", output: `${rows.join("\n")}\nextra\n` }).kind).toBe(
      "plain",
    );
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

  it("reads results piped through line filters", () => {
    const single = classify({
      command: `grep -n "Output\\b\\|output" src/a.ts | grep -i -E "command|terminal" | head -40`,
      output: "312:// command output here\n3758:  const terminalOutput = 1;\n",
    });
    expect(single.kind).toBe("search");
    if (single.kind !== "search") return;
    expect(single.segments[0]).toMatchObject({
      filePath: "/repo/src/a.ts",
      lines: [
        { lineNumber: 312, matches: [[11, 17]] },
        { lineNumber: 3758, matches: [[16, 22]] },
      ],
    });

    const recursive = classify({
      command: `grep -rn "stdout" src --include='*.ts' | grep -v test | head -20`,
      output: "src/a.ts:72:  // stdout flag\nsrc/b.ts:9:  const stdout = 1;\n",
    });
    expect(recursive.kind).toBe("search");
    if (recursive.kind !== "search") return;
    expect(recursive.fileCount).toBe(2);
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

  it("keeps unnumbered output plain so dates are not read as line numbers", () => {
    expect(
      classify({ command: "grep ERROR app.log", output: "2026-11-23 10:00 ERROR boom\n" }).kind,
    ).toBe("plain");
    expect(classify({ command: "rg 2026 docs", output: "docs/x.md:2026-11-01 notes\n" }).kind).toBe(
      "plain",
    );
  });

  it("gives grep -h groups no path to open", () => {
    const result = classify({ command: "grep -rnh foo src", output: "3:foo\n9:foo\n" });
    expect(result).toMatchObject({
      kind: "search",
      segments: [
        {
          type: "group",
          displayPath: "",
          filePath: null,
          lines: [{ lineNumber: 3 }, { lineNumber: 9 }],
        },
      ],
    });
  });

  it("names but does not link results after a cd that may have failed", () => {
    expect(classify({ command: "cd src; rg -n foo", output: "a.ts:3:foo\n" })).toMatchObject({
      kind: "search",
      segments: [{ type: "group", displayPath: "a.ts", filePath: null }],
    });
  });

  it("prefers a match row over an ambiguous context reading, or keeps it plain", () => {
    // `a-1-file.ts:9:foo` is a match in a-1-file.ts or line 1 of `a`.
    const result = classify({
      command: "grep -n -C1 foo a a-1-file.ts",
      output: "a:3:foo\na-1-file.ts:9:foo\n",
    });
    expect(result).toMatchObject({
      kind: "search",
      matchCount: 1,
      segments: [
        { type: "group", displayPath: "a" },
        { type: "plain", text: "a-1-file.ts:9:foo" },
      ],
    });
    // Without a competing `a` match, the row is a plain match.
    expect(
      classify({ command: "grep -n foo b a-1-file.ts", output: "a-1-file.ts:9:foo\n" }),
    ).toMatchObject({ kind: "search", matchCount: 1, fileCount: 1 });
  });

  it("keeps output from statements after the search out of the results", () => {
    const result = classify({
      command: "grep -n foo a.ts; printf '12: build complete\\n'",
      output: "40:foo\n12: build complete\n",
    });
    expect(result).toMatchObject({
      kind: "search",
      matchCount: 1,
      segments: [{ type: "group" }, { type: "plain", text: "12: build complete" }],
    });
    // Once a line is not a result, everything after it is that later output.
    const after = classify({
      command: "grep -n foo a.ts; ls",
      output: "4:foo\nnotes.md\n12-notes.md\n",
    });
    expect(after).toMatchObject({
      kind: "search",
      segments: [{ type: "group" }, { type: "plain", text: "notes.md\n12-notes.md" }],
    });
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
        perlRegex: false,
        ...options,
      }),
    );
  const matcher = (pattern: string, extendedRegex = true) =>
    buildSearchMatcher({
      patterns: [pattern],
      fixedStrings: false,
      ignoreCase: false,
      extendedRegex,
      perlRegex: false,
    });

  it("refuses patterns that could backtrack catastrophically", () => {
    expect(matcher("(\\w+\\s?)*=")).toBeNull();
    expect(matcher("(a|ab)+c")).toBeNull();
    expect(matcher("(x+){2,}")).toBeNull();
    expect(matcher(".*.*.*=")).toBeNull();
    expect(matcher("(a)\\1")).toBeNull();
    expect(matcher("\\(a*\\)*", false)).toBeNull();
    expect(
      buildSearchMatcher({
        patterns: ["\\d+"],
        fixedStrings: false,
        ignoreCase: false,
        extendedRegex: true,
        perlRegex: true,
      }),
    ).toBeNull();
    // Optional and bounded repeats count too.
    expect(matcher(`${"a?".repeat(30)}${"a".repeat(30)}`)).toBeNull();
    expect(matcher("(a{0,30}){0,30}")).toBeNull();
    expect(matcher("(a?){30}")).toBeNull();
    expect(matcher("x{0,500}y{0,500}z{0,500}")).toBeNull();
    // Ordinary patterns, including quantifiers and optional groups, still mark.
    expect(matcher("use(Theme|Memo)\\(")).not.toBeNull();
    expect(matcher("\\w+Draft(Thread)?")).not.toBeNull();
    expect(matcher("[(+*)]+x")).not.toBeNull();
    expect(matcher("(?:foo|bar)\\d{2,4}-?x")).not.toBeNull();
    expect(matcher("colou?r .+? done")).not.toBeNull();
  });

  it("matches only the start of very long lines", () => {
    const line = `${"a".repeat(2_000)}needle`;
    expect(findMatchRanges(line, matcher("needle"))).toEqual([]);
    expect(findMatchRanges(`needle${line}`, matcher("needle"))).toEqual([[0, 6]]);
  });

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
        perlRegex: false,
      }),
    ).toBeNull();
    expect(matcher("x?")).toBeNull();
  });
});

describe("classifyCommandOutput: git show reads", () => {
  it("numbers a revision's range but does not link the file on disk", () => {
    const result = classify({
      command: "git show origin/main:src/a.ts | sed -n 2800,2802p",
      output: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    });
    expect(result).toMatchObject({
      kind: "file",
      file: { displayPath: "origin/main:src/a.ts", filePath: null },
      language: "typescript",
      lineNumbers: [2800, 2801, 2802],
    });
  });

  it("is not read as a diff, even when the file holds one", () => {
    const patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    expect(classify({ command: "git show HEAD:notes.md", output: patch })).toMatchObject({
      kind: "file",
      file: { displayPath: "HEAD:notes.md" },
    });
    expect(classify({ command: "git show HEAD:fix.patch", output: patch })).toMatchObject({
      kind: "file",
      lineNumbers: [1, 2, 3, 4, 5, 6],
    });
    // A file on disk that holds a diff still renders as one.
    expect(classify({ command: "cat fix.patch", output: patch }).kind).toBe("diff");
  });
});

describe("classifyCommandOutput: compound commands", () => {
  it("highlights a bounded read and keeps later statements' output plain", () => {
    const result = classify({
      command: `cd /wt && git show origin/main:apps/web/src/a.ts | sed -n 1,3p; ps -axo pid,command | grep -v grep | head -3; echo "env here: \${X:-unset}"`,
      output: 'import a from "a";\n\nexport {};\n123 /Applications/F5.app\nenv here: unset\n',
    });
    expect(result).toMatchObject({
      kind: "sections",
      matchCount: 0,
      sections: [
        {
          type: "file",
          displayPath: "origin/main:apps/web/src/a.ts",
          filePath: null,
          language: "typescript",
          code: 'import a from "a";\n\nexport {};',
          lineNumbers: null,
        },
        { type: "plain", text: "123 /Applications/F5.app\nenv here: unset" },
      ],
    });
  });

  it("splits reads and a git grep over a revision", () => {
    const result = classify({
      command:
        'cd /wt && git show origin/main:main.ts | sed -n 2800,2801p; git show origin/main:ws.ts | sed -n 558,559p; git grep -n "nativeApi" origin/main -- web/nativeApi.ts | head',
      output: [
        "  {",
        '    label: "View",',
        "export function a() {",
        "  return 1;",
        "origin/main:web/nativeApi.ts:12:export const nativeApi = 1;",
        "origin/main:web/nativeApi.ts:40:  nativeApi.call();",
        "",
      ].join("\n"),
    });
    expect(result.kind).toBe("sections");
    if (result.kind !== "sections") return;
    expect(result.matchCount).toBe(2);
    expect(result.sections).toMatchObject([
      { type: "file", displayPath: "origin/main:main.ts", code: '  {\n    label: "View",' },
      {
        type: "file",
        displayPath: "origin/main:ws.ts",
        code: "export function a() {\n  return 1;",
      },
      {
        type: "search",
        fileCount: 1,
        segments: [
          {
            type: "group",
            displayPath: "origin/main:web/nativeApi.ts",
            // The revision's text may differ from the file on disk.
            filePath: null,
            lines: [
              { lineNumber: 12, matches: [[13, 22]] },
              { lineNumber: 40, matches: [[2, 11]] },
            ],
          },
        ],
      },
    ]);
  });

  it("takes nl -ba numbers into the gutter and ends a read at its last numbered line", () => {
    const result = classify({
      command: "nl -ba a.ts | sed -n 1,5p; nl -ba b.py | sed -n 7,8p",
      output: "     1\tconst a = 1;\n     2\tconst b = 2;\n     7\tx = 1\n     8\ty = 2\n",
    });
    expect(result).toMatchObject({
      kind: "sections",
      sections: [
        {
          type: "file",
          filePath: "/repo/a.ts",
          code: "const a = 1;\nconst b = 2;",
          lineNumbers: [1, 2],
        },
        { type: "file", filePath: "/repo/b.py", language: "python", lineNumbers: [7, 8] },
      ],
    });
  });

  it("ends a short read at the next search's first match", () => {
    // `a.ts` has 2 lines, not the 11 the range allows.
    const result = classify({
      command: "sed -n 100,110p a.ts; git grep -n foo",
      output: "const a = 1;\nconst b = 2;\nsrc/x.ts:3:foo()\nsrc/y.ts:9:foo\n",
    });
    expect(result).toMatchObject({
      kind: "sections",
      matchCount: 2,
      sections: [
        { type: "file", filePath: "/repo/a.ts", code: "const a = 1;\nconst b = 2;" },
        { type: "search", fileCount: 2 },
      ],
    });
  });

  it("skips an empty read before a search", () => {
    const result = classify({
      command: "git show HEAD:package.json | sed -n 10000,10001p; git grep -n foo",
      output: "src/x.ts:3:foo()\nsrc/y.ts:9:foo\n",
    });
    expect(result).toMatchObject({
      kind: "sections",
      matchCount: 2,
      sections: [{ type: "search", fileCount: 2 }],
    });
  });

  it("names but does not link a read whose end cannot be confirmed", () => {
    // `a.ts` may have printed fewer than 2 lines, leaving `ls` output in its block.
    const result = classify({ command: "sed -n 1,2p a.ts; ls", output: "a\nb\nsrc\n" });
    expect(result).toMatchObject({
      kind: "sections",
      sections: [
        { type: "file", displayPath: "a.ts", filePath: null, code: "a\nb" },
        { type: "plain", text: "src" },
      ],
    });
    // A full window followed by the next search's first match is confirmed.
    expect(
      classify({ command: "sed -n 1,1p a.ts; grep -rn foo src", output: "a\nsrc/x.ts:1:foo\n" }),
    ).toMatchObject({ sections: [{ type: "file", filePath: "/repo/a.ts" }, { type: "search" }] });
  });

  it("gives reads of several files in one language a section each", () => {
    const result = classify({
      command: "nl -ba a.ts | sed -n 1,5p; nl -ba b.ts | sed -n 7,8p",
      output: "     1\tconst a = 1;\n     2\t\n     7\tx;\n     8\ty;\n",
    });
    expect(result).toMatchObject({
      kind: "sections",
      sections: [
        { type: "file", filePath: "/repo/a.ts", code: "const a = 1;\n", lineNumbers: [1, 2] },
        { type: "file", filePath: "/repo/b.ts", lineNumbers: [7, 8] },
      ],
    });
    // Unbounded reads cannot be told apart and stay one block.
    expect(classify({ command: "cat a.ts; cat b.ts", output: "x\ny" }).kind).toBe("file");
  });

  it("keeps a file that starts like a usage message", () => {
    const result = classify({
      command: "head -n 2 cli.md; head -n 1 b.ts",
      output: "Usage: f5 [options]\nerror: is a word\nconst b = 1;\n",
    });
    expect(result).toMatchObject({
      kind: "sections",
      sections: [{ type: "file", code: "Usage: f5 [options]\nerror: is a word" }, { type: "file" }],
    });
  });

  it("drops an empty head -n 0 read", () => {
    const result = classify({ command: "head -n 0 a.ts; head -n 1 b.ts", output: "x\n" });
    expect(result).toMatchObject({
      kind: "sections",
      sections: [{ type: "file", displayPath: "b.ts", code: "x" }],
    });
  });

  it("highlights reads in different languages separately", () => {
    const result = classify({
      command: "head -n 1 a.ts; head -n 1 b.py",
      output: "const a = 1;\nx = 1\n",
    });
    expect(result).toMatchObject({
      kind: "sections",
      sections: [
        { type: "file", language: "typescript", code: "const a = 1;" },
        { type: "file", language: "python", code: "x = 1" },
      ],
    });
  });

  it("stays plain when the boundaries cannot be known", () => {
    // An unbounded read before another statement.
    expect(classify({ command: "cat a.ts; ls", output: "a\nb\n" }).kind).toBe("plain");
    // Output that starts with another statement's.
    expect(classify({ command: "ls; sed -n 1,2p a.ts", output: "a\nb\n" }).kind).toBe("plain");
    // A read that failed.
    expect(
      classify({
        command: "git show HEAD:gone.ts | sed -n 1,2p; ls",
        output: "fatal: path 'gone.ts' does not exist in 'HEAD'\nsrc\n",
      }).kind,
    ).toBe("plain");
    // Lines missing from the middle.
    expect(
      classify({ command: "sed -n 1,2p a.ts; ls", output: "a\nb\nc\n", shortened: true }).kind,
    ).toBe("plain");
  });

  it("strips revisions from git grep context lines", () => {
    const result = classify({
      command: "git grep -n -C1 foo HEAD -- src/a.ts",
      output: "HEAD:src/a.ts-2-before\nHEAD:src/a.ts:3:foo\n",
    });
    expect(result).toMatchObject({
      kind: "search",
      segments: [
        {
          type: "group",
          displayPath: "HEAD:src/a.ts",
          filePath: null,
          lines: [
            { lineNumber: 2, isMatch: false },
            { lineNumber: 3, isMatch: true },
          ],
        },
      ],
    });
  });

  it("strips a one-letter revision named before --", () => {
    const result = classify({
      command: "git grep -n foo A -- src/a.ts",
      output: "A:src/a.ts:12:foo\n",
    });
    expect(result).toMatchObject({
      kind: "search",
      segments: [{ displayPath: "A:src/a.ts", filePath: null, lines: [{ lineNumber: 12 }] }],
    });
  });

  it("links git -C results relative to the directory, but not --full-name ones", () => {
    const relative = classify({
      command: "git -C apps/web grep -n useTheme -- src",
      output: "src/a.ts:3:useTheme()\n",
    });
    expect(relative).toMatchObject({
      segments: [{ displayPath: "src/a.ts", filePath: "/repo/apps/web/src/a.ts" }],
    });
    const fullName = classify({
      command: "git -C apps/web grep -n --full-name useTheme -- src",
      output: "apps/web/src/a.ts:3:useTheme()\n",
    });
    expect(fullName).toMatchObject({
      segments: [{ displayPath: "apps/web/src/a.ts", filePath: null }],
    });
  });

  it("leaves a lone search followed by other output to the search presentation", () => {
    expect(classify({ command: "grep -n foo a.ts; ls", output: "3:foo\nsrc\n" }).kind).toBe(
      "search",
    );
  });
});

describe("classifyCommandOutput: more command shapes", () => {
  it("reads grep -n over a revision's file as results in that file", () => {
    const result = classify({
      command: 'git show origin/main:src/a.ts | grep -n "useTheme\\|sendTurn" | head',
      output: "12:const t = useTheme();\n40:  sendTurn();\n",
    });
    expect(result).toMatchObject({
      kind: "search",
      matchCount: 2,
      segments: [
        {
          type: "group",
          displayPath: "origin/main:src/a.ts",
          filePath: null,
          language: "typescript",
          lines: [
            { lineNumber: 12, matches: [[10, 18]] },
            { lineNumber: 40, matches: [[2, 10]] },
          ],
        },
      ],
    });
  });

  it("shifts grep -n numbers by where a range read started", () => {
    const result = classify({
      command: "sed -n 40,80p src/a.ts | grep -n foo",
      output: "1:foo()\n3:  foo\n",
    });
    expect(result).toMatchObject({
      kind: "search",
      segments: [
        {
          displayPath: "src/a.ts",
          filePath: "/repo/src/a.ts",
          lines: [{ lineNumber: 40 }, { lineNumber: 42 }],
        },
      ],
    });
  });

  it("keeps echo labels as plain lines between results", () => {
    const result = classify({
      command: 'H=c61e736d; echo "== adapters"; git grep -n foo $H -- p',
      output: "== adapters\nc61e736d:p/a.ts:3:foo\n",
    });
    expect(result).toMatchObject({
      kind: "sections",
      sections: [
        { type: "plain", text: "== adapters" },
        {
          type: "search",
          segments: [
            { displayPath: "c61e736d:p/a.ts", filePath: null, lines: [{ lineNumber: 3 }] },
          ],
        },
      ],
    });
  });

  it("takes wc -l output before a read", () => {
    const result = classify({
      command: "wc -l a.tsx; sed -n 1,2p a.tsx",
      output: "     320 a.tsx\nconst a = 1;\nconst b = 2;\n",
    });
    expect(result).toMatchObject({
      kind: "sections",
      sections: [
        { type: "plain", text: "     320 a.tsx" },
        // The last statement takes the rest, so its end is known.
        { type: "file", filePath: "/repo/a.tsx", code: "const a = 1;\nconst b = 2;" },
      ],
    });
  });

  it("names a read of a file written from a revision after its source", () => {
    const result = classify({
      command: "git show A:src/x.ts > /tmp/x.ts; F=/tmp/x.ts; sed -n 80,81p $F",
      output: "const a = 1;\nconst b = 2;\n",
    });
    expect(result).toMatchObject({
      kind: "file",
      file: { displayPath: "A:src/x.ts", filePath: null },
      language: "typescript",
      lineNumbers: [80, 81],
    });
  });

  it("numbers a read after a variable from its range", () => {
    const result = classify({
      command: "H=abc; git show $H:a.ts | sed -n 5,6p",
      output: "x\ny\n",
    });
    expect(result).toMatchObject({ kind: "file", lineNumbers: [5, 6] });
  });

  it("stays plain for unresolved paths and output it cannot bound", () => {
    expect(classify({ command: "sed -n 1,2p $F", output: "a\nb\n" }).kind).toBe("plain");
    expect(
      classify({ command: "git status; foo || bar; cat a.ts", output: "On branch x\nhi\n" }).kind,
    ).toBe("plain");
  });

  it("keeps a read before a statement it cannot follow", () => {
    const result = classify({
      command: "sed -n 1,2p a.ts; foo || bar",
      output: "a\nb\nfoo output\n",
    });
    expect(result).toMatchObject({
      kind: "sections",
      sections: [
        { type: "file", displayPath: "a.ts", filePath: null, code: "a\nb" },
        { type: "plain", text: "foo output" },
      ],
    });
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
    expect(result.partial).toBe(false);
    expect(result.files.map((file) => file.displayPath)).toEqual(["src/a.ts", "b.py"]);
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
      partial: true,
    });
    expect(classify({ command: "git diff", output: "nothing here" }).kind).toBe("plain");
  });

  it("renders diff -u, which exits 1 when the files differ", () => {
    const unified = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-a\n+b\n";
    expect(
      classify({ command: "diff -u a.txt b.txt", output: unified, status: "failed", exitCode: 1 }),
    ).toMatchObject({ kind: "diff", additions: 1, deletions: 1 });
    // A real failure (exit 2) or a non-diff command stays plain.
    expect(
      classify({ command: "diff -u a.txt b.txt", output: unified, status: "failed", exitCode: 2 })
        .kind,
    ).toBe("plain");
    expect(
      classify({ command: "cat x.patch", output: unified, status: "failed", exitCode: 1 }).kind,
    ).toBe("plain");
  });

  it("marks a diff partial when a hunk ends before its declared rows", () => {
    const cut = "--- a.txt\n+++ b.txt\n@@ -1,2 +1,2 @@\n keep\n";
    expect(classify({ command: "git diff | head -4", output: cut })).toMatchObject({
      kind: "diff",
      partial: true,
    });
    const complete = "--- a.txt\n+++ b.txt\n@@ -1,2 +1,2 @@\n keep\n-a\n+b\n";
    expect(classify({ command: "git diff", output: complete })).toMatchObject({
      kind: "diff",
      partial: false,
    });
  });
});

describe("classifyCommandOutput: shortened and large output", () => {
  const marker = "\n\n[... output compacted; 99999 bytes in total ...]\n\n";

  it("drops the gutter and marks counts partial for server-compacted output", () => {
    const output = `a\nb${marker}y\nz\n`;
    expect(classify({ command: "cat a.ts", output, shortened: true })).toMatchObject({
      kind: "file",
      lineNumbers: null,
    });
    expect(
      classify({
        command: "rg -n x src",
        output: `src/a.ts:1:x${marker}src/b.ts:9:x\n`,
        shortened: true,
      }),
    ).toMatchObject({ kind: "search", matchCount: 2, partial: true });
    expect(classify({ command: "nl -ba a.ts", output: `     1\ta${marker}   900\tz` }).kind).toBe(
      "plain",
    );
  });

  it("renders very long output as one plain block", () => {
    const lines = Array.from({ length: MAX_PRESENTED_LINES + 1 }, (_, index) => `line ${index}`);
    expect(classify({ command: "cat a.ts", output: lines.join("\n") }).kind).toBe("plain");
    expect(
      classify({ command: "bun test", output: `\x1b[31mx\x1b[0m\n${lines.join("\n")}` }),
    ).toMatchObject({ kind: "plain", text: `x\n${lines.join("\n")}` });
    expect(classify({ command: "cat a.ts", output: lines.slice(1).join("\n") }).kind).toBe("file");
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
