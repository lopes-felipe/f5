import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";
import { ProfileGithubAccount } from "./ProfileGithubAccount";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv";
import { fallbackDefaultProfile } from "../profiles/ProfileRegistryStore";
import { runProcess } from "../processRunner";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});
async function profile() {
  const stateDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-gh-test-"));
  roots.push(stateDir);
  const secretsDir = Path.join(stateDir, "secrets");
  await FS.mkdir(secretsDir, { mode: 0o700 });
  const secrets: ServerSecretStoreShape = {
    get: (name) =>
      Effect.promise(async () =>
        FS.readFile(Path.join(secretsDir, `${name}.bin`)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        }),
      ),
    set: (name, value) =>
      Effect.promise(() =>
        FS.writeFile(Path.join(secretsDir, `${name}.bin`), value, { mode: 0o600 }),
      ),
    remove: (name) =>
      Effect.promise(() => FS.rm(Path.join(secretsDir, `${name}.bin`), { force: true })),
    getOrCreateRandom: () => Effect.die("unused"),
  };
  const account = new ProfileGithubAccount(
    secrets,
    async (_url, init) =>
      Response.json({ login: new Headers(init?.headers).get("Authorization")!.slice(7) }),
    { stateDir, secretsDir },
  );
  const config = () => FS.readFile(Path.join(stateDir, "github", "hosts.yml"), "utf8").then(parse);
  return { stateDir, secretsDir, secrets, account, config };
}

