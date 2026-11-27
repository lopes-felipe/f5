const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const verifyComputerHelper = require("./verify-computer-helper.cjs").default;
const { verifyClaudeRuntime } = require("./verify-claude-runtime.cjs");

// Apple's notary and ticket services drop connections from CI runners (NSURLErrorDomain
// -1005), and @electron/notarize retries stapling for only a few seconds.
const SUBMIT_ATTEMPTS = 3;
const STAPLE_ATTEMPTS = 6;
const RETRY_DELAY_MS = 15_000;
const MAX_RETRY_DELAY_MS = 60_000;

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  return Math.min(attempt * RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
}

async function retry(attempts, sleep, label, action) {
  for (let attempt = 1; ; attempt++) {
    if (action()) return;
    if (attempt >= attempts) throw new Error(`${label} failed after ${attempts} attempts`);
    const delay = retryDelay(attempt);
    console.warn(`${label} failed (attempt ${attempt}/${attempts}); retrying in ${delay / 1000}s`);
    await sleep(delay);
  }
}

function parseSubmission(stdout) {
  const text = stdout.trim();
  for (const candidate of [text, text.split("\n").at(-1) ?? ""]) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {}
  }
  return undefined;
}

/** Notarizes the signed app and staples its ticket, retrying Apple's flaky network calls. */
async function notarizeAndStaple(app, env, { run = defaultRun, sleep = defaultSleep } = {}) {
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = env;
  if (!key || !keyId || !issuer)
    throw new Error("Notarization requires APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER");
  const workDir = mkdtempSync(join(tmpdir(), "f5-notarize-"));
  try {
    const archive = join(workDir, `${basename(app, ".app")}.zip`);
    if (run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]).status !== 0)
      throw new Error(`Failed to archive ${app} for notarization`);
    const credentials = ["--key", key, "--key-id", keyId, "--issuer", issuer];
    let submission;
    await retry(SUBMIT_ATTEMPTS, sleep, "Notarization submission", () => {
      const result = run("xcrun", [
        "notarytool",
        "submit",
        archive,
        ...credentials,
        "--wait",
        "--output-format",
        "json",
      ]);
      submission = parseSubmission(result.stdout);
      // A completed but rejected submission is final; only retry when no verdict came back.
      return submission?.status !== undefined && submission.status !== "In Progress";
    });
    if (submission.status !== "Accepted") {
      if (submission.id) run("xcrun", ["notarytool", "log", submission.id, ...credentials]);
      throw new Error(
        `Notarization ${submission.id ?? ""} finished with status ${submission.status}`,
      );
    }
    console.log(`Notarization ${submission.id} accepted`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  await retry(
    STAPLE_ATTEMPTS,
    sleep,
    "Stapling",
    () =>
      run("xcrun", ["stapler", "staple", "-v", basename(app)], { cwd: dirname(app) }).status === 0,
  );
}
exports.notarizeAndStaple = notarizeAndStaple;

/** Runs a command and returns its exit status with stdout and stderr together. */
function captureRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.error ? null : result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** The signing details `codesign -dvvv` prints for the parts this check compares. */
function signingDetails(output) {
  const field = (name) => new RegExp(`^${name}=(.*)$`, "m").exec(output)?.[1]?.trim() ?? null;
  return {
    team: field("TeamIdentifier"),
    timestamp: field("Timestamp"),
    runtime: /^CodeDirectory .*flags=0x[0-9a-f]*\([^)]*\bruntime\b/m.test(output),
  };
}

/**
 * The Dock tile plug-in (scripts/build-dock-tile.ts) must be in the app and signed as a
 * bundle by the app's own identity. An intact signature is not enough: clang leaves an ad
 * hoc one that passes `--verify`. Checked here so a packaging mistake fails by name before
 * the upload to Apple.
 */
function verifyDockTilePlugIn(app, { run = captureRun, exists = existsSync } = {}) {
  const plugIn = join(app, "Contents/PlugIns/F5DockTile.docktileplugin");
  if (!exists(join(plugIn, "Contents/MacOS/F5DockTile")))
    throw new Error(`Packaged Dock tile plug-in missing: ${plugIn}`);
  const verified = run("codesign", ["--verify", "--strict", plugIn]);
  if (verified.status !== 0)
    throw new Error(`Dock tile plug-in signing verification failed: ${plugIn}\n${verified.output}`);
  const plugInSigning = run("codesign", ["-dvvv", plugIn]);
  const appSigning = run("codesign", ["-dvvv", app]);
  const plugInDetails = signingDetails(plugInSigning.output);
  const appTeam = signingDetails(appSigning.output).team;
  const plugInTeam = plugInDetails.team === "not set" ? null : plugInDetails.team;
  const problems = [
    plugInSigning.status !== 0 && "its signature could not be read",
    !plugInTeam && "it has no team identifier",
    plugInTeam &&
      plugInTeam !== appTeam &&
      `its team ${plugInTeam} is not the app's ${appTeam ?? "(unreadable)"}`,
    !plugInDetails.timestamp && "it has no secure timestamp",
    !plugInDetails.runtime && "it is not signed with hardened runtime",
  ].filter(Boolean);
  if (problems.length > 0)
    throw new Error(
      `Dock tile plug-in is not signed for release (${problems.join("; ")}): ${plugIn}\n${plugInSigning.output}`,
    );
}
exports.verifyDockTilePlugIn = verifyDockTilePlugIn;

exports.default = async (context) => {
  await verifyComputerHelper(context);
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  verifyClaudeRuntime(context);
  verifyDockTilePlugIn(app);
  await notarizeAndStaple(app, process.env);
};
