import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reportPath, type SuiteIdentity } from "./lib/ci-test-reports.ts";
import { classifyReport, type SuiteSummary } from "./lib/ci-test-report-validation.ts";
import { readFlakyRecords, type FlakyRecord } from "./lib/ci-flaky-records.ts";

export {
  classifyReport,
  type Verdict,
  type SuiteSummary,
} from "./lib/ci-test-report-validation.ts";

const workspaces: SuiteIdentity[] = [
  "@t3tools/contracts",
  "@t3tools/shared",
  "effect-acp",
  "@t3tools/scripts",
  "@t3tools/web",
  "@t3tools/desktop",
  "@t3tools/marketing",
].map((packageName) => ({ packageName, event: "test" }));
const suite = (event: string): SuiteIdentity => ({ packageName: "suites", event });
const server = ["server-git-smoke", "server-integration"].map(suite);
export const inventories: Record<string, SuiteIdentity[]> = {
  test: [...workspaces, ...server, suite("server-git-extended")],
  "windows-build": [...workspaces, ...server],
  "macos-suite": [...workspaces, ...server, suite("server-git-extended"), suite("server-unit")],
  "server-unit-1": [suite("server-unit-1")],
  "server-unit-2": [suite("server-unit-2")],
  "server-unit-3": [suite("server-unit-3")],
  browser: [suite("web-browser")],
  "macos-profiles": [suite("macos-profiles")],
};

export function summarize(directory: string, expected: SuiteIdentity[]): SuiteSummary[] {
  const reports: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".json")) reports.push(relative(directory, file));
    }
  }
  try {
    walk(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const expectedPaths = new Set(expected.map(reportPath));
  const results = expected.map((identity) => {
    const file = reportPath(identity);
    try {
      return classifyReport(
        JSON.parse(readFileSync(join(directory, file), "utf8")),
        `${identity.packageName}/${identity.event}`,
      );
    } catch {
      return {
        name: file,
        verdict: "incomplete" as const,
        passed: 0,
        failed: 0,
        skipped: 0,
        detail: "Missing or malformed JSON",
      };
    }
  });
  for (const file of reports)
    if (!expectedPaths.has(file))
      results.push({
        name: file,
        verdict: "incomplete",
        passed: 0,
        failed: 0,
        skipped: 0,
        detail: "Unexpected or duplicate report",
      });
  return results;
}

const escapeCell = (text: string) =>
  text
    .replace(/[|\r\n]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
// GitHub workflow-command data and property escapes.
const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) =>
  escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

/** Records keep absolute test paths; show them relative to the checkout. */
export const displayPath = (file: string, workspace = process.env.GITHUB_WORKSPACE) => {
  const root = workspace?.replaceAll("\\", "/").replace(/\/?$/, "/");
  return root && file.startsWith(root) ? file.slice(root.length) : file;
};

/** Flaky passes stay visible on the PR without changing the job verdict. */
export function renderFlaky(
  flaky: readonly FlakyRecord[],
  workspace = process.env.GITHUB_WORKSPACE,
): {
  markdown: string;
  annotations: string[];
} {
  const records = flaky.map((record) => ({ ...record, file: displayPath(record.file, workspace) }));
  if (!records.length) return { markdown: "", annotations: [] };
  const markdown =
    "\n**Passed on retry (flaky)**: recorded for the flake ledger; please fix rather than rerun.\n\n" +
    "| Suite | Kind | Test | Retries |\n| --- | --- | --- | ---: |\n" +
    records
      .map(
        (record) =>
          `| ${escapeCell(record.suite)} | ${record.kind} | ${escapeCell(`${record.file} > ${record.name}`)} | ${record.retryCount} |`,
      )
      .join("\n") +
    "\n";
  // ci-retry-once annotates its own step records when it recovers.
  const annotations = records
    .filter((record) => record.kind === "test")
    .map(
      (record) =>
        `::warning title=${escapeProperty("Flaky test")}::${escapeData(`${record.suite} ${record.file} > ${record.name}`)}`,
    );
  return { markdown, annotations };
}

function main() {
  const directory = process.env.F5_CI_REPORT_DIR;
  if (!directory) throw new Error("F5_CI_REPORT_DIR is required");
  if (process.argv[2] === "--prepare") {
    // Only this job's runner-temp directory may be cleared, never another job's reports.
    const runnerTemp = process.env.RUNNER_TEMP;
    if (
      !runnerTemp ||
      (!resolve(directory).startsWith(resolve(runnerTemp) + "/") &&
        !resolve(directory).startsWith(resolve(runnerTemp) + "\\"))
    )
      throw new Error("Reports must be below RUNNER_TEMP");
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    return;
  }
  const expected = inventories[process.argv[2] ?? ""];
  if (!expected?.length) throw new Error("Unknown or empty suite inventory");
  const results = summarize(directory, expected);
  const flaky = renderFlaky(readFlakyRecords(directory));
  const markdown =
    "\n| Suite | Result | Passed | Failed | Skipped | Detail |\n| --- | --- | ---: | ---: | ---: | --- |\n" +
    results
      .map(
        (result) =>
          `| ${escapeCell(result.name)} | ${result.verdict} | ${result.passed} | ${result.failed} | ${result.skipped} | ${escapeCell(result.detail)} |`,
      )
      .join("\n") +
    "\n" +
    flaky.markdown;
  console.log(markdown);
  for (const annotation of flaky.annotations) console.log(annotation);
  if (process.env.GITHUB_STEP_SUMMARY) {
    mkdirSync(dirname(process.env.GITHUB_STEP_SUMMARY), { recursive: true });
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  if (results.some((result) => result.verdict !== "passed")) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
