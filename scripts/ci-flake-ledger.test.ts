import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codeBlock,
  codeSpan,
  collectOccurrences,
  contextFromEnv,
  type Gh,
  issueMarker,
  LEDGER_AUTHOR,
  MAX_COMMENTS_PER_ISSUE_PER_RUN,
  MAX_ISSUES_PER_RUN,
  type Occurrence,
  occurrenceComment,
  occurrenceMarker,
  type RunContext,
  updateLedger,
  withCount,
  workspaceRelative,
} from "./ci-flake-ledger.ts";
import {
  appendFlakyRecords,
  FAILURE_RECORD_FILE,
  FLAKY_RECORD_FILE,
  flakyRecord,
} from "./lib/ci-flaky-records.ts";
import { reportPath } from "./lib/ci-test-reports.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const context = (overrides: Partial<RunContext> = {}): RunContext => ({
  runId: "100",
  runAttempt: 1,
  conclusion: "success",
  branch: "feature/x",
  sha: "0123456789abcdef",
  runUrl: "https://github.com/o/f5/actions/runs/100",
  repoName: "f5",
  event: "pull_request",
  defaultBranch: "main",
  ...overrides,
});

function artifacts() {
  const directory = mkdtempSync(join(tmpdir(), "f5-flake-ledger-"));
  directories.push(directory);
  return directory;
}

function writeReport(
  directory: string,
  artifact: string,
  suite: { packageName: string; event: string },
  report: object,
) {
  const file = join(directory, artifact, reportPath(suite));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(report));
  return join(file, "..");
}

const failedReport = (overrides: object = {}) => ({
  success: false,
  numFailedTests: 1,
  numFailedTestSuites: 1,
  testResults: [
    {
      name: "/home/runner/work/f5/f5/apps/server/src/a.test.ts",
      status: "failed",
      assertionResults: [
        { status: "passed", ancestorTitles: ["group"], title: "fine" },
        {
          status: "failed",
          ancestorTitles: ["group"],
          title: "races",
          failureMessages: ["Error: timed out"],
        },
      ],
    },
  ],
  ...overrides,
});

interface FakeComment {
  author: string;
  body: string;
}

/** In-memory GitHub issues that understand only the commands the ledger sends. */
function fakeGitHub(
  initial: {
    number: number;
    state: string;
    stateReason?: string;
    body: string;
    comments?: FakeComment[];
  }[] = [],
) {
  const issues = initial.map((issue) => ({
    title: "",
    stateReason: "",
    ...issue,
    comments: (issue.comments ?? []) as FakeComment[],
  }));
  // The bodies the ledger posted, in order.
  const posted = (number: number) =>
    issues
      .find((issue) => issue.number === number)!
      .comments.filter((comment) => comment.author === LEDGER_AUTHOR)
      .map((comment) => comment.body);
  const calls: string[] = [];
  const failing = new Set<string>();
  const gh: Gh = async (args, input) => {
    const command = args.slice(0, 2).join(" ");
    calls.push(command);
    if (failing.has(command)) throw new Error(`${command} failed`);
    const number = Number(args[2]);
    const issue = () => issues.find((candidate) => candidate.number === number)!;
    switch (command) {
      case "label create":
        return "";
      case "issue list":
        return JSON.stringify(
          issues.map(({ number, state, stateReason, body }) => ({
            number,
            state,
            stateReason,
            body,
          })),
        );
      case "issue create": {
        const created = {
          number: issues.length + 1,
          state: "OPEN",
          stateReason: "",
          body: input!,
          title: args[3]!,
          comments: [],
        };
        issues.push(created);
        return `https://github.com/o/f5/issues/${created.number}\n`;
      }
      case "api --paginate": {
        const target = Number(/issues\/(\d+)\/comments/.exec(args[2]!)![1]);
        // Honour the ledger's author filter the way `--jq` would.
        const filter = args.at(-1)!;
        return issues
          .find((candidate) => candidate.number === target)!
          .comments.filter(
            (comment) => !filter.includes("select") || filter.includes(`"${comment.author}"`),
          )
          .map((comment) => comment.body)
          .join("\n");
      }
      case "issue reopen":
        issue().state = "OPEN";
        return "";
      case "issue comment":
        issue().comments.push({ author: LEDGER_AUTHOR, body: input! });
        return "";
      case "issue edit":
        issue().body = input!;
        return "";
      default:
        throw new Error(`Unexpected gh ${args.join(" ")}`);
    }
  };
  return { gh, issues, calls, failing, posted };
}

