#!/usr/bin/env bun
/**
 * run-demo.ts: one-shot launcher that puts F5 into "demo mode" for manual
 * desktop screenshots:
 *
 *   1. Creates a fresh sandbox root under the OS temp dir (`f5-demo-*`) with
 *      its own state dir and an empty HOME. Roots are never reused or deleted.
 *   2. Builds the desktop + server bundles (skip with `--skip-build`).
 *   3. Runs `seed-demo.ts` against the sandbox state dir.
 *   4. Launches the prebuilt desktop app pointed at the sandbox, with
 *      auto-update disabled and an allowlisted environment, so provider
 *      credentials from your shell never reach the demo.
 *
 * The user's real F5 and legacy T3 state directories are never read or written.
 *
 * Usage:
 *   bun run scripts/run-demo.ts [--skip-build]
 *
 * For automated README screenshots use `bun run screenshots:capture` instead.
 */
import { spawn, spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { isRunning, waitForChild } from "./lib/child-lifecycle.ts";
import {
  createDemoRoot,
  demoStateDir,
  isolatedEnv,
  writeDemoSettings,
} from "./lib/demo-sandbox.ts";

const REPO_ROOT = Path.resolve(import.meta.dirname, "..");
const skipBuild = process.argv.includes("--skip-build");

if (process.env.T3CODE_DEMO_STATE_DIR?.trim()) {
  console.error(
    "[run-demo] T3CODE_DEMO_STATE_DIR is no longer supported: each run now gets a fresh temp root. Unset it and rerun.",
  );
  process.exit(1);
}

const DEMO_ROOT = createDemoRoot("f5-demo-");
const STATE_DIR = demoStateDir(DEMO_ROOT);
writeDemoSettings(DEMO_ROOT);
const env = isolatedEnv(DEMO_ROOT, { F5_SKIP_USERDATA_IMPORT: "1" });

console.log(`[run-demo] demo root : ${DEMO_ROOT}`);
console.log(`[run-demo] state dir : ${STATE_DIR}`);

// ---------------------------------------------------------------------------
// 1. Build the desktop + server bundles. The desktop launches the prebuilt
//    server from `apps/server/dist/index.mjs` and the prebuilt Electron main
//    from `apps/desktop/dist-electron/main.js`.
// ---------------------------------------------------------------------------

if (skipBuild) {
  console.log("[run-demo] --skip-build: using existing desktop + server bundles");
} else {
  console.log("[run-demo] building desktop + server bundles (this can take a minute)...");
  const built = spawnSync("bun", ["run", "build:desktop"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (built.status !== 0) {
    console.error(`[run-demo] build:desktop failed with exit code ${built.status}`);
    process.exit(built.status ?? 1);
  }
}

for (const bundle of ["apps/desktop/dist-electron/main.js", "apps/server/dist/index.mjs"]) {
  if (!FS.existsSync(Path.join(REPO_ROOT, bundle))) {
    console.error(`[run-demo] missing ${bundle}; rerun without --skip-build`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 2. Seed the sandbox state dir.
// ---------------------------------------------------------------------------

console.log("[run-demo] seeding fake demo data...");
const seeded = spawnSync("bun", ["run", Path.join(REPO_ROOT, "apps/server/scripts/seed-demo.ts")], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env,
});
if (seeded.status !== 0) {
  console.error(`[run-demo] seed-demo failed with exit code ${seeded.status}`);
  process.exit(seeded.status ?? 1);
}

// ---------------------------------------------------------------------------
// 3. Launch the prebuilt desktop app pointed at the sandbox.
// ---------------------------------------------------------------------------

console.log("[run-demo] launching desktop app. Cmd+Shift+4 to take screenshots, Ctrl+C to exit");

// Launch Electron directly rather than through turbo: turbo's `start` task
// rebuilds first and filters the environment, which would drop sandbox
// variables such as F5_SKIP_USERDATA_IMPORT and T3CODE_DISABLE_AUTO_UPDATE.
const desktop = spawn("bun", ["run", "scripts/start-electron.mjs"], {
  cwd: Path.join(REPO_ROOT, "apps/desktop"),
  stdio: "inherit",
  env,
});

// Forward every signal while the app runs, so a second Ctrl+C still reaches a
// child that ignored the first.
const forwardSignal = (signal: NodeJS.Signals) => {
  if (isRunning(desktop)) desktop.kill(signal);
};
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

try {
  const { code, signal } = await waitForChild(desktop);
  console.log(`\n[run-demo] desktop exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  process.exitCode = code ?? 0;
} catch (error) {
  console.error(
    `[run-demo] could not launch the desktop app: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  console.log(`[run-demo] demo data kept at ${DEMO_ROOT}`);
}
process.exit();
