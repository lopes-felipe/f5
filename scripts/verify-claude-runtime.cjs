const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

function defaultRun(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  return { status: result.error ? null : result.status };
}

/** Exercise the packaged resolver and the platform's production SDK spawn path. */
function verifyClaudeRuntime(context, { run = defaultRun } = {}) {
  const { appOutDir, electronPlatformName: platform, packager } = context;
  if (!["darwin", "win32", "linux"].includes(platform))
    throw new Error("Unsupported platform for Claude runtime verification.");
  const mac = platform === "darwin";
  const name = packager.appInfo.productFilename;
  const app = mac ? join(appOutDir, `${name}.app`) : appOutDir;
  const resources = mac ? join(app, "Contents", "Resources") : join(app, "resources");
  const executable = mac
    ? join(app, "Contents", "MacOS", name)
    : join(app, platform === "win32" ? `${name}.exe` : packager.executableName);
  const entry = join(resources, "app.asar", "apps", "server", "dist", "claude-runtime-smoke.mjs");
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const result = run(executable, [entry], { env, timeout: 45_000, killSignal: "SIGKILL" });
  if (result.status !== 0) throw new Error(`Bundled Claude runtime smoke failed for ${app}`);
}

exports.verifyClaudeRuntime = verifyClaudeRuntime;
exports.default = async (context) => verifyClaudeRuntime(context);
