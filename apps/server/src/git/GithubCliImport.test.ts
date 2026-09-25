import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  GithubCliImport,
  missingGithubScopes,
  parseGhAuthStatus,
  resolveWorkstationGh,
  workstationGhEnvironment,
} from "./GithubCliImport";
import { ProfileGithubAccount } from "./ProfileGithubAccount";

// Shape recorded from gh 2.101.0 (`gh auth status --json hosts`); never includes tokens.
const STATUS = {
  hosts: {
    "github.com": [
      {
        state: "success",
        active: true,
        host: "github.com",
        login: "octocat",
        tokenSource: "keyring",
        scopes: "gist, read:org, read:project, repo, workflow",
        gitProtocol: "https",
      },
      {
        state: "success",
        active: false,
        host: "github.com",
        login: "work-bot",
        tokenSource: "keyring",
        scopes: "repo, admin:org, notifications",
        gitProtocol: "https",
      },
      { state: "error", active: false, host: "github.com", login: "expired", scopes: "" },
    ],
    "ghe.example.com": [
      {
        state: "success",
        active: true,
        host: "ghe.example.com",
        login: "alice_corp",
        tokenSource: "oauth_token",
        scopes: "repo, read:org, notifications",
      },
    ],
    "Bad Host": [{ state: "success", active: true, login: "x", scopes: "repo" }],
  },
};

