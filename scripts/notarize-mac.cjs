const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
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

exports.default = async (context) => {
  await verifyComputerHelper(context);
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  verifyClaudeRuntime(context);
  await notarizeAndStaple(app, process.env);
};
