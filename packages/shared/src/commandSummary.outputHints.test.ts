import { describe, expect, it } from "vitest";

import {
  isDiffCommand,
  parseFileReadSegments,
  parseOutputStatements,
  parseSearchOutputCommand,
} from "./commandSummary";

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
          revision: null,
          lineLimit: 21,
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
          revision: null,
          lineLimit: 21,
        },
        {
          filePath: "a.tsx",
          cwdOffset: "~/dev/f5/apps/web",
          // After `;` this read runs even if the cd failed.
          cwdKnown: false,
          startLine: 850,
          numberedOutput: false,
          revision: null,
          lineLimit: 16,
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
        revision: null,
        lineLimit: 20,
      },
    ]);
  });

  it("reads a revision's file with git show", () => {
    const first = (command: string) => parseFileReadSegments(command)?.segments[0];
    expect(first("git show origin/main:apps/web/src/a.ts | sed -n 1,60p")).toMatchObject({
      filePath: "apps/web/src/a.ts",
      revision: "origin/main",
      startLine: 1,
      lineLimit: 60,
    });
    expect(first("git --no-pager show HEAD~1:a.ts")).toMatchObject({
      filePath: "a.ts",
      revision: "HEAD~1",
      startLine: 1,
      lineLimit: null,
    });
    expect(first("git show :./src/a.ts | head -n 5")).toMatchObject({
      filePath: "src/a.ts",
      revision: "",
      lineLimit: 5,
    });
    expect(first("git show HEAD:a.ts | sed -n 2800,2812p")).toMatchObject({
      startLine: 2800,
      lineLimit: 13,
    });
    expect(first("git show :2:src/a.ts")).toMatchObject({ filePath: "src/a.ts", revision: ":2" });
    // Commits, several objects and directories are not file reads.
    expect(parseFileReadSegments("git show HEAD")).toBeNull();
    expect(parseFileReadSegments("git show ':/fix typo'")).toBeNull();
    expect(parseFileReadSegments("git show :/fix")).toBeNull();
    expect(parseFileReadSegments("git show 'main@{10:00}'")).toBeNull();
    expect(parseFileReadSegments("git show HEAD:a.ts HEAD:b.ts")).toBeNull();
    expect(parseFileReadSegments("git show HEAD:src/")).toBeNull();
    expect(parseFileReadSegments("git show --stat HEAD:a.ts")).toBeNull();
  });

  it("knows how many lines a read can print", () => {
    const limit = (command: string) => parseFileReadSegments(command)?.segments[0]?.lineLimit;
    expect(limit("sed -n 5p a.ts")).toBe(1);
    expect(limit("sed -n 5,$p a.ts")).toBeNull();
    expect(limit("sed -n 9,5p a.ts")).toBe(1);
    expect(limit("head a.ts")).toBe(10);
    expect(limit("tail -n 3 a.ts")).toBe(3);
    expect(limit("tail -n +3 a.ts")).toBeNull();
    expect(limit("cat a.ts")).toBeNull();
    expect(limit("cat a.ts | head -n 7")).toBe(7);
    expect(limit("nl -ba a.ts | sed -n 20,29p")).toBe(10);
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
      revisions: [],
      revisionsKnown: false,
      stdin: null,
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

  it("reads git grep trees, paths and flags", () => {
    expect(
      parseSearchOutputCommand(
        `git grep -n "window.nativeApi\\|globalThis.*nativeApi" origin/main -- apps/web/src/nativeApi.ts | head`,
      ),
    ).toMatchObject({
      tool: "git",
      patterns: ["window.nativeApi\\|globalThis.*nativeApi"],
      targets: ["apps/web/src/nativeApi.ts"],
      revisions: ["origin/main"],
      recursive: true,
      lineNumbers: true,
    });
    // Without `--` a word may be a tree or a path.
    expect(parseSearchOutputCommand("git grep -n foo HEAD src")).toMatchObject({
      targets: ["HEAD", "src"],
      revisions: ["HEAD", "src"],
    });
    expect(parseSearchOutputCommand("git -C apps grep -niE 'a|b'")).toMatchObject({
      cwdOffset: "apps",
      ignoreCase: true,
      extendedRegex: true,
      revisions: [],
    });
    expect(parseSearchOutputCommand("git grep -A 2 -n foo")?.patterns).toEqual(["foo"]);
    expect(parseSearchOutputCommand("git grep foo")?.lineNumbers).toBe(false);
    expect(parseSearchOutputCommand("git log --grep foo")).toBeNull();
    expect(parseSearchOutputCommand("git grep -n foo A -- a.ts")).toMatchObject({
      revisions: ["A"],
      revisionsKnown: true,
    });
    expect(parseSearchOutputCommand("git grep -n foo A")?.revisionsKnown).toBe(false);
    // `--full-name` paths start at the repository root, wherever it ran.
    expect(parseSearchOutputCommand("git -C apps grep -n --full-name foo")).toMatchObject({
      cwdOffset: "apps",
      cwdKnown: false,
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
    for (const filter of [
      "head",
      "tail",
      "tail -5",
      "tail -n5",
      "tail -n +5",
      "tail -n+5",
      "head --lines=5",
      "head -20 | grep -v x",
      "grep --regexp=bar",
      "grep -- -bar",
      "grep --invert-match --ignore-case --word-regexp bar",
      'grep -v "test$"',
      "rg -S bar",
      "rg --smart-case --case-sensitive bar",
    ]) {
      expect(parseSearchOutputCommand(`grep -n foo a.ts | ${filter}`), filter).not.toBeNull();
    }
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
      "head -n abc",
      "tail -n 5 extra.ts",
      // The shell expands these, so the filter's real arguments are unknown.
      "grep $FILTER",
      'grep "$FILTER"',
      "grep ${FILTER}",
      "grep -v `cat pattern`",
      "grep -v a*",
      "grep -v ~/pattern",
      // Each tool rejects the other's long flags.
      "grep --smart-case bar",
      "grep --case-sensitive bar",
      "rg --basic-regexp bar",
      "rg --extended-regexp bar",
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

describe("parseOutputStatements", () => {
  it("describes each statement past cd in output order", () => {
    const statements = parseOutputStatements(
      `cd /repo && git show origin/main:a.ts | sed -n 1,60p; ps -axo pid,command | grep -E "F5( |$)" | grep -v grep | head -3; echo "env: \${X:-unset}"`,
    );
    expect(statements?.map((statement) => statement.kind)).toEqual(["read", "other", "other"]);
    expect(statements?.[0]).toMatchObject({
      read: { filePath: "a.ts", revision: "origin/main", lineLimit: 60, cwdOffset: "/repo" },
    });

    const mixed = parseOutputStatements(
      "git show A:a.ts | sed -n 1,3p; git show B:b.ts | sed -n 5,6p; git grep -n foo B -- c.ts | head",
    );
    expect(mixed?.map((statement) => statement.kind)).toEqual(["read", "read", "search"]);
    expect(mixed?.[2]).toMatchObject({
      search: { tool: "git", revisions: ["B"], followedByOtherStatements: false },
    });
  });

  it("is null for commands that cannot be split", () => {
    expect(parseOutputStatements("cat a.ts > b.ts")).toBeNull();
    expect(parseOutputStatements("cd src")).toBeNull();
  });
});

describe("statement splitting", () => {
  const kinds = (command: string) =>
    parseOutputStatements(command)?.map((statement) => statement.kind);

  it("keeps statements before one it cannot follow, then ends with it", () => {
    expect(kinds("cat a.ts; foo || bar; cat b.ts")).toEqual(["read", "other"]);
    expect(kinds('cat a.ts; echo "$(date)"; cat b.ts')).toEqual(["read", "other"]);
    expect(kinds("cat a.ts; cat <<EOF\nhi\nEOF")).toEqual(["read", "other"]);
    expect(kinds("cat a.ts; for f in a b; do cat $f; done")).toEqual(["read", "other"]);
    expect(kinds("cat a.ts; f(){ cat b.ts; }; f")).toEqual(["read", "other"]);
    expect(kinds("cat a.ts; (cd x && ls)")).toEqual(["read", "other"]);
    expect(kinds("cat a.ts; sleep 1 &")).toEqual(["read", "other"]);
    expect(kinds("cat a.ts; echo x >&2")).toEqual(["read", "other"]);
    // The single-purpose parsers still want the whole command.
    expect(parseFileReadSegments("cat a.ts; foo || bar")).toBeNull();
    expect(parseSearchOutputCommand("grep -n x a.ts; foo || bar")).toBeNull();
    expect(isDiffCommand("git diff; foo || bar")).toBe(false);
  });

  it("reads `|| true` as the statement before it", () => {
    expect(parseFileReadSegments("cat a.ts 2>/dev/null || true")?.segments).toHaveLength(1);
    expect(parseFileReadSegments("cat a.ts || :")?.segments).toHaveLength(1);
    expect(isDiffCommand("git diff || true")).toBe(true);
  });

  it("fills in literal variables", () => {
    const filePath = (command: string) => parseFileReadSegments(command)?.segments[0]?.filePath;
    expect(filePath("F=src/a.ts; cat $F")).toBe("src/a.ts");
    expect(filePath("D=src; cat ${D}/a.ts")).toBe("src/a.ts");
    expect(filePath('D=src; cat "$D/a b.ts"')).toBe("src/a b.ts");
    expect(filePath("D='src'; export E=\"$D/x\"; cat $E/a.ts")).toBe("src/x/a.ts");
    expect(filePath("F=a.ts; F=b.ts; cat $F")).toBe("b.ts");
    expect(
      parseFileReadSegments("H=abc; git show $H:a.ts | sed -n 5,9p")?.segments[0],
    ).toMatchObject({ revision: "abc", filePath: "a.ts", startLine: 5 });
    // Single quotes keep `$` literal; patterns keep their anchors.
    expect(parseSearchOutputCommand("X=1; grep -n 'a$X' a.ts")?.patterns).toEqual(["a$X"]);
    // Unknown or computed values leave the path unresolved, so not a read.
    expect(parseFileReadSegments("cat $F")).toBeNull();
    expect(parseFileReadSegments("F=$(ls | head -1); cat $F")).toBeNull();
    expect(parseFileReadSegments("F=a.ts; unset F; cat $F")).toBeNull();
    // A value with spaces would split when unquoted.
    expect(parseFileReadSegments('F="a b"; cat $F')).toBeNull();
    expect(kinds("H=$(git rev-parse HEAD); echo hi; cat a.ts")).toEqual(["lines", "read"]);
  });

  it("skips statements that print nothing", () => {
    expect(kinds("set -e; X=1; export Y=2; true; :; cat a.ts")).toEqual(["read"]);
    expect(kinds("ls > /tmp/out.txt; cat a.ts")).toEqual(["read"]);
    expect(kinds("ls >> /tmp/out.txt 2>&1; cat a.ts")).toEqual(["read"]);
    expect(kinds("npm test &> /tmp/log; cat a.ts")).toEqual(["read"]);
    // Only stderr goes elsewhere, so stdout still shows.
    expect(kinds("ls 2>/tmp/err; cat a.ts")).toEqual(["other", "read"]);
    expect(parseFileReadSegments("FOO=1 cat a.ts")?.segments[0]?.filePath).toBe("a.ts");
  });

  it("reads a file written from a whole-file read as its source", () => {
    expect(
      parseFileReadSegments("git show A:src/x.ts > /tmp/x.ts; F=/tmp/x.ts; sed -n 80,130p $F")
        ?.segments[0],
    ).toMatchObject({ filePath: "src/x.ts", revision: "A", startLine: 80, lineLimit: 51 });
    expect(
      parseFileReadSegments("cd src && cat a.ts > /tmp/a; cd /; head -n 5 /tmp/a")?.segments[0],
    ).toMatchObject({ filePath: "a.ts", revision: null, cwdOffset: "src", cwdKnown: true });
    // Appending or narrowing does not copy the file.
    expect(
      parseFileReadSegments("git show A:x.ts >> /tmp/x.ts; cat /tmp/x.ts")?.segments[0],
    ).toMatchObject({ filePath: "/tmp/x.ts", revision: null });
    expect(
      parseFileReadSegments("git show A:x.ts | head -n 5 > /tmp/x.ts; cat /tmp/x.ts")?.segments[0],
    ).toMatchObject({ filePath: "/tmp/x.ts", revision: null });
  });

  it("counts lines that echo and wc print", () => {
    const counts = (command: string) =>
      parseOutputStatements(command)?.map((statement) =>
        statement.kind === "lines" ? statement.count : statement.kind,
      );
    expect(counts('echo "== a"; echo; cat a.ts')).toEqual([1, 1, "read"]);
    expect(counts("wc -l a.ts; wc -l a.ts b.ts c.ts; wc -l < a.ts")).toEqual([1, 4, 1]);
    expect(counts("git show A:a.ts | wc -l")).toEqual([1]);
    // `-n` joins the next output, escapes and quoted unknowns may break lines.
    expect(counts("echo -n x; echo 'a\\nb'; echo \"$X\"")).toEqual(["other", "other", "other"]);
    expect(counts("echo $X")).toEqual([1]);
    expect(counts("wc -l src/*.ts")).toEqual(["other"]);
  });

  it("reads a search over piped or redirected input as a search of that file", () => {
    const stdin = (command: string) => parseSearchOutputCommand(command)?.stdin;
    expect(stdin('git show A:src/a.ts | grep -n "x\\|y" | head')).toEqual({
      filePath: "src/a.ts",
      revision: "A",
      cwdOffset: null,
      cwdKnown: true,
      lineOffset: 0,
    });
    expect(stdin("cat a.ts | grep -n -A2 foo")).toMatchObject({ filePath: "a.ts", lineOffset: 0 });
    expect(stdin("sed -n 40,80p a.ts | rg -n foo")).toMatchObject({ lineOffset: 39 });
    expect(stdin("git show A:a.ts | sed -n 10,20p | grep -n x")).toMatchObject({
      revision: "A",
      lineOffset: 9,
    });
    expect(stdin("tail -n +30 a.ts | grep -n x")).toMatchObject({ lineOffset: 29 });
    expect(stdin("cd src && grep -n x < a.ts")).toMatchObject({
      filePath: "a.ts",
      cwdOffset: "src",
      lineOffset: 0,
    });
    expect(stdin("git show A:p > /tmp/p 2>/dev/null; grep -n x /tmp/p")).toMatchObject({
      filePath: "p",
      revision: "A",
    });
    // Unknown starting lines, added numbers and file arguments.
    expect(parseSearchOutputCommand("tail -n 5 a.ts | grep -n x")).toBeNull();
    expect(parseSearchOutputCommand("nl -ba a.ts | grep -n x")).toBeNull();
    expect(parseSearchOutputCommand("cat a.ts | grep -n x b.ts")).toBeNull();
    expect(parseSearchOutputCommand("cat a.ts | git grep -n x")).toBeNull();
  });

  it("reads several sed ranges without a start line", () => {
    expect(parseFileReadSegments("sed -n '296,350p;560,740p' a.ts")?.segments[0]).toMatchObject({
      startLine: null,
      lineLimit: 236,
    });
    expect(parseFileReadSegments("sed -n '1,5p;9,$p' a.ts")?.segments[0]?.lineLimit).toBeNull();
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
    // Commits named by message or date, and colon pathspecs after `--`.
    "git show ':/fix typo'",
    "git show 'main@{2026-11-01 10:00}'",
    "git show abc123 -- ':(glob)src/*.ts'",
  ])("accepts %s", (command) => {
    expect(isDiffCommand(command)).toBe(true);
  });

  it.each([
    "git diff --stat",
    "git log",
    "git status",
    "diff a b",
    "git diff && echo done",
    "git show origin/main:a.ts",
  ])("rejects %s", (command) => {
    expect(isDiffCommand(command)).toBe(false);
  });
});
