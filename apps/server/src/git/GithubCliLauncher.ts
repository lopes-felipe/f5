import { prepareGithubShellStartup } from "./githubShellStartup";
import { findGhBinary } from "./ghBinary";
import { GITHUB_DISCONNECTED_PLACEHOLDER_TOKEN } from "./GithubCliProjection";
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
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:(?:GH|GITHUB)_.*TOKEN|GH_CONFIG_DIR|GH_DEBUG|ELECTRON_RUN_AS_NODE)$/i.test(key)));
env.GH_CONFIG_DIR = ${JSON.stringify(Path.join(stateDir, "github"))};
const findGhBinary = ${findGhBinary.toString()};
const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
const { paths, binary } = findGhBinary((pathKey && env[pathKey]) || "", ${JSON.stringify(directory)}, process.platform, fs, path);
for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
env.PATH = paths.join(path.delimiter);
if (!binary) { process.stderr.write("GitHub CLI (gh) is not installed on PATH.\\n"); process.exit(127); }
if (process.argv[2] === "auth" && ["login", "logout", "switch", "refresh", "setup-git"].includes(process.argv[3])) {
  process.stderr.write("Manage this profile's GitHub connection in F5 Settings > Integrations.\\n"); process.exit(1);
}
if (process.argv[2] === "auth" && process.argv[3] === "git-credential") {
  // Git credential helper protocol: answering nothing lets Git fall through to the next helper,
  // so disconnected hosts never receive the placeholder token.
  const input = fs.readFileSync(0, "utf8");
  if (process.argv[4] === "get") {
    const host = /^host=(.+)$/m.exec(input)?.[1]?.trim();
    if (!host) process.exit(0);
    const saved = spawnSync(binary, ["auth", "token", "--hostname", host], { env, encoding: "utf8" });
    const token = saved.status === 0 ? saved.stdout.trim() : "";
    if (!token || token === ${JSON.stringify(GITHUB_DISCONNECTED_PLACEHOLDER_TOKEN)}) process.exit(0);
  }
  const forwarded = spawnSync(binary, process.argv.slice(2), { env, input, stdio: ["pipe", "inherit", "inherit"] });
  process.exit(forwarded.status ?? 1);
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
