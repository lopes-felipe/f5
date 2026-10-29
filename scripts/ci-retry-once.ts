// Runs a non-Vitest CI step and retries it once. A pass on the retry is recorded
// as a flake for the ledger instead of disappearing into a green check.
//
//   node scripts/ci-retry-once.ts --step desktop-smoke -- bun run test:desktop-smoke
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendFlakyRecords,
  FLAKY_RECORD_FILE,
  flakyRecord,
  truncateUtf8,
} from "./lib/ci-flaky-records.ts";
import { ciTestRetry } from "./lib/ci-test-reports.ts";

export const FAILURE_EXCERPT_BYTES = 4096;
// Enough to locate the failure; the full output is already in the job log.
const OUTPUT_TAIL_BYTES = 64 * 1024;

export interface RetryOnceOptions {
  step: string;
  command: readonly string[];
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
}

export interface AttemptResult {
  code: number;
  output: string;
}

/** Streams a command's output through `write` and keeps its tail. */
export function runCommand(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
): Promise<AttemptResult> {
  return new Promise((resolvePromise) => {
    let tail = "";
    const child = spawn(command[0]!, command.slice(1), {
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      write(text);
      tail = truncateUtf8(tail + text, OUTPUT_TAIL_BYTES, "end");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      write(`${error.message}\n`);
      resolvePromise({ code: 127, output: tail + error.message });
    });
    // `close` follows the last output chunk; `exit` can precede it.
    child.once("close", (code, signal) =>
      resolvePromise({ code: code ?? (signal ? 1 : 0), output: tail }),
    );
  });
}

/** Resolves to the step's final exit code. */
export async function runWithRetryOnce(options: RetryOnceOptions): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.step)) throw new Error("Invalid --step id");
  if (!options.command.length) throw new Error("Missing command after --");
  const attempts = 1 + Math.min(ciTestRetry(env), 1);
  const artifactBase = env.F5_CI_ARTIFACT_DIR;
  let first: AttemptResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptEnv = artifactBase
      ? { ...env, F5_CI_ARTIFACT_DIR: join(artifactBase, `attempt-${attempt}`) }
      : env;
    if (attempt > 1) write(`\n::group::Retrying ${options.step} (attempt ${attempt})\n`);
    const result = await runCommand(options.command, attemptEnv, write);
    if (attempt > 1) write("::endgroup::\n");
    if (result.code === 0) {
      if (first) recordRecovery(options.step, first, env, write);
      return 0;
    }
    first ??= result;
    if (attempt === attempts) return result.code;
    write(`\n::warning title=Retrying ${options.step}::First attempt exited ${result.code}\n`);
  }
  return 1;
}

function recordRecovery(
  step: string,
  first: AttemptResult,
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
) {
  write(
    `::warning title=Flaky step::${step} failed with exit ${first.code} and passed on retry; recorded for the flake ledger\n`,
  );
  const reportDir = env.F5_CI_REPORT_DIR;
  if (!reportDir) {
    write("::warning::F5_CI_REPORT_DIR is unset; the flaky step was not recorded\n");
    return;
  }
  appendFlakyRecords(join(reportDir, "steps", step, FLAKY_RECORD_FILE), [
    flakyRecord(
      {
        kind: "step",
        suite: `step/${step}`,
        file: env.GITHUB_JOB || "ci",
        name: step,
        retryCount: 1,
        errors: [truncateUtf8(first.output, FAILURE_EXCERPT_BYTES, "end")],
      },
      env,
    ),
  ]);
  if (env.GITHUB_STEP_SUMMARY) {
    mkdirSync(dirname(env.GITHUB_STEP_SUMMARY), { recursive: true });
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `\n**Flaky step**: \`${step}\` failed (exit ${first.code}) and passed on retry.\n`,
    );
  }
}

export function parseArgs(argv: readonly string[]): { step: string; command: string[] } {
  const separator = argv.indexOf("--");
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const stepIndex = flags.indexOf("--step");
  const step = stepIndex === -1 ? undefined : flags[stepIndex + 1];
  if (!step || separator === -1)
    throw new Error("Usage: ci-retry-once.ts --step <id> -- <command...>");
  return { step, command: argv.slice(separator + 1) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runWithRetryOnce(parseArgs(process.argv.slice(2)));
}