// Fake gh: records argv/env, answers `auth status --json hosts` and `auth token --user`.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({
  args,
  GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? null,
  tokens: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST"].filter((key) => process.env[key] !== undefined),
  prompt: process.env.GH_PROMPT_DISABLED ?? null,
}) + "\n");
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(process.env.FAKE_GH_STATUS);
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token") {
  const host = args[args.indexOf("--hostname") + 1];
  const user = args[args.indexOf("--user") + 1];
  const token = JSON.parse(process.env.FAKE_GH_TOKENS)[host + "/" + user];
  if (!token) { process.stderr.write("no oauth token found for " + host + " account " + user + "\n"); process.exit(1); }
  process.stdout.write(token + "\n");
  process.exit(0);
}
process.exit(2);
`;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});

async function setup(tokens: Record<string, string> = {}) {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-gh-import-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const bin = Path.join(root, "bin");
  const launcherDir = Path.join(stateDir, "github-bin");
  const otherLauncher = Path.join(root, "other-profile", "github-bin");
  for (const directory of [stateDir, bin, launcherDir, otherLauncher])
    await FS.mkdir(directory, { recursive: true });
  const fake = Path.join(bin, "gh");
  await FS.writeFile(fake, FAKE_GH.replace("/usr/bin/env node", process.execPath), {
    mode: 0o755,
  });
  // F5 launchers ahead of the real gh on PATH must be skipped.
  for (const directory of [launcherDir, otherLauncher]) {
    await FS.writeFile(Path.join(directory, "gh"), "#!/bin/sh\necho launcher\n", { mode: 0o755 });
    await FS.writeFile(Path.join(directory, "gh.cjs"), "");
  }
  const log = Path.join(root, "gh.log");
  const secrets = new Map<string, Uint8Array>();
  const identities: Record<string, { login: string; scopes?: string }> = {
    gho_octo: { login: "octocat", scopes: "gist, read:org, repo, workflow" },
    gho_bot: { login: "work-bot", scopes: "repo, admin:org, notifications" },
    gho_alice: { login: "alice_corp", scopes: "repo, read:org, notifications" },
    gho_someone_else: { login: "someone-else", scopes: "repo" },
  };
  const account = new ProfileGithubAccount(
    {
      get: (key) => Effect.succeed(secrets.get(key) ?? null),
      set: (key, value) => Effect.sync(() => void secrets.set(key, value)),
      remove: (key) => Effect.sync(() => void secrets.delete(key)),
      getOrCreateRandom: () => Effect.die("unused"),
    },
    async (_url, init) => {
      const token = new Headers(init?.headers).get("Authorization")!.slice(7);
      const identity = identities[token];
      if (!identity) return new Response("unauthorized", { status: 401 });
      return Response.json(
        { login: identity.login },
        identity.scopes ? { headers: { "X-OAuth-Scopes": identity.scopes } } : {},
      );
    },
  );
  const env = {
    ...process.env,
    PATH: [launcherDir, otherLauncher, bin, process.env.PATH ?? ""].join(Path.delimiter),
    GH_TOKEN: "ambient-token",
    GITHUB_TOKEN: "ambient-token",
    GH_HOST: "elsewhere.example.com",
    GH_CONFIG_DIR: Path.join(stateDir, "github"),
    FAKE_GH_LOG: log,
    FAKE_GH_STATUS: JSON.stringify(STATUS),
    FAKE_GH_TOKENS: JSON.stringify(tokens),
  };
  const importer = new GithubCliImport({
    account,
    f5StateRoots: [stateDir],
    launcherDir,
    env,
  });
  const calls = async () =>
    (await FS.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            GH_CONFIG_DIR: string | null;
            tokens: string[];
            prompt: string | null;
          },
      );
  return { root, stateDir, bin, launcherDir, env, account, importer, calls, secrets };
}

describe("parseGhAuthStatus", () => {
  it("keeps healthy accounts on valid hosts and computes missing scopes", () => {
    expect(parseGhAuthStatus(JSON.stringify(STATUS))).toEqual([
      {
        host: "github.com",
        login: "octocat",
        active: true,
        tokenSource: "keyring",
        scopes: ["gist", "read:org", "read:project", "repo", "workflow"],
        missingScopes: ["notifications"],
      },
      {
        host: "github.com",
        login: "work-bot",
        active: false,
        tokenSource: "keyring",
        scopes: ["repo", "admin:org", "notifications"],
        missingScopes: [],
      },
      {
        host: "ghe.example.com",
        login: "alice_corp",
        active: true,
        tokenSource: "oauth_token",
        scopes: ["repo", "read:org", "notifications"],
        missingScopes: [],
      },
    ]);
  });

  it("handles output without hosts", () => {
    expect(parseGhAuthStatus("{}")).toEqual([]);
    expect(missingGithubScopes([])).toEqual(["repo", "read:org", "notifications"]);
  });
});

describe("workstationGhEnvironment", () => {
  it("drops token overrides and F5 profile config dirs but keeps a user's own config dir", () => {
    const roots = ["/home/me/.f5"];
    const stripped = workstationGhEnvironment(
      {
        PATH: "/usr/bin",
        GH_TOKEN: "a",
        github_token: "b",
        GH_ENTERPRISE_TOKEN: "c",
        GITHUB_ENTERPRISE_TOKEN: "d",
        GH_HOST: "x",
        GH_CONFIG_DIR: "/home/me/.f5/userdata-profiles/abc/github",
      },
      roots,
    );
    expect(stripped).toEqual({
      PATH: "/usr/bin",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    });
    expect(
      workstationGhEnvironment({ GH_CONFIG_DIR: "/home/me/dotfiles/gh" }, roots).GH_CONFIG_DIR,
    ).toBe("/home/me/dotfiles/gh");
    // Only F5's `<stateDir>/github` projection is recognized inside an F5 root.
    expect(
      workstationGhEnvironment({ GH_CONFIG_DIR: "/home/me/.f5/custom-gh" }, roots).GH_CONFIG_DIR,
    ).toBe("/home/me/.f5/custom-gh");
  });
});

describe.skipIf(process.platform === "win32")("GithubCliImport", () => {
  it("finds the real gh behind F5 launchers and lists accounts without tokens", async () => {
    const { importer, env, launcherDir, bin, calls, stateDir } = await setup();
    expect(resolveWorkstationGh(env, launcherDir)).toBe(Path.join(bin, "gh"));
    const result = await importer.candidates();
    expect(result.ghAvailable).toBe(true);
    expect(result.accounts.map((account) => `${account.login}@${account.host}`)).toEqual([
      "octocat@github.com",
      "work-bot@github.com",
      "alice_corp@ghe.example.com",
    ]);
    const [call] = await calls();
    expect(call!.args).toEqual(["auth", "status", "--json", "hosts"]);
    expect(call!.tokens).toEqual([]);
    expect(call!.GH_CONFIG_DIR).toBeNull();
    expect(call!.prompt).toBe("1");
    expect(JSON.stringify(result)).not.toContain(stateDir);
  });

  it("imports the chosen account through the profile store without returning the token", async () => {
    const { importer, account, calls } = await setup({
      "github.com/work-bot": "gho_bot",
      "ghe.example.com/alice_corp": "gho_alice",
    });
    const result = await importer.import({ host: "github.com", login: "work-bot" });
    expect(result).toEqual({ login: "work-bot", missingScopes: [] });
    expect(JSON.stringify(result)).not.toContain("gho_");
    expect(await account.token("github.com")).toBe("gho_bot");
    expect((await calls()).at(-1)!.args).toEqual([
      "auth",
      "token",
      "--hostname",
      "github.com",
      "--user",
      "work-bot",
    ]);
    const enterprise = await importer.import({ host: "ghe.example.com", login: "alice_corp" });
    expect(enterprise.login).toBe("alice_corp");
    expect(await account.token("ghe.example.com")).toBe("gho_alice");
  });

  it("reports missing scopes from the token GitHub actually sees", async () => {
    const { importer } = await setup({ "github.com/octocat": "gho_octo" });
    expect(await importer.import({ host: "github.com", login: "octocat" })).toEqual({
      login: "octocat",
      missingScopes: ["notifications"],
    });
  });

  it("rejects a token for a different account without replacing an existing connection", async () => {
    const { importer, account } = await setup({ "github.com/octocat": "gho_someone_else" });
    await account.set("github.com", "gho_bot");
    await expect(importer.import({ host: "github.com", login: "octocat" })).rejects.toThrow(
      "different account",
    );
    expect(await account.token("github.com")).toBe("gho_bot");
  });

  it("rejects missing logins and placeholder tokens with generic errors", async () => {
    const { importer, account } = await setup({ "github.com/octocat": "f5-profile-not-connected" });
    const placeholder = importer.import({ host: "github.com", login: "octocat" });
    await expect(placeholder).rejects.toThrow("no usable login");
    const missing = importer.import({ host: "github.com", login: "nobody" });
    await expect(missing).rejects.toThrow("no usable login");
    await expect(missing).rejects.not.toThrow("no oauth token");
    expect(await account.token("github.com")).toBeNull();
    await expect(importer.import({ host: "Bad Host", login: "octocat" })).rejects.toThrow(
      "Invalid GitHub hostname",
    );
    await expect(importer.import({ host: "github.com", login: "-bad" })).rejects.toThrow(
      "Invalid GitHub account",
    );
  });

  it("reports gh as unavailable when only F5 launchers are on PATH", async () => {
    const { account, stateDir, launcherDir } = await setup();
    const importer = new GithubCliImport({
      account,
      f5StateRoots: [stateDir],
      launcherDir,
      env: { PATH: launcherDir },
    });
    expect(await importer.candidates()).toEqual({ ghAvailable: false, accounts: [] });
    await expect(importer.import({ host: "github.com", login: "octocat" })).rejects.toThrow(
      "isn't installed",
    );
  });
});
