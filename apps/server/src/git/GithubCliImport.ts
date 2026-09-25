import * as FS from "node:fs";
import * as Path from "node:path";
import {
  GITHUB_HOST_PATTERN,
  GITHUB_LOGIN_PATTERN,
  type GithubCliAccount,
  type GithubCliCandidates,
  type GithubCliImportResult,
} from "@t3tools/contracts";
import { runProcess } from "../processRunner";
import { isGithubPlaceholderToken } from "./GithubCliProjection";
import { GITHUB_LOGIN_SCOPES } from "./GithubDeviceLogin";
import type { ProfileGithubAccount } from "./ProfileGithubAccount";

const STATUS_TIMEOUT_MS = 20_000;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
export const GITHUB_REQUIRED_SCOPES = GITHUB_LOGIN_SCOPES.split(" ");

/** Variables that would make gh answer with something other than the stored workstation login. */
const OVERRIDING_ENVIRONMENT =
  /^(?:(?:GH|GITHUB)_(?:ENTERPRISE_)?TOKEN|GH_HOST|GH_DEBUG|GH_PATH|ELECTRON_RUN_AS_NODE)$/i;

const isInside = (child: string, parent: string) => {
  const relative = Path.relative(Path.resolve(parent), Path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !Path.isAbsolute(relative));
};

/**
 * Environment for reading the *workstation* gh login from the backend: no token overrides,
 * and no F5 profile `GH_CONFIG_DIR` (a user's own custom config dir is kept).
 */
export function workstationGhEnvironment(
  base: NodeJS.ProcessEnv,
  f5StateRoots: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (OVERRIDING_ENVIRONMENT.test(key)) continue;
    // F5 always projects profiles to `<stateDir>/github`; only such a directory is dropped.
    if (
      key.toUpperCase() === "GH_CONFIG_DIR" &&
      value &&
      Path.basename(Path.resolve(value)) === "github" &&
      f5StateRoots.some((root) => isInside(value, root))
    )
      continue;
    env[key] = value;
  }
  return { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
}

/**
 * Finds the real gh on PATH, skipping F5 launcher directories (this profile's and any other
 * directory holding an F5 `gh.cjs`), which would answer with profile credentials instead.
 * Keep in sync with the inline resolver in the generated launcher (GithubCliLauncher.ts).
 */
export function resolveWorkstationGh(
  env: NodeJS.ProcessEnv,
  launcherDir: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const own = Path.resolve(launcherDir).toLowerCase();
  const name = platform === "win32" ? "gh.exe" : "gh";
  for (const entry of ((pathKey && env[pathKey]) || "").split(Path.delimiter)) {
    if (!entry || Path.resolve(entry).toLowerCase() === own) continue;
    if (FS.existsSync(Path.join(entry, "gh.cjs"))) continue;
    const candidate = Path.join(entry, name);
    try {
      FS.accessSync(candidate, platform === "win32" ? FS.constants.F_OK : FS.constants.X_OK);
      if (FS.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep searching.
    }
  }
  return undefined;
}

const parseScopes = (value: unknown): string[] =>
  typeof value === "string"
    ? value
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean)
    : [];

/** `repo` implies its sub-scopes; `admin:org`/`write:org` imply `read:org`. */
export function missingGithubScopes(scopes: readonly string[]): string[] {
  const granted = new Set(scopes);
  const implied: Record<string, readonly string[]> = {
    "read:org": ["read:org", "write:org", "admin:org"],
  };
  return GITHUB_REQUIRED_SCOPES.filter(
    (scope) => !(implied[scope] ?? [scope]).some((candidate) => granted.has(candidate)),
  );
}

export function parseGhAuthStatus(output: string): GithubCliAccount[] {
  const value = JSON.parse(output) as { hosts?: unknown };
  if (!value || typeof value.hosts !== "object" || value.hosts === null) return [];
  const accounts: GithubCliAccount[] = [];
  for (const [host, entries] of Object.entries(value.hosts)) {
    if (!GITHUB_HOST_PATTERN.test(host) || host.includes("..") || !Array.isArray(entries)) continue;
    for (const entry of entries as Record<string, unknown>[]) {
      if (entry?.state !== "success" || typeof entry.login !== "string") continue;
      if (!GITHUB_LOGIN_PATTERN.test(entry.login)) continue;
      const scopes = parseScopes(entry.scopes);
      accounts.push({
        host,
        login: entry.login,
        active: entry.active === true,
        tokenSource: typeof entry.tokenSource === "string" ? entry.tokenSource : "unknown",
        scopes,
        missingScopes: missingGithubScopes(scopes),
      });
    }
  }
  return accounts;
}

