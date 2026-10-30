import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { InlineConfig, Reporter, TestModule } from "vitest/node";

// No relative imports: Node runs this file directly through CI scripts, and the
// web project typechecks it without `.ts` import paths.

export interface SuiteIdentity {
  packageName: string;
  event: string;
}

const encode = (value: string) => {
  if (!value.trim() || value === "." || value === "..")
    throw new Error("Invalid CI suite identity");
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
};

export function reportPath(identity: SuiteIdentity): string {
  return join(encode(identity.packageName), encode(identity.event), "results.json");
}

export function ciTestReports(env: NodeJS.ProcessEnv = process.env): InlineConfig {
  if (!env.F5_CI_REPORT_DIR) return {};
  const packageName = env.F5_CI_SUITE_ID ? "suites" : env.npm_package_name;
  const event = env.F5_CI_SUITE_ID || env.npm_lifecycle_event;
  if (!packageName || !event) {
    throw new Error(
      "CI reports require npm_package_name and npm_lifecycle_event, or F5_CI_SUITE_ID",
    );
  }
  const json = resolve(env.F5_CI_REPORT_DIR, reportPath({ packageName, event }));
  return {
    // One CI retry absorbs a transient failure; CiFlakyReporter records it so the
    // flake ledger can file it. Local runs never retry.
    retry: ciTestRetry(env),
    reporters: [
      "default",
      "junit",
      "json",
      new CiFlakyReporter(join(dirname(json), FLAKY_RECORD_FILE), `${packageName}/${event}`),
    ],
    outputFile: { json, junit: json.replace(/\.json$/, ".xml") },
  };
}

/** CI attempts after the first; `F5_CI_TEST_RETRY=0` restores single-attempt runs. */
export function ciTestRetry(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.F5_CI_TEST_RETRY ?? "1";
  if (!/^\d+$/.test(value) || Number(value) > 3)
    throw new Error("F5_CI_TEST_RETRY must be an integer from 0 to 3");
  return Number(value);
}

/** Not `.json`: the CI summary treats every `.json` file as a suite report. */
export const FLAKY_RECORD_FILE = "flaky.jsonl";
/**
 * Failures a retry cannot recover (an unhandled error, or a step that failed every
 * attempt). The ledger files them only when a manual rerun later turned the run green.
 */
export const FAILURE_RECORD_FILE = "failures.jsonl";
export const MAX_FLAKY_ERROR_BYTES = 2048;
const MAX_FLAKY_ERRORS = 3;

/**
 * `test`/`step`: failed, then passed on the automatic retry (in `flaky.jsonl`).
 * `unhandled`/`step-failure`: not recovered within the job (in `failures.jsonl`).
 */
export interface FlakyRecord {
  version: 1;
  kind: "test" | "step" | "unhandled" | "step-failure";
  suite: string;
  file: string;
  name: string;
  retryCount: number;
  os: string;
  job: string;
  runId: string;
  runAttempt: string;
  errors: string[];
}

export function truncateUtf8(text: string, maxBytes: number, keep: "start" | "end" = "start") {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const slice = keep === "start" ? bytes.subarray(0, maxBytes) : bytes.subarray(-maxBytes);
  // A cut can split a multi-byte character; drop the replacement character.
  return slice.toString("utf8").replace(/^\uFFFD|\uFFFD$/g, "");
}

export function flakyRecord(
  fields: Pick<FlakyRecord, "kind" | "suite" | "file" | "name" | "retryCount" | "errors">,
  env: NodeJS.ProcessEnv = process.env,
): FlakyRecord {
  return {
    version: 1,
    ...fields,
    errors: fields.errors.map((error) => truncateUtf8(error, MAX_FLAKY_ERROR_BYTES)),
    os: process.platform,
    job: env.GITHUB_JOB ?? "",
    runId: env.GITHUB_RUN_ID ?? "",
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? "",
  };
}

export function appendFlakyRecords(file: string, records: readonly FlakyRecord[]) {
  if (!records.length) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, records.map((record) => JSON.stringify(record) + "\n").join(""));
}

/**
 * Absolute with `/` separators, as Vitest's JSON report also records it. The ledger
 * normalizes both sources with one function, so one test maps to one issue.
 */
export const posixPath = (path: string) => path.replaceAll("\\", "/");

/** Records each test that passed only on a CI retry, so the retry never hides it. */
export class CiFlakyReporter implements Reporter {
  // Plain fields: Node's type stripping rejects parameter properties.
  private readonly file: string;
  private readonly suite: string;

  constructor(file: string, suite: string) {
    this.file = file;
    this.suite = suite;
  }

  onTestRunEnd(
    modules: readonly TestModule[],
    unhandledErrors: ReadonlyArray<{ message?: string }> = [],
  ) {
    // Vitest's JSON report still says `success: true` for a run that failed only on
    // unhandled errors, so record them explicitly.
    if (unhandledErrors.length)
      appendFlakyRecords(join(dirname(this.file), FAILURE_RECORD_FILE), [
        flakyRecord({
          kind: "unhandled",
          suite: this.suite,
          file: "",
          name: "unhandled error",
          retryCount: 0,
          errors: unhandledErrors
            .slice(0, MAX_FLAKY_ERRORS)
            .map((error) => error.message || String(error)),
        }),
      ]);
    const records: FlakyRecord[] = [];
    for (const module of modules)
      for (const test of module.children.allTests()) {
        const diagnostic = test.diagnostic();
        if (!diagnostic?.flaky) continue;
        // Passed results keep the errors of the attempts that failed first.
        const errors = (test.result().errors ?? [])
          .slice(0, MAX_FLAKY_ERRORS)
          .map((error) => error.message || String(error));
        records.push(
          flakyRecord({
            kind: "test",
            suite: this.suite,
            file: posixPath(module.moduleId),
            name: test.fullName,
            retryCount: diagnostic.retryCount,
            errors,
          }),
        );
      }
    appendFlakyRecords(this.file, records);
  }
}
