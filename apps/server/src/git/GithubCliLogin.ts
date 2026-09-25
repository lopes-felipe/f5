import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import type { GithubLoginStatus } from "@t3tools/contracts";
import { parseGhDeviceLogin } from "@t3tools/shared/github";
import { resolveGhBinary } from "./ghBinary";
import { githubLauncherDir } from "./GithubCliLauncher";
import { isGithubPlaceholderToken } from "./GithubCliProjection";
import type { ProfileGithubAccount } from "./ProfileGithubAccount";

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 1000;
const INSTALL_GH_MESSAGE =
  "Install GitHub CLI (gh) to sign in with your browser, or use a personal access token.";
/** Inherited variables that would redirect gh away from the throwaway config directory. */
const INHERITED_GH_ENVIRONMENT =
  /^(?:(?:GH|GITHUB)_.*TOKEN|GH_CONFIG_DIR|GH_HOST|GH_DEBUG|GH_PATH|GH_BROWSER|BROWSER|ELECTRON_RUN_AS_NODE|GIT_CONFIG_.*)$/i;

export type GithubCliLoginSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface GithubCliLoginOptions {
  account: ProfileGithubAccount;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  spawn?: GithubCliLoginSpawn;
  resolveBinary?: () => string | undefined;
  loginTimeoutMs?: number;
  promptTimeoutMs?: number;
}

interface Attempt {
  status: GithubLoginStatus;
  host: string;
  directory: string;
  child?: ChildProcessWithoutNullStreams;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export const githubLoginRoot = (stateDir: string) => Path.join(stateDir, "github-login");

/** Isolated gh environment: profile config dir, no inherited tokens, no browser or git writes. */
export function githubCliLoginEnvironment(
  base: NodeJS.ProcessEnv,
  directory: string,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(base).filter(([key]) => !INHERITED_GH_ENVIRONMENT.test(key)),
  );
  return {
    ...env,
    GH_CONFIG_DIR: directory,
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1",
    NO_COLOR: "1",
    // F5 opens the verification link itself; never launch a browser from the backend.
    ...(process.platform === "win32" ? {} : { GH_BROWSER: "true" }),
    // gh must not configure Git credentials globally during login.
    GIT_CONFIG_GLOBAL: Path.join(directory, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/**
 * Browser sign-in through the installed GitHub CLI (`gh auth login --web`) using a private,
 * throwaway config directory and file storage, so neither the workstation gh login nor the OS
 * keychain is read or written. The resulting token is saved through ProfileGithubAccount.
 */
export class GithubCliLogin {
  private attempt?: Attempt;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnGh: GithubCliLoginSpawn;
  private readonly resolveBinary: () => string | undefined;

  constructor(private readonly options: GithubCliLoginOptions) {
    this.env = options.env ?? process.env;
    this.spawnGh =
      options.spawn ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], { env: spawnOptions.env, stdio: "pipe", windowsHide: true }));
    this.resolveBinary =
      options.resolveBinary ??
      (() => resolveGhBinary(this.env, githubLauncherDir(options.stateDir)));
  }

  /** Removes directories left by a previous backend that exited mid sign-in. */
  async cleanupStale(): Promise<void> {
    await FS.rm(githubLoginRoot(this.options.stateDir), { recursive: true, force: true });
  }

  private available(): boolean {
    return Boolean(this.resolveBinary());
  }

  private idle(): GithubLoginStatus {
    const available = this.available();
    return { available, state: "idle", ...(available ? {} : { error: INSTALL_GH_MESSAGE }) };
  }

  status(handle?: string): GithubLoginStatus {
    if (handle && this.attempt?.status.handle !== handle)
      return {
        available: this.available(),
        state: "expired",
        error: "Sign-in is no longer active. Start again.",
      };
    return this.attempt?.status ?? this.idle();
  }

  cancel(handle?: string): void {
    const attempt = this.attempt;
    if (!attempt || (handle && attempt.status.handle !== handle)) return;
    if (attempt.status.state !== "pending") return;
    this.finish(attempt, { state: "cancelled" });
  }

  /** Cancels an in-flight sign-in for `host` (a token save or disconnect supersedes it). */
  cancelForHost(host: string): void {
    if (this.attempt?.host === host) this.cancel();
  }

  dispose(): void {
    this.cancel();
  }

  private current(attempt: Attempt): boolean {
    return this.attempt === attempt && !attempt.settled;
  }