export interface GithubCliImportOptions {
  account: ProfileGithubAccount;
  /** F5 state roots whose `GH_CONFIG_DIR` must not be mistaken for the workstation config. */
  f5StateRoots: readonly string[];
  launcherDir: string;
  env?: NodeJS.ProcessEnv;
  resolveBinary?: (env: NodeJS.ProcessEnv) => string | undefined;
}

/**
 * Explicit, user-triggered import of the workstation GitHub CLI login into this profile.
 * Uses only read-only gh commands (`auth status --json`, `auth token`); tokens never leave the
 * backend except into the profile secret store, and never appear in results or errors.
 */
export class GithubCliImport {
  constructor(private readonly options: GithubCliImportOptions) {}

  private environment(): NodeJS.ProcessEnv {
    return workstationGhEnvironment(this.options.env ?? process.env, this.options.f5StateRoots);
  }

  private binary(env: NodeJS.ProcessEnv): string | undefined {
    return (
      this.options.resolveBinary ??
      ((value) => resolveWorkstationGh(value, this.options.launcherDir))
    )(env);
  }

  async candidates(): Promise<GithubCliCandidates> {
    const env = this.environment();
    const gh = this.binary(env);
    if (!gh) return { ghAvailable: false, accounts: [] };
    const result = await runProcess(gh, ["auth", "status", "--json", "hosts"], {
      env,
      timeoutMs: STATUS_TIMEOUT_MS,
      maxStdoutBytes: MAX_OUTPUT_BYTES,
      maxStderrBytes: MAX_OUTPUT_BYTES,
      allowNonZeroExit: true,
    }).catch(() => null);
    if (!result || result.timedOut || result.code !== 0 || result.stdoutTruncated)
      throw new Error("Unable to read the GitHub CLI login on this computer.");
    try {
      return { ghAvailable: true, accounts: parseGhAuthStatus(result.stdout) };
    } catch {
      throw new Error("GitHub CLI returned an unexpected status. Update gh and try again.");
    }
  }

  async import(input: { host: string; login: string }): Promise<GithubCliImportResult> {
    const host = input.host.toLowerCase();
    if (!GITHUB_HOST_PATTERN.test(host) || host.includes(".."))
      throw new Error("Invalid GitHub hostname.");
    if (!GITHUB_LOGIN_PATTERN.test(input.login)) throw new Error("Invalid GitHub account.");
    const env = this.environment();
    const gh = this.binary(env);
    if (!gh) throw new Error("GitHub CLI isn't installed on this computer.");
    const result = await runProcess(
      gh,
      ["auth", "token", "--hostname", host, "--user", input.login],
      {
        env,
        timeoutMs: TOKEN_TIMEOUT_MS,
        maxStdoutBytes: MAX_OUTPUT_BYTES,
        maxStderrBytes: MAX_OUTPUT_BYTES,
        allowNonZeroExit: true,
      },
    ).catch(() => null);
    const token = result && !result.timedOut && result.code === 0 ? result.stdout.trim() : "";
    // gh never prints the token to stderr, but never surface either stream: errors stay generic.
    if (
      !token ||
      /[\r\n]/.test(token) ||
      token.includes("\u0000") ||
      isGithubPlaceholderToken(token)
    )
      throw new Error(
        `GitHub CLI has no usable login for @${input.login} on ${host}. Run \`gh auth login\` and try again.`,
      );
    // Check the account before saving, so a mismatch never replaces an existing connection.
    const identity = await this.options.account.identify(host, token);
    if (identity.login.toLowerCase() !== input.login.toLowerCase())
      throw new Error("The GitHub CLI token belongs to a different account.");
    const saved = await this.options.account.set(host, token);
    return {
      login: saved.login,
      missingScopes: identity.scopes ? missingGithubScopes(identity.scopes) : [],
    };
  }
}