const silent = () => {
  const lines: string[] = [];
  return { log: (line: string) => void lines.push(line), lines };
};

describe("collectOccurrences", () => {
  it("unifies retry records and rerun failures of the same test into one id", () => {
    const directory = artifacts();
    const suite = { packageName: "suites", event: "server-unit-2" };
    const reportDir = writeReport(
      directory,
      "reports-windows-server-unit-Windows-1-1",
      suite,
      failedReport({
        testResults: [
          {
            ...failedReport().testResults[0],
            name: "D:\\a\\f5\\f5\\apps\\server\\src\\a.test.ts",
          },
        ],
      }),
    );
    appendFlakyRecords(join(reportDir, FLAKY_RECORD_FILE), [
      {
        ...flakyRecord({
          kind: "test",
          suite: "suites/server-unit-2",
          file: "apps/server/src/a.test.ts",
          name: "group > races",
          retryCount: 1,
          errors: ["first"],
        }),
        os: "linux",
        job: "server-unit",
        runAttempt: "1",
      },
    ]);
    const occurrences = collectOccurrences(directory, context({ runAttempt: 2 }));
    expect(occurrences.map((occurrence) => occurrence.kind)).toEqual(["test", "rerun"]);
    expect(new Set(occurrences.map((occurrence) => occurrence.id)).size).toBe(1);
    expect(occurrences[1]).toMatchObject({
      title: "Flaky: apps/server/src/a.test.ts > group > races",
      os: "win32",
      job: "windows-server-unit",
      attempt: 1,
      errors: ["Error: timed out"],
    });
  });

  it("reads earlier attempts only when a rerun turned the run green", () => {
    const directory = artifacts();
    const suite = { packageName: "@t3tools/web", event: "test" };
    writeReport(directory, "reports-test-Linux-0-1", suite, failedReport());
    writeReport(directory, "reports-test-Linux-0-2", suite, failedReport());
    expect(collectOccurrences(directory, context({ runAttempt: 2 }))).toHaveLength(1);
    expect(collectOccurrences(directory, context({ runAttempt: 1 }))).toEqual([]);
    expect(
      collectOccurrences(directory, context({ runAttempt: 2, conclusion: "failure" })),
    ).toEqual([]);
  });

  it("files a suite that failed without a failed test as an unhandled error, per suite", () => {
    const directory = artifacts();
    for (const shard of [1, 2])
      writeReport(
        directory,
        `reports-server-unit-Linux-${shard - 1}-1`,
        { packageName: "suites", event: `server-unit-${shard}` },
        failedReport({
          numFailedTests: 0,
          numFailedTestSuites: 0,
          testResults: [{ name: "/x/f5/f5/a.test.ts", status: "passed", assertionResults: [] }],
        }),
      );
    const occurrences = collectOccurrences(directory, context({ runAttempt: 2 }));
    expect(occurrences.map((occurrence) => occurrence.title)).toEqual([
      "Flaky: unhandled error in suites/server-unit",
      "Flaky: unhandled error in suites/server-unit",
    ]);
    expect(occurrences[0]!.id).toBe(occurrences[1]!.id);
  });

  it("files failure records of an attempt a rerun turned green", () => {
    const directory = artifacts();
    const suite = { packageName: "suites", event: "server-unit-1" };
    const passed = { success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [] };
    const reportDir = writeReport(directory, "reports-server-unit-Linux-0-1", suite, passed);
    writeReport(directory, "reports-server-unit-Linux-0-2", suite, passed);
    const failure = (kind: "unhandled" | "step-failure", name: string) =>
      flakyRecord({
        kind,
        suite: "suites/server-unit-1",
        file: "",
        name,
        retryCount: 0,
        errors: ["write EPIPE"],
      });
    appendFlakyRecords(join(reportDir, FAILURE_RECORD_FILE), [
      failure("unhandled", "(unhandled errors)"),
      failure("step-failure", "desktop-smoke"),
    ]);
    const occurrences = collectOccurrences(directory, context({ runAttempt: 2 }));
    expect(occurrences).toEqual([
      expect.objectContaining({
        kind: "unhandled",
        title: "Flaky: unhandled error in suites/server-unit",
        errors: ["write EPIPE"],
      }),
      expect.objectContaining({ kind: "rerun", title: "Flaky step: desktop-smoke" }),
    ]);
    expect(collectOccurrences(directory, context({ runAttempt: 1 }))).toEqual([]);
  });

  it("files a suite that a later attempt finished but an earlier one never reported", () => {
    const directory = artifacts();
    const passed = { success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [] };
    const web = { packageName: "@t3tools/web", event: "test" };
    const server = { packageName: "suites", event: "server-integration" };
    writeReport(directory, "reports-windows-build-Windows-0-1", web, passed);
    writeReport(directory, "reports-windows-build-Windows-0-2", web, passed);
    writeReport(directory, "reports-windows-build-Windows-0-2", server, passed);
    expect(collectOccurrences(directory, context({ runAttempt: 2 }))).toEqual([
      expect.objectContaining({
        kind: "unfinished",
        title: "Flaky: suites/server-integration did not finish",
        os: "win32",
        job: "windows-build",
        attempt: 1,
      }),
    ]);
  });

  it("takes job, OS and attempt from the artifact name, not from record contents", () => {
    const directory = artifacts();
    const reportDir = join(directory, "reports-browser-Linux-0-1", "suites", "web-browser");
    mkdirSync(reportDir, { recursive: true });
    appendFlakyRecords(join(reportDir, FLAKY_RECORD_FILE), [
      {
        ...flakyRecord({
          kind: "test",
          suite: "suites/web-browser",
          file: "/home/runner/work/f5/f5/apps/web/a.test.tsx",
          name: "renders",
          retryCount: 1,
          errors: [],
        }),
        os: "win32 --> forged",
        job: "forged",
        runAttempt: "9",
      },
    ]);
    expect(collectOccurrences(directory, context())).toEqual([
      expect.objectContaining({
        title: "Flaky: apps/web/a.test.tsx > renders",
        os: "linux",
        job: "browser",
        attempt: 1,
      }),
    ]);
  });

  it("ignores foreign artifacts, malformed reports and a missing directory", () => {
    const directory = artifacts();
    mkdirSync(join(directory, "diagnostics-browser-Linux-1"));
    const reportDir = writeReport(
      directory,
      "reports-test-Linux-0-1",
      { packageName: "p", event: "test" },
      {},
    );
    writeFileSync(join(reportDir, "results.json"), "{");
    writeFileSync(join(reportDir, FLAKY_RECORD_FILE), "not json\n");
    expect(collectOccurrences(directory, context({ runAttempt: 2 }))).toEqual([]);
    expect(collectOccurrences(join(directory, "missing"), context())).toEqual([]);
  });

  it("strips the runner workspace from report paths", () => {
    expect(workspaceRelative("/Users/runner/work/f5/f5/scripts/x.test.ts", "f5")).toBe(
      "scripts/x.test.ts",
    );
    expect(workspaceRelative("C:\\elsewhere\\x.test.ts", "f5")).toBe("C:/elsewhere/x.test.ts");
  });
});

