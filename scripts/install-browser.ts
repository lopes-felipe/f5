import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Use the hosted Linux image's runtime libraries; install OS dependencies on other machines. */
export function browserInstallArgs(environment: NodeJS.ProcessEnv): string[] {
  // GitHub's hosted Linux image already provides Chromium's runtime libraries.
  // Developer machines still need the complete OS dependency installation.
  const hostedLinux = environment.GITHUB_ACTIONS === "true" && environment.RUNNER_OS === "Linux";
  return ["install", ...(hostedLinux ? [] : ["--with-deps"]), "chromium"];
}

if (import.meta.main) {
  const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
  const cli = join(dirname(webRequire.resolve("playwright/package.json")), "cli.js");
  const result = spawnSync(
    process.execPath,
    [cli, ...browserInstallArgs(process.env), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}
