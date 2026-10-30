// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
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
    const result = spawnSync("bun", ["install", ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    process.stdout.write(output);
    if (result.status === 0) {
      if (attempt === 2 && process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          "\nDependency installation recovered on its single transient retry.\n",
        );
      break;
    }
    if (attempt === 2 || !transientInstallFailure(output)) {
      process.exitCode = result.status ?? 1;
      break;
    }
    console.log("::warning::Transient dependency install failure; retrying once.");
  }
}
