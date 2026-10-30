// Repeats a test command with CI retries disabled, so a flake fix can show
// evidence such as 30/30 passes on the hosted OS where the test flaked.
//
//   node scripts/ci-repeat.ts --times 30 [--fail-fast] -- bun run --cwd apps/server test:file x.test.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "./ci-retry-once.ts";

export const MAX_REPEATS = 100;

export interface RepeatOptions {
  times: number;
  failFast: boolean;
  command: readonly string[];
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  now?: () => number;
}

export interface RepeatResult {
  runs: { iteration: number; code: number; durationMs: number }[];
  passed: number;
  failed: number;
}

export async function repeat(options: RepeatOptions): Promise<RepeatResult> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const now = options.now ?? Date.now;
  // Every iteration must see the test's own outcome, not a retry's.
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), F5_CI_TEST_RETRY: "0" };
  const runs: RepeatResult["runs"] = [];
  for (let iteration = 1; iteration <= options.times; iteration++) {
    write(`::group::Iteration ${iteration}/${options.times}\n`);
    const started = now();
    // A later passing iteration must not overwrite a failure's diagnostics.
    const iterationEnv = env.F5_CI_ARTIFACT_DIR
      ? { ...env, F5_CI_ARTIFACT_DIR: join(env.F5_CI_ARTIFACT_DIR, `iteration-${iteration}`) }
      : env;
    const { code } = await runCommand(options.command, iterationEnv, write);
    runs.push({ iteration, code, durationMs: now() - started });
    write(
      `::endgroup::\n${code === 0 ? "passed" : `FAILED (exit ${code})`}: iteration ${iteration}\n`,
    );
    if (code !== 0 && options.failFast) break;
  }
  const failed = runs.filter((run) => run.code !== 0).length;
  return { runs, passed: runs.length - failed, failed };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Durations matter as much as the tally: they justify, or refute, a timeout change. */
export function renderSummary(result: RepeatResult, command: readonly string[]): string {
  const durations = result.runs.map((run) => run.durationMs).sort((a, b) => a - b);
  const percentile = (p: number) =>
    durations[Math.min(durations.length - 1, Math.ceil((p / 100) * durations.length) - 1)] ?? 0;
  const failures = result.runs.filter((run) => run.code !== 0);
  return [
    "",
    `### Repeat: ${result.passed}/${result.runs.length} passed`,
    "",
    `Command: \`${command.join(" ").replaceAll("`", "'")}\``,
    "",
    "| Passed | Failed | Min | Median | p90 | Max |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${result.passed} | ${result.failed} | ${seconds(durations[0] ?? 0)} | ${seconds(percentile(50))} | ${seconds(percentile(90))} | ${seconds(durations.at(-1) ?? 0)} |`,
    ...(failures.length
      ? [
          "",
          `Failed iterations: ${failures.map((run) => `${run.iteration} (exit ${run.code})`).join(", ")}`,
        ]
      : []),
    "",
  ].join("\n");
}

export function parseArgs(argv: readonly string[]): {
  times: number;
  failFast: boolean;
  command: string[];
} {
  const separator = argv.indexOf("--");
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const timesIndex = flags.indexOf("--times");
  const times = Number(timesIndex === -1 ? undefined : flags[timesIndex + 1]);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  if (!Number.isSafeInteger(times) || times < 1 || times > MAX_REPEATS || !command.length)
    throw new Error(`Usage: ci-repeat.ts --times <1-${MAX_REPEATS}> [--fail-fast] -- <command...>`);
  return { times, failFast: flags.includes("--fail-fast"), command };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = await repeat(args);
  const summary = renderSummary(result, args.command);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    mkdirSync(dirname(process.env.GITHUB_STEP_SUMMARY), { recursive: true });
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  if (result.failed) process.exitCode = 1;
}