  private finish(
    attempt: Attempt,
    status: Pick<GithubLoginStatus, "state"> & Partial<GithubLoginStatus>,
  ): void {
    if (attempt.settled) return;
    attempt.settled = true;
    clearTimeout(attempt.timer);
    if (attempt.child && attempt.child.exitCode === null && attempt.child.signalCode === null)
      attempt.child.kill();
    attempt.status = { available: true, handle: attempt.status.handle, ...status };
    void FS.rm(attempt.directory, { recursive: true, force: true }).catch(() => {});
  }

  async start(input: { host?: string } = {}): Promise<GithubLoginStatus> {
    const host = input.host ?? "github.com";
    const binary = this.resolveBinary();
    if (!binary) throw new Error(INSTALL_GH_MESSAGE);
    this.cancel();
    const directory = Path.join(githubLoginRoot(this.options.stateDir), randomUUID());
    const attempt: Attempt = {
      status: { available: true, state: "pending", handle: randomUUID() },
      host,
      directory,
      settled: false,
    };
    this.attempt = attempt;
    try {
      await FS.mkdir(githubLoginRoot(this.options.stateDir), { recursive: true, mode: 0o700 });
      await FS.mkdir(directory, { mode: 0o700 });
    } catch {
      this.finish(attempt, { state: "error", error: "Unable to start GitHub sign-in. Try again." });
      return this.status(attempt.status.handle);
    }
    if (!this.current(attempt)) return this.status(attempt.status.handle);

    const env = githubCliLoginEnvironment(this.env, directory);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnGh(
        binary,
        [
          "auth",
          "login",
          "--hostname",
          host,
          "--web",
          "--git-protocol",
          "https",
          "--skip-ssh-key",
          "--insecure-storage",
          "--scopes",
          "notifications",
        ],
        { env },
      );
    } catch {
      this.finish(attempt, { state: "error", error: "Unable to start GitHub CLI." });
      return this.status(attempt.status.handle);
    }
    attempt.child = child;

    const prompt = new Promise<void>((resolve) => {
      let output = "";
      let enterSent = false;
      const onData = (chunk: Buffer) => {
        if (output.length >= MAX_OUTPUT_BYTES) return;
        output = (output + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
        const parsed = parseGhDeviceLogin(output, host);
        if (!parsed || !this.current(attempt)) return;
        if (parsed.awaitsEnter && !enterSent) {
          enterSent = true;
          child.stdin.write("\n");
        }
        if (!attempt.status.userCode) {
          attempt.status = {
            ...attempt.status,
            userCode: parsed.userCode,
            verificationUri: parsed.verificationUri,
            expiresAt: Date.now() + (this.options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS),
          };
          resolve();
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
      setTimeout(resolve, this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS).unref?.();
    });

    child.once("error", () => {
      if (this.current(attempt))
        this.finish(attempt, { state: "error", error: "Unable to start GitHub CLI." });
    });
    child.once("exit", (code) => {
      void this.complete(attempt, binary, env, code);
    });
    attempt.timer = setTimeout(() => {
      if (this.current(attempt))
        this.finish(attempt, { state: "expired", error: "Sign-in expired. Start again." });
    }, this.options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    attempt.timer.unref?.();

    await prompt;
    if (this.current(attempt) && !attempt.status.userCode)
      this.finish(attempt, {
        state: "error",
        error: "GitHub CLI did not provide a sign-in code. Update gh or use a token.",
      });
    return this.status(attempt.status.handle);
  }

  private async complete(
    attempt: Attempt,
    binary: string,
    env: NodeJS.ProcessEnv,
    code: number | null,
  ): Promise<void> {
    if (!this.current(attempt)) return;
    if (code !== 0) {
      this.finish(attempt, {
        state: "error",
        error: "GitHub sign-in did not complete. Start again.",
      });
      return;
    }
    const token = await this.readToken(binary, env, attempt.host).catch(() => "");
    if (!this.current(attempt)) return;
    if (!token || isGithubPlaceholderToken(token)) {
      this.finish(attempt, {
        state: "error",
        error: "GitHub CLI did not return a token. Start again.",
      });
      return;
    }
    try {
      const identity = await this.options.account.set(attempt.host, token, () =>
        this.current(attempt),
      );
      if (this.current(attempt))
        this.finish(attempt, { state: "connected", login: identity.login });
    } catch {
      if (this.current(attempt))
        this.finish(attempt, {
          state: "error",
          error: "Unable to save the GitHub connection. Try again.",
        });
    }
  }

  private readToken(binary: string, env: NodeJS.ProcessEnv, host: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawnGh(binary, ["auth", "token", "--hostname", host], { env });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      });
      child.stderr.resume();
      child.stdin.end();
      child.once("error", reject);
      child.once("exit", (exitCode) =>
        exitCode === 0 ? resolve(stdout.trim()) : reject(new Error("gh auth token failed")),
      );
    });
  }
}
