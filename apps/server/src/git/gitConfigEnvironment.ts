import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";

export type GitConfigPair = readonly [key: string, value: string];

/** Appends `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` entries after any the environment already has. */
export function appendGitConfigPairs(
  environment: NodeJS.ProcessEnv,
  pairs: readonly GitConfigPair[],
): NodeJS.ProcessEnv {
  if (pairs.length === 0) return environment;
  const offset = Number(environment.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid GIT_CONFIG_COUNT.");
  pairs.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${offset + index}`] = key;
    environment[`GIT_CONFIG_VALUE_${offset + index}`] = value;
  });
  environment.GIT_CONFIG_COUNT = String(offset + pairs.length);
  return environment;
}

/**
 * Profile-owned Git author for agents and terminals. It is an include file (rather than
 * `GIT_AUTHOR_*` variables captured at spawn) so running sessions follow Settings changes.
 */
export const profileGitAuthorConfigPath = (stateDir: string) =>
  Path.join(stateDir, "git-author.gitconfig");

const quoteGitConfigValue = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function renderProfileGitAuthorConfig(name: string, email: string): string {
  const author = { name: name.trim(), email: email.trim() };
  const combined = author.name + author.email;
  if (!author.name || !author.email || /[\r\n]/.test(combined) || combined.includes("\u0000"))
    return "# No profile Git author configured.\n";
  return `# Managed by F5 Settings > Integrations. Do not edit.\n[user]\n\tname = ${quoteGitConfigValue(author.name)}\n\temail = ${quoteGitConfigValue(author.email)}\n`;
}

export async function writeProfileGitAuthorConfig(
  stateDir: string,
  name: string,
  email: string,
): Promise<void> {
  const target = profileGitAuthorConfigPath(stateDir);
  const content = renderProfileGitAuthorConfig(name, email);
  const existing = await FS.readFile(target, "utf8").catch(() => null);
  if (existing === content) return;
  await FS.mkdir(stateDir, { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await FS.writeFile(temporary, content, { mode: 0o600 });
    await FS.rename(temporary, target);
  } finally {
    await FS.rm(temporary, { force: true });
  }
}

/**
 * Git configuration for agent and terminal processes:
 * - includes the profile author file (missing file is ignored by Git);
 * - isolated profiles reset inherited credential helpers and use the profile `gh` launcher.
 *   It reads the live profile projection, so connecting or disconnecting applies to
 *   already-running sessions, and it answers nothing for disconnected hosts.
 * Default keeps its workstation helpers untouched: appending a helper there would let Git
 * `store` the profile token into workstation helpers such as the OS keychain. A workstation
 * `!gh auth git-credential` helper already resolves to the launcher through PATH.
 */
export function profileSessionGitConfigPairs(input: {
  stateDir: string;
  launcherDir: string;
  isolated: boolean;
  platform?: NodeJS.Platform;
}): GitConfigPair[] {
  const platform = input.platform ?? process.platform;
  const launcher = Path.join(input.launcherDir, platform === "win32" ? "gh.cmd" : "gh");
  const helperPath = platform === "win32" ? launcher.replaceAll("\\", "/") : launcher;
  const helper = `!'${helperPath.replaceAll("'", "'\"'\"'")}' auth git-credential`;
  const author: GitConfigPair = ["include.path", profileGitAuthorConfigPath(input.stateDir)];
  if (!input.isolated) return [author];
  return [author, ["credential.helper", ""], ["credential.helper", helper]];
}
