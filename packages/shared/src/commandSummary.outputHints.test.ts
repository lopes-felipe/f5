import { describe, expect, it } from "vitest";

import { isDiffCommand, parseFileReadSegments, parseSearchOutputCommand } from "./commandSummary";

describe("parseFileReadSegments", () => {
  it("reads a sed print range with its start line", () => {
    expect(parseFileReadSegments("sed -n 750,770p GitActionsControl.tsx")).toEqual({
      segments: [
        {
          filePath: "GitActionsControl.tsx",
          cwdOffset: null,
          cwdKnown: true,
          startLine: 750,
          numberedOutput: false,
        },
      ],
    });
  });

  it("follows cd and splits compound reads in output order", () => {
    expect(
      parseFileReadSegments(
        "cd ~/dev/f5/apps/web && sed -n 750,770p a.tsx; sed -n '850,865p' a.tsx",
      ),
    ).toEqual({
      segments: [
        {
          filePath: "a.tsx",
          cwdOffset: "~/dev/f5/apps/web",
          cwdKnown: true,
          startLine: 750,
          numberedOutput: false,
        },
        {
          filePath: "a.tsx",
          cwdOffset: "~/dev/f5/apps/web",
          // After `;` this read runs even if the cd failed.
          cwdKnown: false,
          startLine: 850,
          numberedOutput: false,
        },
      ],
    });
    expect(parseFileReadSegments("cd apps && cd web && cat a.ts")?.segments[0]?.cwdOffset).toBe(
      "apps/web",
    );
    expect(parseFileReadSegments("cd apps && cd /abs && cat a.ts")?.segments[0]?.cwdOffset).toBe(
      "/abs",
    );
  });

  it("unwraps shell launchers", () => {
    expect(parseFileReadSegments("/bin/zsh -lc 'sed -n 1,20p src/a.ts'")?.segments).toEqual([
      {
        filePath: "src/a.ts",
        cwdOffset: null,
        cwdKnown: true,
        startLine: 1,
        numberedOutput: false,
      },
    ]);
  });

  it("knows where head, tail, cat and nl output starts", () => {
    const first = (command: string) => parseFileReadSegments(command)?.segments[0];
    expect(first("cat a.ts")).toMatchObject({ startLine: 1, numberedOutput: false });
    expect(first("cat -n a.ts")).toMatchObject({ startLine: 1, numberedOutput: true });
    expect(first("head -n 40 a.ts")).toMatchObject({ startLine: 1 });
    expect(first("head -40 a.ts")).toMatchObject({ startLine: 1 });
    expect(first("tail -n 20 a.ts")).toMatchObject({ startLine: null });
    expect(first("tail -n +30 a.ts")).toMatchObject({ startLine: 30 });
    expect(first("nl -ba a.ts")).toMatchObject({ startLine: 1, numberedOutput: true });
    expect(first("nl -ba a.ts | sed -n 20,40p")).toMatchObject({
      startLine: 20,
      numberedOutput: true,
    });
    expect(first("sed -n 10,20p a.ts 2>/dev/null")).toMatchObject({ startLine: 10 });
  });

  it("rejects anything that is not a read", () => {
    expect(parseFileReadSegments("ls && cat a.ts")).toBeNull();
    expect(parseFileReadSegments("cat a.ts b.ts")).toBeNull();
    expect(parseFileReadSegments("cat a.ts | grep foo")).toBeNull();
    expect(parseFileReadSegments("sed -i 's/a/b/' a.ts")).toBeNull();
    expect(parseFileReadSegments("cat a.ts > b.ts")).toBeNull();
    expect(parseFileReadSegments("cat $(ls)")).toBeNull();
    expect(parseFileReadSegments("cd src")).toBeNull();
  });

  it("marks reads whose directory depends on a cd that may have failed", () => {
    const known = (command: string) =>
      parseFileReadSegments(command)?.segments.map((segment) => segment.cwdKnown);
    // `;` runs the read even when `cd` fails, so the directory is unknown.
    expect(known("cd missing 2>/dev/null; cat a.ts")).toEqual([false]);
    expect(known("cd src && cat a.ts; cat b.ts")).toEqual([true, false]);
    // Reads before any cd, and `&&` chains after one, keep their directory.
    expect(known("cat a.ts; cat b.ts")).toEqual([true, true]);
    expect(known("cd src && cat a.ts && cat b.ts")).toEqual([true, true]);
  });

  it("needs sed's quiet mode to read a range", () => {
    // Without -n sed prints the whole file and the range again.
    expect(parseFileReadSegments("sed '3p' a.ts")).toBeNull();
    expect(parseFileReadSegments("sed -e 10,20p a.ts")).toBeNull();
    // After `--`, `-n` is a file name, not quiet mode.
    expect(parseFileReadSegments("sed '2p' -- -n")).toBeNull();
    expect(parseFileReadSegments("nl -ba a.ts | sed '2p'")).toBeNull();
    expect(parseFileReadSegments("nl -ba a.ts | sed -n '2p'")?.segments[0]?.startLine).toBe(2);
    expect(parseFileReadSegments("sed --quiet 10,20p a.ts")?.segments[0]?.startLine).toBe(10);
  });
});