describe("profile CLI credentials", () => {
  it("rotates and disconnects one profile without changing another, with private files", async () => {
    const personal = await profile();
    const work = await profile();
    await personal.account.set("github.com", "personal");
    await work.account.set("github.com", "work");
    await work.account.set("git.example.com", "enterprise");
    await work.account.set("github.com", "rotated");
    expect((await personal.config())["github.com"].oauth_token).toBe("personal");
    expect((await work.config())["github.com"].oauth_token).toBe("rotated");
    await work.account.remove("github.com");
    expect((await work.config())["github.com"].oauth_token).toBe("f5-profile-not-connected");
    expect((await work.config())["git.example.com"].oauth_token).toBe("enterprise");
    expect(await work.account.token("github.com")).toBeNull();
    // Git credential answers list connected hosts only (never the placeholder).
    const credentialsPath = Path.join(work.stateDir, "github", "git-credentials.json");
    expect(JSON.parse(await FS.readFile(credentialsPath, "utf8"))).toEqual({
      version: 1,
      hosts: { "git.example.com": "enterprise" },
    });
    if (process.platform !== "win32") {
      expect((await FS.stat(credentialsPath)).mode & 0o777).toBe(0o600);
      expect((await FS.stat(Path.join(work.stateDir, "github"))).mode & 0o777).toBe(0o700);
      expect((await FS.stat(Path.join(work.stateDir, "github", "hosts.yml"))).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("keeps unset gh config keys empty instead of writing literal nulls", async () => {
    const p = await profile();
    const directory = Path.join(p.stateDir, "github");
    await FS.mkdir(directory, { recursive: true, mode: 0o700 });
    // As written by gh itself, plus a `null` left behind by an earlier projection.
    await FS.writeFile(
      Path.join(directory, "config.yml"),
      "editor:\nhttp_unix_socket: null\naliases:\n  co: pr checkout\n",
      { mode: 0o600 },
    );
    await p.account.set("github.com", "personal");
    const written = await FS.readFile(Path.join(directory, "config.yml"), "utf8");
    expect(written).not.toMatch(/\bnull\b/);
    expect(parse(written)).toEqual({
      editor: null,
      http_unix_socket: null,
      aliases: { co: "pr checkout" },
      version: "1",
    });
  });

  it("migrates saved tokens offline and reconciles restored or removed credentials", async () => {
    const p = await profile();
    await Effect.runPromise(
      p.secrets.set("github-token-github.com", new TextEncoder().encode("legacy")),
    );
    await p.account.reconcile();
    expect((await p.config())["github.com"].oauth_token).toBe("legacy");
    await Effect.runPromise(p.secrets.remove("github-token-github.com"));
    await p.account.reconcile();
    expect((await p.config())["github.com"].oauth_token).toBe("f5-profile-not-connected");
  });

  it("serializes simultaneous connections for different hosts", async () => {
    const p = await profile();
    await Promise.all([
      p.account.set("github.com", "cloud"),
      p.account.set("git.example.com", "enterprise"),
    ]);
    const config = await p.config();
    expect(config["github.com"].oauth_token).toBe("cloud");
    expect(config["git.example.com"].oauth_token).toBe("enterprise");
  });

  it("does not resurrect a connection whose verification finishes after disconnect", async () => {
    const p = await profile();
    let finish!: (response: Response) => void;
    const account = new ProfileGithubAccount(
      p.secrets,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      p,
    );
    const pending = account.set("github.com", "late");
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await account.remove("github.com");
    finish(Response.json({ login: "late" }));
    await rejected;
    expect(await account.token("github.com")).toBeNull();
  });

  it("fails closed after a secret write failure and repairs on reconciliation", async () => {
    const p = await profile();
    await p.account.set("github.com", "previous");
    const failing = new ProfileGithubAccount(
      { ...p.secrets, set: () => Effect.die("write failed") },
      async () => Response.json({ login: "next" }),
      p,
    );
    await expect(failing.set("github.com", "next")).rejects.toBeDefined();
    expect((await p.config())["github.com"].oauth_token).toBe("f5-profile-not-connected");
    await expect(p.account.token("github.com")).rejects.toThrow("reconciliation");
    await p.account.reconcile();
    expect(await p.account.token("github.com")).toBe("previous");
  });

  it("native gh reads rotations using an unchanged process environment", async ({ skip }) => {
    const version = await runProcess("gh", ["--version"], {
      allowNonZeroExit: true,
      env: process.env,
    }).catch(() => null);
    if (!version || version.code !== 0) {
      skip();
      return;
    }
    const p = await profile();
    const env = buildAccountExecutionEnvironment({
      purpose: "terminal",
      stateDir: p.stateDir,
      profile: fallbackDefaultProfile(p.stateDir),
      baseEnv: { ...process.env, GH_TOKEN: "ambient" },
    });
    const token = async () =>
      (
        await runProcess("gh", ["auth", "token", "--hostname", "github.com"], { env })
      ).stdout.trim();
    await p.account.set("github.com", "first");
    expect(await token()).toBe("first");
    await p.account.set("github.com", "second");
    expect(await token()).toBe("second");
    await p.account.remove("github.com");
    expect(await token()).toBe("f5-profile-not-connected");
  });
});

it("keeps startup available while rejecting GitHub after a reconciliation failure", async () => {
  const p = await profile();
  await Effect.runPromise(
    p.secrets.set("github-token-github.com", new TextEncoder().encode("broken\ntoken")),
  );
  expect(await p.account.initialize()).toBeInstanceOf(Error);
  await expect(p.account.token("github.com")).rejects.toThrow("reconciliation");
  expect(await p.account.token("gitlab.com")).toBeNull();
  await p.account.set("github.com", "repaired");
  expect(await p.account.token("github.com")).toBe("repaired");
});

it("starts native gh with only the disconnected placeholder, then an Enterprise-only connection", async ({
  skip,
}) => {
  const p = await profile();
  const env = buildAccountExecutionEnvironment({
    purpose: "terminal",
    stateDir: p.stateDir,
    profile: fallbackDefaultProfile(p.stateDir),
    baseEnv: process.env,
  });
  const version = await runProcess("gh", ["--version"], {
    env: process.env,
    allowNonZeroExit: true,
  }).catch(() => null);
  if (!version || version.code !== 0) {
    skip();
    return;
  }
  await p.account.reconcile();
  const invoke = (host: string) =>
    runProcess("gh", ["auth", "token", "--hostname", host], { env, timeoutMs: 3000 });
  expect((await invoke("github.com")).stdout.trim()).toBe("f5-profile-not-connected");
  await p.account.set("git.example.com", "enterprise-only");
  expect((await invoke("git.example.com")).stdout.trim()).toBe("enterprise-only");
  expect(
    parse(await FS.readFile(Path.join(p.stateDir, "github", "config.yml"), "utf8")).version,
  ).toBe("1");
});

/**
 * Git sessions for agents/terminals. A fake "real" gh after the launcher on PATH answers every
 * lookup with a workstation token, standing in for gh's OS-keychain fallback for hosts that are
 * not listed in the profile's hosts.yml. It must never be used for profile credentials.
 */
async function gitSession(isolated: boolean) {
  const p = await profile();
  await p.account.reconcile();
  const home = Path.join(p.stateDir, "home");
  const workstationBin = Path.join(p.stateDir, "workstation-bin");
  await FS.mkdir(home);
  await FS.mkdir(workstationBin);
  await FS.writeFile(
    Path.join(workstationBin, "gh"),
    '#!/bin/sh\ncat >/dev/null\nif [ "$2" = token ]; then echo workstation-token; else printf "username=me\\npassword=workstation-token\\n"; fi\n',
    { mode: 0o700 },
  );
  // Workstation helpers: `gh auth setup-git` (bare `gh`), then a keychain-like helper.
  const keychainHelper = Path.join(workstationBin, "keychain-helper");
  await FS.writeFile(
    keychainHelper,
    '#!/bin/sh\ncat >/dev/null\nprintf "username=me\\npassword=workstation-secret\\n"\n',
    { mode: 0o700 },
  );
  const workstationHelpers = `[credential]\n\thelper = !gh auth git-credential\n\thelper = !${keychainHelper}\n`;
  await FS.writeFile(Path.join(home, ".gitconfig"), workstationHelpers);
  // Isolated sessions use the provider home as HOME; inherited helpers there must still be
  // bypassed for GitHub hosts but kept for other hosts.
  const providerHome = Path.join(p.stateDir, "provider-homes", "claude");
  await FS.mkdir(providerHome, { recursive: true });
  await FS.writeFile(Path.join(providerHome, ".gitconfig"), workstationHelpers);
  const profileSummary = fallbackDefaultProfile(p.stateDir);
  const env = buildAccountExecutionEnvironment({
    purpose: "terminal",
    stateDir: p.stateDir,
    profile: isolated ? { ...profileSummary, isDefault: false } : profileSummary,
    baseEnv: {
      ...process.env,
      PATH: `${workstationBin}${Path.delimiter}${process.env.PATH ?? ""}`,
      HOME: home,
      // The unit-test config pins GIT_CONFIG_GLOBAL to /dev/null; use the fake workstation home.
      GIT_CONFIG_GLOBAL: Path.join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const fill = async (host: string) =>
    (
      await runProcess("git", ["credential", "fill"], {
        env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
        stdin: `protocol=https\nhost=${host}\n\n`,
        allowNonZeroExit: true,
        timeoutMs: 10000,
      })
    ).stdout;
  return { p, env, fill };
}

describe.skipIf(process.platform === "win32")("agent and terminal Git sessions", () => {
  it("isolated: GitHub hosts use only live profile credentials; other hosts keep helpers", async () => {
    const { p, fill } = await gitSession(true);
    // Disconnected github.com: nothing from the profile, and neither the placeholder nor
    // workstation credentials (gh keychain fallback or inherited helpers) leak in.
    const disconnected = await fill("github.com");
    expect(disconnected).not.toContain("f5-profile-not-connected");
    expect(disconnected).not.toContain("workstation");
    // Non-GitHub hosts keep inherited helpers (the helper reset is host-scoped).
    expect(await fill("gitlab.com")).toContain("password=workstation-secret");
    // Connecting after the session started applies without a restart.
    await p.account.set("github.com", "live-token");
    expect(await fill("github.com")).toContain("password=live-token");
  });

  it("isolated: an Enterprise host the profile never connected gets no gh/keychain token", async () => {
    const { p, env } = await gitSession(true);
    await p.account.set("ghe.connected.example", "enterprise-token");
    const ask = (host: string) =>
      runProcess(Path.join(p.stateDir, "github-bin", "gh"), ["auth", "git-credential", "get"], {
        env,
        stdin: `protocol=https\nhost=${host}\n\n`,
      }).then((result) => result.stdout);
    expect(await ask("ghe.connected.example")).toBe(
      "username=x-access-token\npassword=enterprise-token\n",
    );
    expect(await ask("ghe.never-connected.example")).toBe("");
    expect(await ask("github.com")).toBe("");
  });

  it("isolated: the profile author applies and follows Settings changes", async () => {
    const { p, env } = await gitSession(true);
    const { writeProfileGitAuthorConfig } = await import("./gitConfigEnvironment");
    const repo = Path.join(p.stateDir, "repo");
    await runProcess("git", ["init", "-q", repo], { env });
    await runProcess("git", ["config", "user.name", "Repo Local"], { cwd: repo, env });
    await runProcess("git", ["config", "user.email", "local@example.com"], { cwd: repo, env });
    const ident = async () =>
      (await runProcess("git", ["var", "GIT_AUTHOR_IDENT"], { cwd: repo, env })).stdout;
    expect(await ident()).toMatch(/^Repo Local <local@example.com>/);
    await writeProfileGitAuthorConfig(p.stateDir, 'Profile "Quoted" Person', "p@example.com");
    expect(await ident()).toMatch(/^Profile "Quoted" Person <p@example.com>/);
    await writeProfileGitAuthorConfig(p.stateDir, "", "");
    expect(await ident()).toMatch(/^Repo Local <local@example.com>/);
  });

  it("Default: keeps repository identity and workstation helpers; bare gh helper is profile-safe", async () => {
    const { p, env, fill } = await gitSession(false);
    // `!gh auth git-credential` resolves to the profile launcher, which answers nothing for a
    // disconnected host, so Git falls through to the next workstation helper.
    const disconnected = await fill("github.com");
    expect(disconnected).not.toContain("f5-profile-not-connected");
    expect(disconnected).not.toContain("workstation-token");
    expect(disconnected).toContain("password=workstation-secret");
    await p.account.set("github.com", "live-token");
    expect(await fill("github.com")).toContain("password=live-token");

    const { writeProfileGitAuthorConfig } = await import("./gitConfigEnvironment");
    await writeProfileGitAuthorConfig(p.stateDir, "Profile Person", "p@example.com");
    const repo = Path.join(p.stateDir, "repo");
    await runProcess("git", ["init", "-q", repo], { env });
    await runProcess("git", ["config", "user.name", "Repo Local"], { cwd: repo, env });
    await runProcess("git", ["config", "user.email", "local@example.com"], { cwd: repo, env });
    expect(
      (await runProcess("git", ["var", "GIT_AUTHOR_IDENT"], { cwd: repo, env })).stdout,
    ).toMatch(/^Repo Local <local@example.com>/);
  });
});

it.for(["bash", "zsh"])(
  "keeps shell startup customizations but rejects rc credentials through %s",
  async (shell, { skip }) => {
    const p = await profile();
    const shellPath = `/bin/${shell}`;
    if (process.platform === "win32" || !(await FS.stat(shellPath).catch(() => null))) {
      skip();
      return;
    }
    const { githubTerminalStartup } = await import("./githubShellStartup");
    const fakeBin = Path.join(p.stateDir, "fake-bin");
    await FS.mkdir(fakeBin);
    await FS.writeFile(
      Path.join(fakeBin, "gh"),
      '#!/bin/sh\nprintf "%s|%s|%s|%s|%s" "$GH_TOKEN" "$GH_CONFIG_DIR" "$MY_CUSTOMIZATION" "$ELECTRON_RUN_AS_NODE" "$electron_run_as_node"\n',
      { mode: 0o700 },
    );
    const home = Path.join(p.stateDir, "home");
    await FS.mkdir(home);
    await FS.writeFile(
      Path.join(home, shell === "bash" ? ".bashrc" : ".zshrc"),
      `export GH_TOKEN=workstation\nexport GH_CONFIG_DIR=/workstation\nexport PATH='${fakeBin}':"$PATH"\nexport MY_CUSTOMIZATION=preserved\n`,
    );
    await p.account.reconcile();
    const env = buildAccountExecutionEnvironment({
      purpose: "terminal",
      stateDir: p.stateDir,
      profile: fallbackDefaultProfile(p.stateDir),
      baseEnv: { ...process.env, HOME: home, ZDOTDIR: home, electron_run_as_node: "1" },
    });
    const launch = githubTerminalStartup(shellPath, ["-i", "-c", "gh api user"], env, p.stateDir);
    const result = await runProcess(shellPath, launch.args, { env: launch.env });
    expect(result.stdout).toBe(`|${Path.join(p.stateDir, "github")}|preserved||`);
    await FS.writeFile(Path.join(p.stateDir, "github-unavailable"), "unavailable");
    const failed = await runProcess(shellPath, launch.args, {
      env: launch.env,
      allowNonZeroExit: true,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("GitHub credentials are unavailable");
  },
);

it("follows ZDOTDIR changes across real zsh login startup files", async ({ skip }) => {
  if (process.platform === "win32" || !(await FS.stat("/bin/zsh").catch(() => null))) {
    skip();
    return;
  }
  const p = await profile();
  const { githubTerminalStartup } = await import("./githubShellStartup");
  const home = Path.join(p.stateDir, "home");
  const config = Path.join(home, ".config", "zsh");
  const interactive = Path.join(config, "interactive");
  await FS.mkdir(interactive, { recursive: true });
  await FS.writeFile(Path.join(home, ".zshenv"), 'export ZDOTDIR="$HOME/.config/zsh"\n');
  await FS.writeFile(
    Path.join(config, ".zprofile"),
    'export CUSTOM_PROFILE=loaded\nexport ZDOTDIR="$ZDOTDIR/interactive"\n',
  );
  await FS.writeFile(
    Path.join(interactive, ".zshrc"),
    "export CUSTOM_RC=loaded\nexport GH_TOKEN=workstation\n",
  );
  await FS.writeFile(
    Path.join(interactive, ".zlogin"),
    "export CUSTOM_LOGIN=loaded\nexport GH_CONFIG_DIR=/workstation\n",
  );
  await p.account.reconcile();
  const env = buildAccountExecutionEnvironment({
    purpose: "terminal",
    stateDir: p.stateDir,
    profile: fallbackDefaultProfile(p.stateDir),
    baseEnv: { ...process.env, HOME: home, ZDOTDIR: home },
  });
  const startup = githubTerminalStartup(
    "/bin/zsh",
    [
      "-l",
      "-i",
      "-c",
      'printf "%s|%s|%s|%s|%s" "$CUSTOM_PROFILE" "$CUSTOM_RC" "$CUSTOM_LOGIN" "$GH_TOKEN" "$GH_CONFIG_DIR"',
    ],
    env,
    p.stateDir,
  );
  const result = await runProcess("/bin/zsh", startup.args, { env: startup.env });
  expect(result.stdout).toBe(`loaded|loaded|loaded||${Path.join(p.stateDir, "github")}`);
});