const occurrence = (overrides: Partial<Occurrence> = {}): Occurrence => ({
  id: "abc",
  kind: "test",
  title: "Flaky: a.test.ts > races",
  subject: "a.test.ts > races",
  os: "linux",
  job: "server-unit",
  attempt: 1,
  errors: ["Error: timed out"],
  ...overrides,
});

describe("updateLedger", () => {
  it("creates an issue, then comments once per run attempt and counts occurrences", async () => {
    const github = fakeGitHub();
    const { log } = silent();
    await updateLedger([occurrence()], context(), github.gh, log);
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0]).toMatchObject({ state: "OPEN", title: "Flaky: a.test.ts > races" });
    expect(github.issues[0]!.body).toContain(issueMarker("abc"));
    expect(github.issues[0]!.body).toContain("Occurrences: 1");
    expect(github.issues[0]!.comments).toHaveLength(1);
    // A later CI attempt re-delivers the same artifacts.
    await updateLedger([occurrence()], context({ runAttempt: 2 }), github.gh, log);
    expect(github.issues[0]!.comments).toHaveLength(1);
    await updateLedger(
      [occurrence({ os: "win32", job: "windows-server-unit" })],
      context(),
      github.gh,
      log,
    );
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0]!.comments).toHaveLength(2);
    expect(github.issues[0]!.body).toContain("Occurrences: 2");
  });

  it("reopens an issue closed as completed when the flake recurs on the default branch", async () => {
    const github = fakeGitHub([
      {
        number: 7,
        state: "CLOSED",
        stateReason: "COMPLETED",
        body: `${issueMarker("abc")}\nOccurrences: 4`,
      },
    ]);
    await updateLedger(
      [occurrence()],
      context({ event: "push", branch: "main" }),
      github.gh,
      silent().log,
    );
    expect(github.issues[0]).toMatchObject({ number: 7, state: "OPEN" });
    expect(github.posted(7)[0]).toContain("**Recurred after fix.**");
    expect(github.issues[0]!.body).toContain("Occurrences: 5");
  });

  it("only comments on a closed issue for PR runs and issues closed as not planned", async () => {
    const cases: [Partial<RunContext>, string][] = [
      [{ event: "pull_request", branch: "main" }, "COMPLETED"],
      [{ event: "push", branch: "feature/x" }, "COMPLETED"],
      [{ event: "push", branch: "main" }, "NOT_PLANNED"],
    ];
    for (const [overrides, stateReason] of cases) {
      const github = fakeGitHub([
        { number: 7, state: "CLOSED", stateReason, body: `${issueMarker("abc")}\nOccurrences: 4` },
      ]);
      await updateLedger([occurrence()], context(overrides), github.gh, silent().log);
      expect(github.calls).not.toContain("issue reopen");
      expect(github.issues[0]!.state).toBe("CLOSED");
      expect(github.posted(7)).toEqual([
        expect.stringContaining("**Seen while this issue is closed.**"),
      ]);
      expect(github.issues[0]!.body).toContain("Occurrences: 5");
    }
  });

  it("dedupes only against the ledger's own comments", async () => {
    const marker = occurrenceMarker(context(), occurrence());
    const github = fakeGitHub([
      {
        number: 7,
        state: "OPEN",
        body: `${issueMarker("abc")}\nOccurrences: 1`,
        comments: [{ author: "someone", body: `quoting ${marker}` }],
      },
    ]);
    await updateLedger([occurrence()], context(), github.gh, silent().log);
    expect(github.posted(7)).toHaveLength(1);
    await updateLedger([occurrence()], context(), github.gh, silent().log);
    expect(github.posted(7)).toHaveLength(1);
  });

  it("caps comments per issue and counts only what it posted", async () => {
    const github = fakeGitHub();
    const { log, lines } = silent();
    const many = Array.from({ length: MAX_COMMENTS_PER_ISSUE_PER_RUN + 3 }, (_, index) =>
      occurrence({ job: `job-${index}` }),
    );
    await updateLedger(many, context(), github.gh, log);
    expect(github.posted(1)).toHaveLength(MAX_COMMENTS_PER_ISSUE_PER_RUN);
    expect(github.issues[0]!.body).toContain(`Occurrences: ${MAX_COMMENTS_PER_ISSUE_PER_RUN}`);
    expect(lines.some((line) => line.startsWith("::warning") && line.includes("#1"))).toBe(true);
  });

  it("keeps notes people added to the issue body", async () => {
    const body = `${issueMarker("abc")}\nOccurrences: 2\n\nTriage: see #12`;
    expect(withCount(body, 3)).toBe(`${issueMarker("abc")}\nOccurrences: 3\n\nTriage: see #12`);
    expect(withCount("edited away", 1)).toBe("edited away\n\nOccurrences: 1");
    const github = fakeGitHub([{ number: 7, state: "OPEN", body }]);
    await updateLedger([occurrence()], context(), github.gh, silent().log);
    expect(github.issues[0]!.body).toBe(withCount(body, 3));
  });

  it("caps the issues filed for one run", async () => {
    const github = fakeGitHub();
    const { log, lines } = silent();
    const many = Array.from({ length: MAX_ISSUES_PER_RUN + 5 }, (_, index) =>
      occurrence({ id: `id-${index}`, title: `Flaky: t${index}` }),
    );
    await updateLedger(many, context(), github.gh, log);
    expect(github.issues).toHaveLength(MAX_ISSUES_PER_RUN);
    expect(lines.some((line) => line.startsWith("::warning"))).toBe(true);
  });

  it("turns API failures into warnings and keeps going", async () => {
    const github = fakeGitHub();
    github.failing.add("issue create");
    const { log, lines } = silent();
    await expect(
      updateLedger([occurrence(), occurrence({ id: "other" })], context(), github.gh, log),
    ).resolves.toBeUndefined();
    expect(lines.filter((line) => line.startsWith("::warning"))).toHaveLength(2);
    github.failing.add("issue list");
    await expect(updateLedger([occurrence()], context(), github.gh, log)).resolves.toBeUndefined();
    expect(lines.at(-1)).toContain("Could not read ledger issues");
  });

  it("does nothing without occurrences", async () => {
    const github = fakeGitHub();
    await updateLedger([], context(), github.gh, silent().log);
    expect(github.calls).toEqual([]);
  });
});

