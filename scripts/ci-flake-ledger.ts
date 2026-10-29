// Files every recorded CI flake as a `ci-flaky` issue, one issue per test.
// Runs from `.github/workflows/ci-flakes.yml` after each CI run. Artifacts can come
// from any PR, so they are parsed as untrusted data and never executed.
//
//   node scripts/ci-flake-ledger.ts <downloaded-artifacts-dir>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readFlakyRecords, truncateUtf8 } from "./lib/ci-flaky-records.ts";

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
}

export type OccurrenceKind = "test" | "step" | "rerun" | "unhandled";

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

function suiteName(artifactDir: string, report: string): string {
  const parts = relative(artifactDir, report).split(sep).slice(0, -1).map(decodeURIComponent);
  const [packageName = "unknown", event = "unknown"] = parts;
  // Unit shards rebalance over time; one issue per suite, not per shard.
  return `${packageName}/${event.replace(/^(server-unit)-\d+$/, "$1")}`;
}

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
    if (json.success === false && !failures) {
      const suite = suiteName(artifactDir, report);
      occurrences.push({
        id: hash(`unhandled|${suite}`),
        kind: "unhandled",
        title: `Flaky: unhandled error in ${suite}`,
        subject: `unhandled error in ${suite}`,
        ...fields,
        errors: [],
      });
    }
  }
  return occurrences;
}

const OS_NAMES: Record<string, string> = { Linux: "linux", Windows: "win32", macOS: "darwin" };

export function collectOccurrences(directory: string, context: RunContext): Occurrence[] {
  const occurrences: Occurrence[] = [];
  let artifacts: string[];
  try {
    artifacts = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const recoveredByRerun = context.conclusion === "success" && context.runAttempt > 1;
  for (const artifact of artifacts) {
    const match = ARTIFACT.exec(artifact);
    if (!match) continue;
    const [, job = "", runnerOs = "", , attemptText = ""] = match;
    const artifactDir = join(directory, artifact);
    const attempt = Number(attemptText);
    for (const record of readFlakyRecords(artifactDir)) {
      const fields = {
        os: record.os,
        job: record.job || job,
        attempt: Number(record.runAttempt) || attempt,
        errors: record.errors,
      };
      if (record.kind === "test")
        occurrences.push(testOccurrence("test", record.file, record.name, fields));
      else
        occurrences.push({
          id: hash(`step|${record.name}`),
          kind: "step",
          title: `Flaky step: ${record.name}`,
          subject: record.name,
          ...fields,
        });
    }
    if (recoveredByRerun && attempt < context.runAttempt)
      occurrences.push(
        ...rerunOccurrences(
          artifactDir,
          { os: OS_NAMES[runnerOs] ?? runnerOs, job, attempt },
          context,
        ),
      );
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
export const occurrenceMarker = (context: RunContext, occurrence: Occurrence) =>
  `<!-- ci-flaky-run:${context.runId}:${occurrence.attempt}:${occurrence.job}:${occurrence.os}:${occurrence.id} -->`;

export function issueTitle(occurrence: Occurrence): string {
  const title = oneLine(occurrence.title);
  return title.length <= MAX_TITLE_LENGTH ? title : `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

const KIND_LABELS: Record<OccurrenceKind, string> = {
  test: "Failed, then passed on the automatic CI retry",
  step: "CI step failed, then passed on the automatic retry",
  rerun: "Failed in an attempt that a manual rerun turned green",
  unhandled: "Suite failed on an unhandled error in an attempt that a manual rerun turned green",
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

export function occurrenceComment(
  occurrence: Occurrence,
  context: RunContext,
  reopened: boolean,
): string {
  const lines = [
    occurrenceMarker(context, occurrence),
    ...(reopened ? ["**Recurred after fix.**", ""] : []),
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
  body: string;
}

const countIn = (body: string) => Number(/^Occurrences: (\d+)$/m.exec(body)?.[1] ?? 0);

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
        "number,state,body",
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
      let reopened = false;
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
          ".[].body",
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
        await gh(["issue", "reopen", String(issue.number)]);
        issue.state = "OPEN";
        reopened = true;
      }
      for (const [index, occurrence] of fresh.entries())
        await gh(
          ["issue", "comment", String(issue.number), "--body-file", "-"],
          occurrenceComment(occurrence, context, reopened && index === 0),
        );
      issue.body = issueBody(group[0]!, countIn(issue.body) + fresh.length);
      await gh(["issue", "edit", String(issue.number), "--body-file", "-"], issue.body);
      log(`Recorded ${fresh.length} occurrence(s) on #${issue.number}: ${issueTitle(group[0]!)}`);
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
