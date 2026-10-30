// Files every recorded CI flake as a `ci-flaky` issue, one issue per test.
// Runs from `.github/workflows/ci-flakes.yml` after each of this repository's CI
// runs (never forks). The run's own code wrote the artifacts, so they are parsed
// as untrusted data, never executed, and never trusted for markers or metadata.
//
//   node scripts/ci-flake-ledger.ts <downloaded-artifacts-dir>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { FAILURE_RECORD_FILE, readFlakyRecords, truncateUtf8 } from "./lib/ci-flaky-records.ts";

export const LABEL = "ci-flaky";
export const MAX_ISSUES_PER_RUN = 20;
const MAX_ERRORS = 3;
const MAX_ERROR_BYTES = 2048;
const MAX_TITLE_LENGTH = 200;

export interface RunContext {
  runId: string;
  runAttempt: number;
  conclusion: string;
  branch: string;
  sha: string;
  runUrl: string;
  /** The repository name, which GitHub repeats in its runners' workspace path. */
  repoName: string;
  /** The CI run's trigger, e.g. `push` or `pull_request`. */
  event: string;
  defaultBranch: string;
}

export type OccurrenceKind = "test" | "step" | "rerun" | "unhandled" | "unfinished";

export interface Occurrence {
  id: string;
  kind: OccurrenceKind;
  title: string;
  subject: string;
  os: string;
  job: string;
  attempt: number;
  errors: string[];
}

const ARTIFACT = /^reports-(.+)-(Linux|Windows|macOS)-(\d+)-(\d+)$/;
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
// Downloaded text must not forge the ledger's hidden markers.
const neutralize = (text: string) => text.replaceAll("<!--", "<! --");
const oneLine = (text: string) =>
  neutralize(text)
    .replace(/\p{Cc}+/gu, " ")
    .trim();

/** One issue per test across OSes, shards and both flake sources. */
function testOccurrence(
  kind: "test" | "rerun",
  file: string,
  name: string,
  fields: Pick<Occurrence, "os" | "job" | "attempt" | "errors">,
): Occurrence {
  const subject = `${file} > ${name}`;
  return {
    id: hash(`test|${file}|${name}`),
    kind,
    title: `Flaky: ${subject}`,
    subject,
    ...fields,
  };
}

const cleanErrors = (errors: readonly unknown[]) =>
  errors
    .filter((error): error is string => typeof error === "string" && error.trim().length > 0)
    .slice(0, MAX_ERRORS)
    .map((error) => truncateUtf8(error, MAX_ERROR_BYTES));

/** GitHub checks out to `<work>/<repo>/<repo>/`; keep the repository-relative part. */
export function workspaceRelative(path: string, repoName: string): string {
  const normalized = path.replaceAll("\\", "/");
  const marker = `/${repoName}/${repoName}/`;
  const index = normalized.indexOf(marker);
  return index === -1 ? normalized : normalized.slice(index + marker.length);
}

function walk(directory: string, name: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === name) found.push(path);
    }
  };
  visit(directory);
  return found.sort();
}

// Unit shards rebalance over time; one issue per suite, not per shard.
const unshardedSuite = (suite: string) => suite.replace(/\/(server-unit)-\d+$/, "/$1");

function suiteName(artifactDir: string, report: string): string {
  const parts = relative(artifactDir, report).split(sep).slice(0, -1).map(decodeURIComponent);
  const [packageName = "unknown", event = "unknown"] = parts;
  return unshardedSuite(`${packageName}/${event}`);
}

const unhandledOccurrence = (
  suite: string,
  fields: Pick<Occurrence, "os" | "job" | "attempt" | "errors">,
): Occurrence => ({
  id: hash(`unhandled|${unshardedSuite(suite)}`),
  kind: "unhandled",
  title: `Flaky: unhandled error in ${unshardedSuite(suite)}`,
  subject: `unhandled error in ${unshardedSuite(suite)}`,
  ...fields,
});