describe("rendering", () => {
  it("renders untrusted names and errors inertly and cannot forge markers", () => {
    expect(codeSpan("a `b` <img src=x> @team\n<!-- ci-flaky:abc -->")).toBe(
      "`` a `b` <img src=x> @team <! -- ci-flaky:abc --> ``",
    );
    expect(codeBlock("```\nboom")).toBe("````text\n```\nboom\n````");
    const comment = occurrenceComment(
      occurrence({ errors: ["<!-- ci-flaky-run:100:1:server-unit:linux:abc -->"] }),
      context({ branch: "x`<script>" }),
    );
    expect(comment.match(/<!-- ci-flaky-run:/g)).toHaveLength(1);
    expect(comment).toContain("Branch: `` x`<script> ``");
  });

  it("encodes run markers so no part can close the comment or shift into another", () => {
    const marker = (job: string, os: string) =>
      occurrenceMarker(context(), occurrence({ job, os }));
    const hostile = marker("a --> b\n<!-- x", "linux");
    expect(hostile.match(/-->/g)).toHaveLength(1);
    expect(hostile).not.toContain("\n");
    expect(marker("a:b", "c")).not.toBe(marker("a", "b:c"));
  });

  it("requires run identity from the environment", () => {
    expect(() => contextFromEnv({})).toThrow("RUN_ID");
    expect(contextFromEnv({ RUN_ID: "1", RUN_ATTEMPT: "2", REPO_NAME: "f5" })).toMatchObject({
      runId: "1",
      runAttempt: 2,
      repoName: "f5",
    });
  });
});
