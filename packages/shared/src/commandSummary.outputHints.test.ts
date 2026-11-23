import { describe, expect, it } from "vitest";

import { isDiffCommand, parseFileReadSegments, parseSearchOutputCommand } from "./commandSummary";

describe("parseFileReadSegments", () => {
  it("reads a sed print range with its start line", () => {
    expect(parseFileReadSegments("sed -n 750,770p GitActionsControl.tsx")).toEqual({
      segments: [
        {
          filePath: "GitActionsControl.tsx",
          cwdOffset: null,
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
          startLine: 750,
          numberedOutput: false,
        },
        {
          filePath: "a.tsx",
          cwdOffset: "~/dev/f5/apps/web",
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
      { filePath: "src/a.ts", cwdOffset: null, startLine: 1, numberedOutput: false },
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
      fixedStrings: false,
      ignoreCase: false,
      extendedRegex: false,
      noFileName: false,
      recursive: false,
    });
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
