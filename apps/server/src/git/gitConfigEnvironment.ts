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

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

/**
 * Git configuration for agent and terminal processes of **isolated** profiles:
 * - includes the profile author file (missing file is ignored by Git), so the profile identity
 *   applies and follows Settings changes in running sessions;
 * - for each GitHub host known to the profile, resets inherited credential helpers and uses the
 *   profile launcher, which answers only from the profile's connected hosts. Other hosts
 *   (GitLab, Bitbucket, …) keep their inherited helpers.
 *
 * Default gets nothing: it keeps each repository's identity and its workstation helpers
 * (appending a helper there would let Git `store` the profile token into e.g. the keychain).
 *
 * Git runs helpers through `sh` on every platform (Git for Windows ships one), so the helper
 * invokes node directly instead of the `gh.cmd` wrapper.
 */
export function profileSessionGitConfigPairs(input: {
  stateDir: string;
  launcherDir: string;
  isolated: boolean;
  githubHosts: readonly string[];
  execPath?: string;
  platform?: NodeJS.Platform;
}): GitConfigPair[] {
  if (!input.isolated) return [];
  const platform = input.platform ?? process.platform;
  const toShellPath = (value: string) =>
    platform === "win32" ? value.replaceAll("\\", "/") : value;
  const script = toShellPath(Path.join(input.launcherDir, "gh.cjs"));
  const node = toShellPath(input.execPath ?? process.execPath);
  const helper = `!ELECTRON_RUN_AS_NODE=1 ${shellQuote(node)} ${shellQuote(script)} auth git-credential`;
  return [
    ["include.path", profileGitAuthorConfigPath(input.stateDir)],
    ...input.githubHosts.flatMap((host): GitConfigPair[] => [
      [`credential.https://${host}.helper`, ""],
      [`credential.https://${host}.helper`, helper],
    ]),
  ];
}