/** A flaky pass and a failed attempt of the same step share one issue. */
const stepOccurrence = (
  kind: "step" | "rerun",
  step: string,
  fields: Pick<Occurrence, "os" | "job" | "attempt" | "errors">,
): Occurrence => ({
  id: hash(`step|${step}`),
  kind,
  title: `Flaky step: ${step}`,
  subject: step,
  ...fields,
});

/** Failures that an earlier attempt reported before a later attempt of the run passed. */
function rerunOccurrences(
  artifactDir: string,
  fields: Pick<Occurrence, "os" | "job" | "attempt">,
  context: RunContext,
): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const report of walk(artifactDir, "results.json")) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(report, "utf8"));
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const json = value as {
      success?: unknown;
      numFailedTests?: unknown;
      numFailedTestSuites?: unknown;
      testResults?: unknown;
    };
    const modules = Array.isArray(json.testResults) ? json.testResults : [];
    let failures = 0;
    for (const module of modules as Record<string, unknown>[]) {
      if (!module || typeof module.name !== "string") continue;
      const file = workspaceRelative(module.name, context.repoName);
      const assertions = Array.isArray(module.assertionResults)
        ? (module.assertionResults as Record<string, unknown>[])
        : [];
      const failed = assertions.filter((assertion) => assertion?.status === "failed");
      for (const assertion of failed) {
        const ancestors = Array.isArray(assertion.ancestorTitles)
          ? assertion.ancestorTitles.filter((title): title is string => typeof title === "string")
          : [];
        const title = typeof assertion.title === "string" ? assertion.title : "(unnamed test)";
        const errors = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
        occurrences.push(
          testOccurrence("rerun", file, [...ancestors, title].join(" > "), {
            ...fields,
            errors: cleanErrors(errors),
          }),
        );
        failures++;
      }
      if (!failed.length && module.status === "failed") {
        occurrences.push(
          testOccurrence("rerun", file, "(test file failed to run)", {
            ...fields,
            errors: cleanErrors([module.message]),
          }),
        );
        failures++;
      }
    }
    // Kept for older reports; current Vitest reports success here, so the
    // reporter's explicit `unhandled` record is what normally catches this.
    if (json.success === false && !failures)
      occurrences.push(
        unhandledOccurrence(suiteName(artifactDir, report), { ...fields, errors: [] }),
      );
  }
  for (const record of readFlakyRecords(artifactDir, FAILURE_RECORD_FILE)) {
    if (record.kind === "unhandled")
      occurrences.push(unhandledOccurrence(record.suite, { ...fields, errors: record.errors }));
    else if (record.kind === "step-failure")
      occurrences.push(stepOccurrence("rerun", record.name, { ...fields, errors: record.errors }));
  }
  return occurrences;
}

/** Suite reports present in `later` but absent in `earlier`: killed before reporting. */
function unfinishedSuites(earlier: string, later: string): string[] {
  const suites = (dir: string) =>
    new Set(walk(dir, "results.json").map((report) => relative(dir, report)));
  const finished = suites(earlier);
  return [...suites(later)].filter((report) => !finished.has(report));
}

const OS_NAMES: Record<string, string> = { Linux: "linux", Windows: "win32", macOS: "darwin" };

