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
    if (process.platform !== "win32") {
      expect((await FS.stat(Path.join(work.stateDir, "github"))).mode & 0o777).toBe(0o700);
      expect((await FS.stat(Path.join(work.stateDir, "github", "hosts.yml"))).mode & 0o777).toBe(
        0o600,
      );
    }
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
