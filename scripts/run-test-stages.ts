import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Run every suite, retaining its own reporter and inventory checks. */
export async function runTestStages(stages: readonly string[]): Promise<number> {
  let failed = false;
  const results: Array<{ stage: string; code: number }> = [];
  for (const stage of stages) {
    const code = await new Promise<number>((resolve) => {
      const child = spawn("bun", ["run", stage], { stdio: "inherit" });
      child.once("error", (error) => {
        console.error(`Could not run ${stage}:`, error.message);
        resolve(1);
      });
      child.once("exit", (exitCode, signal) => {
        if (signal) console.error(`${stage} terminated by ${signal}`);
        resolve(exitCode ?? 1);
      });
    });
    results.push({ stage, code });
    failed ||= code !== 0;
  }
  console.log("Test stage results:");
  for (const { stage, code } of results) console.log(`  ${stage}: exit ${code}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stages = process.argv.slice(2);
  if (stages.length === 0) {
    console.error("Usage: node run-test-stages.ts <script> [script...]");
    process.exitCode = 1;
  } else {
    process.exitCode = await runTestStages(stages);
  }
}