export function collectOccurrences(directory: string, context: RunContext): Occurrence[] {
  const occurrences: Occurrence[] = [];
  let artifacts: { name: string; job: string; os: string; key: string; attempt: number }[];
  try {
    artifacts = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const match = ARTIFACT.exec(entry.name);
        if (!match) return [];
        const [, job = "", runnerOs = "", index = "", attempt = ""] = match;
        const os = OS_NAMES[runnerOs] ?? runnerOs;
        return [
          { name: entry.name, job, os, key: `${job}|${os}|${index}`, attempt: Number(attempt) },
        ];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const recoveredByRerun = context.conclusion === "success" && context.runAttempt > 1;
  for (const artifact of artifacts) {
    const artifactDir = join(directory, artifact.name);
    // Job, OS and attempt come from the artifact name the workflow sets, never
    // from record contents, which the run's own code writes.
    const fields = { os: artifact.os, job: artifact.job, attempt: artifact.attempt };
    for (const record of readFlakyRecords(artifactDir)) {
      if (record.kind === "test")
        occurrences.push(
          testOccurrence("test", workspaceRelative(record.file, context.repoName), record.name, {
            ...fields,
            errors: record.errors,
          }),
        );
      else if (record.kind === "step")
        occurrences.push(stepOccurrence("step", record.name, { ...fields, errors: record.errors }));
    }
    if (!recoveredByRerun || artifact.attempt >= context.runAttempt) continue;
    occurrences.push(...rerunOccurrences(artifactDir, fields, context));
    const later = artifacts
      .filter((other) => other.key === artifact.key && other.attempt > artifact.attempt)
      .sort((a, b) => b.attempt - a.attempt)[0];
    if (later)
      for (const report of unfinishedSuites(artifactDir, join(directory, later.name))) {
        const suite = unshardedSuite(
          report.split(sep).slice(0, -1).map(decodeURIComponent).join("/"),
        );
        occurrences.push({
          id: hash(`unfinished|${suite}`),
          kind: "unfinished",
          title: `Flaky: ${suite} did not finish`,
          subject: `${suite} did not finish`,
          ...fields,
          errors: [],
        });
      }
  }
  return occurrences;
}

// --- Rendering --------------------------------------------------------------

const longestRun = (text: string, character: string) =>
  Math.max(0, ...[...text.matchAll(new RegExp(`\\${character}+`, "g"))].map((m) => m[0].length));

/** Inline code renders neither Markdown, HTML nor mentions. */
export function codeSpan(text: string): string {
  const value = oneLine(text) || " ";
  const ticks = "`".repeat(longestRun(value, "`") + 1);
  return `${ticks} ${value} ${ticks}`;
}

export function codeBlock(text: string): string {
  const value = neutralize(text);
  const fence = "`".repeat(Math.max(3, longestRun(value, "`") + 1));
  return `${fence}text\n${value}\n${fence}`;
}

export const issueMarker = (id: string) => `<!-- ci-flaky:${id} -->`;
// encodeURIComponent is injective and emits no `>` or `:`, so a part can neither
// close the comment nor collide with a neighbouring part.
export const occurrenceMarker = (context: RunContext, occurrence: Occurrence) =>
  `<!-- ci-flaky-run:${[
    context.runId,
    occurrence.attempt,
    occurrence.job,
    occurrence.os,
    occurrence.id,
  ]
    .map((part) => encodeURIComponent(String(part)))
    .join(":")} -->`;

export function issueTitle(occurrence: Occurrence): string {
  const title = oneLine(occurrence.title);
  return title.length <= MAX_TITLE_LENGTH ? title : `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

const KIND_LABELS: Record<OccurrenceKind, string> = {
  test: "Failed, then passed on the automatic CI retry",
  step: "CI step failed, then passed on the automatic retry",
  rerun: "Failed in an attempt that a manual rerun turned green",
  unhandled: "Suite failed on an unhandled error in an attempt that a manual rerun turned green",
  unfinished:
    "Suite did not finish (killed before reporting) in an attempt that a manual rerun turned green",
};

export function issueBody(occurrence: Occurrence, count: number): string {
  return [
    issueMarker(occurrence.id),
    `**Flaky in CI:** ${codeSpan(occurrence.subject)}`,
    "",
    `Occurrences: ${count}`,
    "",
    'Maintained by the CI flake ledger (`docs/ci.md`, "Flaky tests"). Fix the root cause in',
    "its own PR with repro-harness evidence (`ci-flake-repro.yml`), then close this issue.",
    "A recurrence reopens it.",
  ].join("\n");
}

export type Recurrence = "none" | "reopened" | "closed";

export function occurrenceComment(
  occurrence: Occurrence,
  context: RunContext,
  recurrence: Recurrence = "none",
): string {
  const lines = [
    occurrenceMarker(context, occurrence),
    ...(recurrence === "reopened" ? ["**Recurred after fix.**", ""] : []),
    ...(recurrence === "closed"
      ? [
          "**Seen while this issue is closed.** Not reopened: only a default-branch run reopens an issue closed as completed.",
          "",
        ]
      : []),
    `**${KIND_LABELS[occurrence.kind]}**`,
    "",
    `- OS: ${codeSpan(occurrence.os)}, job: ${codeSpan(occurrence.job)}, attempt ${occurrence.attempt}`,
    `- Branch: ${codeSpan(context.branch)}, commit: ${codeSpan(context.sha.slice(0, 12))}`,
    `- Run: ${context.runUrl}`,
  ];
  if (occurrence.errors.length)
    lines.push(
      "",
      "<details><summary>First failure</summary>",
      "",
      codeBlock(occurrence.errors.join("\n\n")),
      "",
      "</details>",
    );
  return lines.join("\n");
}

// --- GitHub -------------------------------------------------------------------

export type Gh = (args: readonly string[], input?: string) => Promise<string>;

export const runGh: Gh = (args, input) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolvePromise(stdout)
        : reject(new Error(`gh ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr.trim()}`)),
    );
    child.stdin.end(input ?? "");
  });

interface Issue {
  number: number;
  state: string;
  stateReason?: string | null;
  body: string;
}

/** The ledger's own comments; anyone can comment, so only these count as recorded. */
export const LEDGER_AUTHOR = "github-actions[bot]";
export const MAX_COMMENTS_PER_ISSUE_PER_RUN = 5;

const COUNT_LINE = /^Occurrences: (\d+)$/m;
const countIn = (body: string) => Number(COUNT_LINE.exec(body)?.[1] ?? 0);
/** Updates only the count line, keeping any triage notes people added to the body. */
export const withCount = (body: string, count: number) =>
  COUNT_LINE.test(body)
    ? body.replace(COUNT_LINE, `Occurrences: ${count}`)
    : `${body}\n\nOccurrences: ${count}`;

/** Stale PR branches must not reopen an issue whose fix they predate. */
const mayReopen = (issue: Issue, context: RunContext) =>
  context.event !== "pull_request" &&
  context.branch === context.defaultBranch &&
  (issue.stateReason || "COMPLETED").toUpperCase() === "COMPLETED";

/** Never throws: an API failure must not turn a CI result red. */
export async function updateLedger(
  occurrences: readonly Occurrence[],
  context: RunContext,
  gh: Gh,
  log: (message: string) => void = console.log,
): Promise<void> {
  const warn = (message: string) => log(`::warning title=CI flake ledger::${message}`);
  const byId = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences)
    byId.set(occurrence.id, [...(byId.get(occurrence.id) ?? []), occurrence]);
  if (!byId.size) {
    log("No flaky tests recorded for this run.");
    return;
  }
  const ids = [...byId.keys()];
  if (ids.length > MAX_ISSUES_PER_RUN)
    warn(
      `${ids.length} flaky tests in one run; filing the first ${MAX_ISSUES_PER_RUN}. A run this broken usually is not flaky.`,
    );
  let issues: Issue[];
  try {
    await gh([
      "label",
      "create",
      LABEL,
      "--color",
      "FBCA04",
      "--description",
      "Test or CI step that passed only on a retry",
      "--force",
    ]);
    issues = JSON.parse(
      await gh([
        "issue",
        "list",
        "--label",
        LABEL,
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,state,stateReason,body",
      ]),
    ) as Issue[];
  } catch (error) {
    warn(`Could not read ledger issues: ${(error as Error).message}`);
    return;
  }
  for (const id of ids.slice(0, MAX_ISSUES_PER_RUN)) {
    const group = byId.get(id)!;
    try {
      const matches = issues.filter((issue) => issue.body?.includes(issueMarker(id)));
      let issue = matches.find((candidate) => candidate.state === "OPEN") ?? matches[0];
      let recurrence: Recurrence = "none";
      let existingComments = "";
      if (!issue) {
        const url = await gh(
          [
            "issue",
            "create",
            "--title",
            issueTitle(group[0]!),
            "--label",
            LABEL,
            "--body-file",
            "-",
          ],
          issueBody(group[0]!, 0),
        );
        const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
        if (!Number.isSafeInteger(number)) throw new Error(`Unexpected issue URL: ${url.trim()}`);
        issue = { number, state: "OPEN", body: issueBody(group[0]!, 0) };
        issues.push(issue);
      } else {
        existingComments = await gh([
          "api",
          "--paginate",
          `repos/{owner}/{repo}/issues/${issue.number}/comments`,
          "--jq",
          `.[] | select(.user.login == "${LEDGER_AUTHOR}") | .body`,
        ]);
      }
      // Each CI attempt re-triggers the ledger with all earlier attempts' artifacts.
      const seen = new Set<string>();
      const fresh = group.filter((occurrence) => {
        const marker = occurrenceMarker(context, occurrence);
        if (seen.has(marker) || existingComments.includes(marker)) return false;
        seen.add(marker);
        return true;
      });
      if (!fresh.length) continue;
      if (issue.state !== "OPEN") {
        if (mayReopen(issue, context)) {
          await gh(["issue", "reopen", String(issue.number)]);
          issue.state = "OPEN";
          recurrence = "reopened";
        } else recurrence = "closed";
      }
      const commented = fresh.slice(0, MAX_COMMENTS_PER_ISSUE_PER_RUN);
      if (fresh.length > commented.length)
        warn(
          `#${issue.number}: ${fresh.length} occurrences in one run; commenting on ${commented.length}.`,
        );
      for (const [index, occurrence] of commented.entries())
        await gh(
          ["issue", "comment", String(issue.number), "--body-file", "-"],
          occurrenceComment(occurrence, context, index === 0 ? recurrence : "none"),
        );
      // Uncommented occurrences are not deduplicated later, so count only what was posted.
      issue.body = withCount(issue.body, countIn(issue.body) + commented.length);
      await gh(["issue", "edit", String(issue.number), "--body-file", "-"], issue.body);
      log(
        `Recorded ${commented.length} occurrence(s) on #${issue.number}: ${issueTitle(group[0]!)}`,
      );
    } catch (error) {
      warn(`Could not record ${issueTitle(group[0]!)}: ${(error as Error).message}`);
    }
  }
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): RunContext {
  const runAttempt = Number(env.RUN_ATTEMPT);
  if (!env.RUN_ID || !Number.isSafeInteger(runAttempt) || runAttempt < 1)
    throw new Error("RUN_ID and RUN_ATTEMPT are required");
  return {
    runId: env.RUN_ID,
    runAttempt,
    conclusion: env.RUN_CONCLUSION ?? "",
    branch: env.HEAD_BRANCH ?? "",
    sha: env.HEAD_SHA ?? "",
    runUrl: env.RUN_URL ?? "",
    repoName: env.REPO_NAME ?? "",
    event: env.RUN_EVENT ?? "",
    defaultBranch: env.DEFAULT_BRANCH ?? "",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const context = contextFromEnv();
    const occurrences = collectOccurrences(resolve(process.argv[2] ?? "."), context);
    await updateLedger(occurrences, context, runGh);
  } catch (error) {
    console.log(`::warning title=CI flake ledger::${(error as Error).message}`);
  }
}
