#!/usr/bin/env bun
/**
 * run-demo.ts — One-shot launcher that puts F5 into "demo mode" for
 * screenshots:
 *
 *   1. Wipes and recreates an isolated state directory under /tmp/f5-demo/.
 *   2. Builds the desktop + server bundles if they are missing.
 *   3. Runs `seed-demo.ts` against the isolated state dir.
 *   4. Launches the prebuilt desktop app pointed at the isolated state dir,
 *      with auto-update disabled.
 *
 * The user's real database at ~/.t3/userdata/ is never read or written.
 *
 * Usage:
 *   bun run scripts/run-demo.ts
 *
 * Override the demo state dir (rarely needed — the default is fine):
 *   T3CODE_DEMO_STATE_DIR=/tmp/screenshots/state bun run scripts/run-demo.ts
 */
import { spawn, spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const REPO_ROOT = Path.resolve(import.meta.dirname, "..");
const DEFAULT_STATE_DIR = "/tmp/f5-demo/state";
const STATE_DIR = process.env.T3CODE_DEMO_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
const DEMO_ROOT = Path.dirname(STATE_DIR);

// ---------------------------------------------------------------------------
// Safety guard. Make absolutely sure we never point this at the real F5 dir.
// ---------------------------------------------------------------------------

const REAL_USERDATA = Path.join(OS.homedir(), ".t3", "userdata");
const REAL_DEV = Path.join(OS.homedir(), ".t3", "dev");
const REAL_BASE = Path.join(OS.homedir(), ".t3");
const normalized = Path.resolve(STATE_DIR);
if (
  normalized === REAL_USERDATA ||
  normalized === REAL_DEV ||
  normalized.startsWith(REAL_BASE + Path.sep) ||
  normalized === REAL_BASE
) {
  console.error(
    `[run-demo] Refusing to run: demo state dir (${STATE_DIR}) overlaps with the real F5 directory (${REAL_BASE}).`,
  );
  process.exit(1);
}

console.log(`[run-demo] demo root : ${DEMO_ROOT}`);
console.log(`[run-demo] state dir : ${STATE_DIR}`);

// ---------------------------------------------------------------------------
// 1. Reset the demo dir.
// ---------------------------------------------------------------------------

if (FS.existsSync(DEMO_ROOT)) {
  console.log(`[run-demo] removing previous demo dir at ${DEMO_ROOT}`);
  FS.rmSync(DEMO_ROOT, { recursive: true, force: true });
}
FS.mkdirSync(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 2. Make sure the desktop + server bundles exist. The desktop launches the
//    prebuilt server from `apps/server/dist/index.mjs` and the prebuilt
//    Electron main from `apps/desktop/dist-electron/main.js`. If either is
//    missing, a `bun run build:desktop` rebuilds both.
// ---------------------------------------------------------------------------

const desktopBundle = Path.join(REPO_ROOT, "apps/desktop/dist-electron/main.js");
const serverBundle = Path.join(REPO_ROOT, "apps/server/dist/index.mjs");
if (!FS.existsSync(desktopBundle) || !FS.existsSync(serverBundle)) {
  console.log("[run-demo] building desktop + server bundles (this can take a minute)...");
  const built = spawnSync("bun", ["run", "build:desktop"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (built.status !== 0) {
    console.error(`[run-demo] build:desktop failed with exit code ${built.status}`);
    process.exit(built.status ?? 1);
  }
} else {
  console.log("[run-demo] desktop + server bundles already exist; skipping build");
}

// ---------------------------------------------------------------------------
// 3. Seed the isolated state dir.
// ---------------------------------------------------------------------------

console.log("[run-demo] seeding fake demo data...");
const seeded = spawnSync("bun", ["run", Path.join(REPO_ROOT, "apps/server/scripts/seed-demo.ts")], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    T3CODE_STATE_DIR: STATE_DIR,
  },
});
if (seeded.status !== 0) {
  console.error(`[run-demo] seed-demo failed with exit code ${seeded.status}`);
  process.exit(seeded.status ?? 1);
}

// ---------------------------------------------------------------------------
// 4. Launch the prebuilt desktop app pointed at the demo state dir.
//    Auto-updater disabled so screenshots never get interrupted by an
//    update prompt and no surprise network traffic happens during the run.
// ---------------------------------------------------------------------------

console.log("[run-demo] launching desktop app — Cmd+Shift+4 to take screenshots, Ctrl+C to exit");

const desktop = spawn("bun", ["run", "start:desktop"], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    T3CODE_STATE_DIR: STATE_DIR,
    T3CODE_DISABLE_AUTO_UPDATE: "1",
    T3CODE_NO_BROWSER: "1",
    // Force observability off so no telemetry pings happen during the
    // demo session, even if the user has it on globally.
    T3CODE_OBSERVABILITY_ENABLED: "0",
  },
});

const forwardSignal = (signal: NodeJS.Signals) => {
  if (!desktop.killed) {
    desktop.kill(signal);
  }
};
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

desktop.on("exit", (code, signal) => {
  console.log(`\n[run-demo] desktop exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  console.log(`[run-demo] to clean up: rm -rf ${DEMO_ROOT}`);
  process.exit(code ?? 0);
});
