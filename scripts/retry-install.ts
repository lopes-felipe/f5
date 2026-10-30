// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
export function transientInstallFailure(output: string): boolean {
  return (
    !/frozen lockfile|lockfile had changes|integrity|checksum|SyntaxError|postinstall.*failed/i.test(
      output,
    ) &&
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|HTTP 50[234]|Failed to install \d+ packages?/i.test(
      output,
    )
  );
}
async function install(
  args: string[],
): Promise<{ status: number; output: string; signal: NodeJS.Signals | null }> {
  // Stream progress and retain a bounded diagnostic tail. In particular, cold
  // native Windows ARM64 installs keep the existing job budget instead of a new
  // short timeout around the complete dependency/native-build operation.
  const child = spawn("bun", ["install", ...args], {
    shell: process.platform === "win32",
    stdio: ["inherit", "pipe", "pipe"],
  });
  let output = "";
  const record = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    const text = chunk.toString();
    stream.write(text);
    output = (output + text).slice(-2 * 1024 * 1024);
  };
  child.stdout.on("data", (chunk) => record(chunk, process.stdout));
  child.stderr.on("data", (chunk) => record(chunk, process.stderr));
  return await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error.message);
      resolve({ status: 1, output: output + "\n" + error.message, signal: null });
    });
    child.once("close", (code, signal) => resolve({ status: code ?? 1, output, signal }));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const supplied = process.argv.slice(2);
  const args = supplied.length ? supplied : ["--frozen-lockfile"];
  if (
    args.some(
      (a) =>
        ![
          "--frozen-lockfile",
          "--production",
          "--lockfile-only",
          "--ignore-scripts",
          "--linker",
          "hoisted",
        ].includes(a),
    ) ||
    (!args.includes("--frozen-lockfile") &&
      !(args.includes("--lockfile-only") && args.includes("--ignore-scripts")))
  )
    throw new Error("Only frozen installs or script-free lockfile resolution can be retried");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await install(args);
    const output = result.output;
    if (result.status === 0) {
      if (attempt === 2 && process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          "\nDependency installation recovered on its single transient retry.\n",
        );
      break;
    }
    if (result.signal || attempt === 2 || !transientInstallFailure(output)) {
      process.exitCode = result.status ?? 1;
      break;
    }
    console.log("::warning::Transient dependency install failure; retrying once.");
  }
}
