import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { GithubCliLogin, githubCliLoginEnvironment, githubLoginRoot } from "./GithubCliLogin";
import { ProfileGithubAccount } from "./ProfileGithubAccount";

// Output recorded from gh 2.101.0 with non-interactive stdin, plus the interactive variant.
const FAKE_GH = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const log = process.env.FAKE_GH_LOG;
const config = process.env.GH_CONFIG_DIR;
if (args[0] === "auth" && args[1] === "token") {
  try { process.stdout.write(fs.readFileSync(path.join(config, "token"), "utf8") + "\n"); process.exit(0); }
  catch { process.stderr.write("no oauth token found\n"); process.exit(1); }
}
if (args[0] !== "auth" || args[1] !== "login") process.exit(2);
fs.writeFileSync(log, JSON.stringify({
  args, pid: process.pid, config,
  inherited: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST"].filter((key) => process.env[key] !== undefined),
  gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL,
}));
const host = args[args.indexOf("--hostname") + 1];
const finish = () => {
  const timer = setInterval(() => {
    let signal;
    try { signal = fs.readFileSync(process.env.FAKE_GH_GO, "utf8"); } catch { return; }
    clearInterval(timer);
    if (signal === "fail") process.exit(1);
    fs.writeFileSync(path.join(config, "token"), signal);
    process.exit(0);
  }, 10);
};
if (process.env.FAKE_GH_MODE === "interactive") {
  process.stderr.write("\n! First copy your one-time code: AB12-CD34\nPress Enter to open https://" + host + "/login/device in your browser... ");
  process.stdin.once("data", () => { fs.writeFileSync(log + ".enter", "1"); finish(); });
} else if (process.env.FAKE_GH_MODE === "silent") {
  setInterval(() => {}, 1000);
} else {
  process.stderr.write("\n! One-time code (F8C3-8E85) copied to clipboard\nOpen this URL to continue in your web browser: https://" + host + "/login/device\n");
  finish();
}
`;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});

async function setup(mode?: "interactive" | "silent") {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-gh-login-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  await FS.mkdir(stateDir);
  const script = Path.join(root, "fake-gh.cjs");
  await FS.writeFile(script, FAKE_GH);
  const binary = Path.join(root, "gh");
  await FS.writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, {
    mode: 0o755,
  });
  const values = new Map<string, Uint8Array>();
  const verified: string[] = [];
  const account = new ProfileGithubAccount(
    {
      get: (key) => Effect.succeed(values.get(key) ?? null),
      set: (key, value) => Effect.sync(() => void values.set(key, value)),
      remove: (key) => Effect.sync(() => void values.delete(key)),
      getOrCreateRandom: () => Effect.die("unused"),
    },
    async (url, init) => {
      verified.push(String(url));
      const token = new Headers(init?.headers).get("Authorization")!.slice(7);
      return Response.json({ login: token === "gho_private" ? "octocat" : "enterprise-user" });
    },
  );
  const log = Path.join(root, "gh-log.json");
  const go = Path.join(root, "go");
  const login = new GithubCliLogin({
    account,
    stateDir,
    resolveBinary: () => binary,
    promptTimeoutMs: 2000,
    env: {
      ...process.env,
      GH_TOKEN: "workstation-token",
      GITHUB_TOKEN: "workstation-token",
      GH_HOST: "elsewhere.example.com",
      FAKE_GH_LOG: log,
      FAKE_GH_GO: go,
      ...(mode ? { FAKE_GH_MODE: mode } : {}),
    },
  });
  const recorded = async () =>
    JSON.parse(await FS.readFile(log, "utf8")) as {
      args: string[];
      pid: number;
      config: string;
      inherited: string[];
      gitConfigGlobal: string;
    };
  return { root, stateDir, account, login, recorded, go, log, verified };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const exists = (path: string) =>
  FS.stat(path).then(
    () => true,
    () => false,
  );
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === "win32")("GitHub CLI browser sign-in", () => {
  it("shows gh's device code, saves the token, and removes the throwaway config", async () => {
    const { login, account, recorded, go } = await setup();
    const status = await login.start();
    expect(status).toMatchObject({
      available: true,
      state: "pending",
      userCode: "F8C3-8E85",
      verificationUri: "https://github.com/login/device",
    });
    const call = await recorded();
    expect(call.args).toEqual([
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--web",
      "--git-protocol",
      "https",
      "--skip-ssh-key",
      "--insecure-storage",
      "--scopes",
      "notifications",
    ]);
    expect(call.inherited).toEqual([]);
    expect(call.gitConfigGlobal.startsWith(call.config)).toBe(true);
    expect(await exists(call.config)).toBe(true);

    await FS.writeFile(go, "gho_private");
    await waitFor(() => login.status(status.handle).state === "connected");
    expect(login.status(status.handle).login).toBe("octocat");
    expect(await account.token("github.com")).toBe("gho_private");
    expect(JSON.stringify(login.status())).not.toContain("gho_private");
    await waitFor(async () => !(await exists(call.config)));
  });

  it("uses the profile login root and sends Enter when gh waits for it", async () => {
    const { login, recorded, go, log, stateDir } = await setup("interactive");
    const status = await login.start({ host: "ghe.example.com" });
    expect(status.userCode).toBe("AB12-CD34");
    expect(status.verificationUri).toBe("https://ghe.example.com/login/device");
    const call = await recorded();
    expect(Path.dirname(call.config)).toBe(githubLoginRoot(stateDir));
    await waitFor(() => exists(`${log}.enter`));
    await FS.writeFile(go, "enterprise-token");
    await waitFor(() => login.status().state === "connected");
  });

  it("cancel kills gh, cleans up, and ignores a later completion", async () => {
    const { login, account, recorded, go } = await setup();
    const status = await login.start();
    const call = await recorded();
    login.cancel(status.handle);
    expect(login.status(status.handle).state).toBe("cancelled");
    await waitFor(() => !alive(call.pid));
    await waitFor(async () => !(await exists(call.config)));
    await FS.writeFile(go, "late-token");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await account.token("github.com")).toBeNull();
    expect(login.status(status.handle).state).toBe("cancelled");
  });

  it("reports a failed gh run without saving or echoing output", async () => {
    const { login, account, go } = await setup();
    const status = await login.start();
    await FS.writeFile(go, "fail");
    await waitFor(() => login.status(status.handle).state === "error");
    expect(login.status(status.handle).error).toBe("GitHub sign-in did not complete. Start again.");
    expect(await account.token("github.com")).toBeNull();
  });

  it("fails fast when gh never prints a code", async () => {
    const { login, recorded } = await setup("silent");
    const status = await login.start();
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/did not provide a sign-in code/);
    const call = await recorded();
    await waitFor(() => !alive(call.pid));
  });

  it("expires stale handles and reports a missing gh", async () => {
    const { login, account, stateDir } = await setup();
    expect(login.status("missing").state).toBe("expired");
    const missing = new GithubCliLogin({ account, stateDir, resolveBinary: () => undefined });
    expect(missing.status()).toMatchObject({ available: false, state: "idle" });
    expect(missing.status().error).toMatch(/Install GitHub CLI/);
    await expect(missing.start()).rejects.toThrow(/Install GitHub CLI/);
  });

  it("times out a sign-in that is never authorized", async () => {
    const { account, stateDir, root } = await setup();
    const login = new GithubCliLogin({
      account,
      stateDir,
      resolveBinary: () => Path.join(root, "gh"),
      loginTimeoutMs: 1500,
      env: { ...process.env, FAKE_GH_LOG: Path.join(root, "t.json"), FAKE_GH_GO: "/nonexistent" },
    });
    const status = await login.start();
    expect(status.state).toBe("pending");
    await waitFor(() => login.status(status.handle).state === "expired");
  });

  it("removes leftovers from a previous backend", async () => {
    const { login, stateDir } = await setup();
    await FS.mkdir(Path.join(githubLoginRoot(stateDir), "stale"), { recursive: true });
    await login.cleanupStale();
    expect(await exists(githubLoginRoot(stateDir))).toBe(false);
  });
});

describe("githubCliLoginEnvironment", () => {
  it("strips inherited GitHub credentials and routing and pins config to the throwaway folder", () => {
    const env = githubCliLoginEnvironment(
      {
        PATH: "/usr/bin",
        GH_TOKEN: "a",
        github_token: "b",
        GH_ENTERPRISE_TOKEN: "c",
        GH_CONFIG_DIR: "/home/me/.config/gh",
        GH_HOST: "x",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        HOME: "/home/me",
      },
      "/state/github-login/abc",
    );
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/me",
      GH_CONFIG_DIR: "/state/github-login/abc",
      GIT_CONFIG_GLOBAL: Path.join("/state/github-login/abc", "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    });
    for (const key of ["GH_TOKEN", "github_token", "GH_ENTERPRISE_TOKEN", "GH_HOST"])
      expect(env[key]).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });
});