describe("parseSearchOutputCommand", () => {
  it("reads grep patterns, targets and flags", () => {
    expect(
      parseSearchOutputCommand(
        `cd src && grep -n "plainDraft\\|isLocal =" ChatView.tsx | head -40; ls | grep -i branch`,
      ),
    ).toEqual({
      tool: "grep",
      patterns: ["plainDraft\\|isLocal ="],
      targets: ["ChatView.tsx"],
      cwdOffset: "src",
      cwdKnown: true,
      followedByOtherStatements: true,
      fixedStrings: false,
      ignoreCase: false,
      extendedRegex: false,
      perlRegex: false,
      noFileName: false,
      recursive: false,
      lineNumbers: true,
    });
  });

  it("reports whether output lines are numbered", () => {
    expect(parseSearchOutputCommand("grep ERROR app.log")?.lineNumbers).toBe(false);
    expect(parseSearchOutputCommand("rg foo src")?.lineNumbers).toBe(false);
    expect(parseSearchOutputCommand("grep -rn foo src")?.lineNumbers).toBe(true);
    expect(parseSearchOutputCommand("grep --line-number foo a")?.lineNumbers).toBe(true);
    expect(parseSearchOutputCommand("rg -n -N foo")?.lineNumbers).toBe(false);
    // Column formats (`path:3:7:text`) are not parsed, so they count as unnumbered.
    expect(parseSearchOutputCommand("rg --vimgrep foo")?.lineNumbers).toBe(false);
    expect(parseSearchOutputCommand("rg -n --column foo")?.lineNumbers).toBe(false);
  });

  it("reports statements after the search", () => {
    expect(parseSearchOutputCommand("grep -n foo a.ts")?.followedByOtherStatements).toBe(false);
    expect(
      parseSearchOutputCommand("grep -n foo a.ts | head -5; ls")?.followedByOtherStatements,
    ).toBe(true);
  });

  it("only follows a cd that later statements depend on", () => {
    expect(parseSearchOutputCommand("cd src && rg -n foo")).toMatchObject({
      cwdOffset: "src",
      cwdKnown: true,
    });
    expect(parseSearchOutputCommand("cd src; rg -n foo")?.cwdKnown).toBe(false);
  });

  it("flags PCRE patterns", () => {
    expect(parseSearchOutputCommand("grep -nP '\\d+' a")?.perlRegex).toBe(true);
    expect(parseSearchOutputCommand("rg -n --pcre2 'a(?=b)'")?.perlRegex).toBe(true);
    expect(parseSearchOutputCommand("rg -n foo")?.perlRegex).toBe(false);
  });

  it("reads clustered and long flags", () => {
    expect(parseSearchOutputCommand("grep -rniF 'a.b' .")).toMatchObject({
      fixedStrings: true,
      ignoreCase: true,
      recursive: true,
      targets: ["."],
    });
    expect(parseSearchOutputCommand("grep -E --ignore-case 'a|b' x.ts")).toMatchObject({
      extendedRegex: true,
      ignoreCase: true,
    });
    expect(parseSearchOutputCommand("grep -A3 -n foo x.ts")).toMatchObject({ patterns: ["foo"] });
  });

  it("treats ripgrep as recursive extended regex with smart case", () => {
    expect(parseSearchOutputCommand("rg -n -S foo src")).toMatchObject({
      tool: "rg",
      extendedRegex: true,
      recursive: true,
      ignoreCase: true,
    });
    expect(parseSearchOutputCommand("rg -n -S Foo src")).toMatchObject({ ignoreCase: false });
    expect(parseSearchOutputCommand("rg -n x -g '*.ts'")).toMatchObject({ targets: [] });
  });

  it("accepts pipes that only drop whole lines", () => {
    expect(
      parseSearchOutputCommand(
        `grep -rn "rawOutput\\|stdout" apps/server/src --include='*.ts' | grep -v test | head -20`,
      ),
    ).toMatchObject({
      patterns: ["rawOutput\\|stdout"],
      targets: ["apps/server/src"],
      lineNumbers: true,
    });
    expect(
      parseSearchOutputCommand(
        `grep -n "Output\\b\\|output" a.ts | grep -i -E "command|terminal|tool" | head -40`,
      ),
    ).toMatchObject({ patterns: ["Output\\b\\|output"], targets: ["a.ts"] });
    expect(parseSearchOutputCommand("rg -n foo | rg -v -e bar -e baz | tail -n 5")).not.toBeNull();
    expect(parseSearchOutputCommand("grep -n foo a | grep -vetest")).not.toBeNull();
    expect(parseSearchOutputCommand("grep -n foo a | egrep -iw 'x|y' | head")).not.toBeNull();
  });

  it("rejects pipes that rewrite lines or stop reading the search output", () => {
    for (const filter of [
      "grep -n bar",
      "grep -o bar",
      "grep -c bar",
      "grep -H bar",
      "grep -A2 bar",
      "grep bar other.ts",
      "grep -e bar other.ts",
      "grep -v",
      "sort",
      "cut -d: -f1",
      "head -n",
    ]) {
      expect(parseSearchOutputCommand(`grep -n foo a.ts | ${filter}`), filter).toBeNull();
    }
  });

  it("rejects non-search commands", () => {
    expect(parseSearchOutputCommand("ls src")).toBeNull();
    expect(parseSearchOutputCommand("grep foo a | sort")).toBeNull();
    expect(parseSearchOutputCommand("find . -name '*.ts'")).toBeNull();
  });
});

describe("isDiffCommand", () => {
  it.each([
    "git diff",
    "git --no-pager diff -- a.ts",
    "git -C repo diff HEAD~1",
    "git show HEAD",
    "cd x && git show HEAD | head -50",
    "git log -p -3",
    "git stash show -p",
    "diff -u a b",
  ])("accepts %s", (command) => {
    expect(isDiffCommand(command)).toBe(true);
  });

  it.each(["git diff --stat", "git log", "git status", "diff a b", "git diff && echo done"])(
    "rejects %s",
    (command) => {
      expect(isDiffCommand(command)).toBe(false);
    },
  );
});
