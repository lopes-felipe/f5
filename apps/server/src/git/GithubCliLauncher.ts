import { prepareGithubShellStartup } from "./githubShellStartup";
import {
  GITHUB_DISCONNECTED_PLACEHOLDER_TOKEN,
  githubConfigDir,
  githubGitCredentialsPath,
} from "./GithubCliProjection";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

export const githubUnavailablePath = (stateDir: string) =>
  Path.join(stateDir, "github-unavailable");
export const githubLauncherDir = (stateDir: string) => Path.join(stateDir, "github-bin");

/** No credentials in this launcher. It selects the profile again after shell startup. */
const prepared = new Map<string, Promise<void>>();
export function prepareGithubLauncher(stateDir: string): Promise<void> {
  const existing = prepared.get(stateDir);
  if (existing) return existing;
  const pending = writeGithubLauncher(stateDir).catch((cause) => {
    prepared.delete(stateDir);
    throw cause;
  });
  prepared.set(stateDir, pending);
  return pending;
}
async function writeGithubLauncher(stateDir: string): Promise<void> {
  await prepareGithubShellStartup(stateDir);
  const directory = githubLauncherDir(stateDir);
  await FS.mkdir(directory, { recursive: true, mode: 0o700 });
  const script = Path.join(directory, "gh.cjs");
  const source = `const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
if (fs.existsSync(${JSON.stringify(githubUnavailablePath(stateDir))})) {
  process.stderr.write("GitHub credentials are unavailable. Reconnect in F5 Settings > Integrations.\\n");
  process.exit(1);
}
if (process.argv[2] === "auth" && process.argv[3] === "git-credential") {
  // Git credential helper protocol, answered only from the profile's own connected hosts.
  // Never delegate to gh: for hosts missing from hosts.yml gh falls back to the OS keychain,
  // which would hand workstation credentials to this profile. Answering nothing lets Git
  // fall through to the next helper; store/erase are no-ops (the profile store is managed in F5).
  const input = fs.readFileSync(0, "utf8");
  if (process.argv[4] !== "get") process.exit(0);
  const field = (name) => new RegExp("^" + name + "=(.*)$", "m").exec(input)?.[1]?.trim();
  const host = field("host");
  if (field("protocol") !== "https" || !host) process.exit(0);
  let hosts = {};
  try {
    const stored = JSON.parse(fs.readFileSync(${JSON.stringify(githubGitCredentialsPath(stateDir))}, "utf8"));
    if (stored && stored.version === 1 && stored.hosts && typeof stored.hosts === "object") hosts = stored.hosts;
  } catch {}
  const token = Object.prototype.hasOwnProperty.call(hosts, host.toLowerCase()) ? hosts[host.toLowerCase()] : undefined;
  if (typeof token !== "string" || !token || /[\\r\\n]/.test(token) || token === ${JSON.stringify(GITHUB_DISCONNECTED_PLACEHOLDER_TOKEN)}) process.exit(0);
  process.stdout.write("username=x-access-token\\npassword=" + token + "\\n");
  process.exit(0);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:(?:GH|GITHUB)_.*TOKEN|GH_CONFIG_DIR|GH_DEBUG|ELECTRON_RUN_AS_NODE)$/i.test(key)));
env.GH_CONFIG_DIR = ${JSON.stringify(githubConfigDir(stateDir))};
const own = ${JSON.stringify(directory)}.toLowerCase();
// Skip this launcher and any other F5 launcher directory (another profile, or F5 started from an
// F5 terminal): either would redirect gh to a different profile's credentials.
const isLauncherDirectory = (entry) => {
  if (path.resolve(entry).toLowerCase() === own) return true;
  try { fs.accessSync(path.join(entry, "gh.cjs"), fs.constants.F_OK); return true; } catch { return false; }
};
const paths = (env.PATH || env.Path || "").split(path.delimiter).filter((entry) => entry && !isLauncherDirectory(entry));
for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
env.PATH = paths.join(path.delimiter);
const binary = paths.map((entry) => path.join(entry, process.platform === "win32" ? "gh.exe" : "gh")).find((candidate) => { try { fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } });
if (!binary) { process.stderr.write("GitHub CLI (gh) is not installed on PATH.\\n"); process.exit(127); }
if (process.argv[2] === "auth" && ["login", "logout", "switch", "refresh", "setup-git"].includes(process.argv[3])) {
  process.stderr.write("Manage this profile's GitHub connection in F5 Settings > Integrations.\\n"); process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { env, stdio: "inherit" });
if (result.error) process.stderr.write("Could not start GitHub CLI.\\n");
process.exit(result.status ?? 1);
`;
  await FS.writeFile(script, source, { mode: 0o600 });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  await FS.writeFile(
    Path.join(directory, "gh"),
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    { mode: 0o700 },
  );
  await FS.writeFile(
    Path.join(directory, "gh.cmd"),
    `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "${script}" %*\r\n`,
    { mode: 0o700 },
  );
}
